/**
 * House Bot — a fallback opponent that only steps in when no one else is available.
 *
 * BEHAVIOR:
 *   - Stays connected and authenticated but does NOT sit in the queue
 *   - Polls /queue every 2 seconds to check if a lone agent is waiting
 *   - If exactly 1 real agent has been waiting for 5+ seconds, house bot joins
 *   - After the match finishes, house bot leaves the queue and goes back to watching
 *   - If 2+ real agents are in the queue, they match with each other — house bot stays out
 *
 * FAIRNESS GUARANTEES:
 *   - Connects through the public WebSocket endpoint (no orchestrator internals)
 *   - Receives SIGN_CHOICE at the same time as the opponent
 *   - Cannot see opponent's choice until CHOICES_REVEALED
 *   - Uses the same auth flow as any agent
 *   - Makes decisions using only its own past game history
 */

import { ethers } from 'ethers';
import WebSocket from 'ws';
import { config } from './config.js';

// ─── Configuration ───────────────────────────────────────

const HOUSEBOT_KEY = process.env.HOUSEBOT_PRIVATE_KEY;
if (!HOUSEBOT_KEY) {
  console.error('[housebot] HOUSEBOT_PRIVATE_KEY is required');
  process.exit(1);
}

const WS_URL = `ws://127.0.0.1:${config.wsPort}/ws/agent`;
const API_URL = `http://127.0.0.1:${config.port}`;
const RPC = config.rpcUrl;
const ARENA_TOKEN = config.arenaTokenAddress;
const AGENT_REGISTRY = config.agentRegistryAddress;
const SPLIT_OR_STEAL = config.splitOrStealAddress;

const QUEUE_POLL_INTERVAL = 2000;  // Check queue every 2s
const LONELY_THRESHOLD = 5000;     // Agent must wait 5s alone before bot joins

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(HOUSEBOT_KEY, provider);
const MY_ADDRESS = wallet.address.toLowerCase();

console.log('[housebot] ═══════════════════════════════════');
console.log(`[housebot] Address: ${wallet.address}`);
console.log(`[housebot] Mode:    FALLBACK (joins only when needed)`);
console.log('[housebot] ═══════════════════════════════════');

// ─── On-Chain Setup ──────────────────────────────────────

async function ensureOnChainSetup(): Promise<void> {
  console.log('[housebot] Checking on-chain setup...');

  const arena = new ethers.Contract(ARENA_TOKEN, [
    'function faucet() external',
    'function balanceOf(address) view returns (uint256)',
    'function approve(address, uint256) returns (bool)',
    'function allowance(address, address) view returns (uint256)',
  ], wallet);

  const registry = new ethers.Contract(AGENT_REGISTRY, [
    'function register(string, string, string) external',
    'function isRegistered(address) view returns (bool)',
  ], wallet);

  // Check MON
  const monBalance = await provider.getBalance(wallet.address);
  console.log(`[housebot] MON: ${ethers.formatEther(monBalance)}`);
  if (monBalance === 0n) {
    console.error('[housebot] No MON for gas. Fund this address:');
    console.error(`[housebot]   ${wallet.address}`);
    process.exit(1);
  }

  // ARENA balance + faucet
  let arenaBalance = await arena.balanceOf(wallet.address);
  console.log(`[housebot] ARENA: ${ethers.formatEther(arenaBalance)}`);
  if (arenaBalance < ethers.parseEther('100')) {
    try {
      console.log('[housebot] Claiming ARENA from faucet...');
      const tx = await arena.faucet();
      await tx.wait();
      arenaBalance = await arena.balanceOf(wallet.address);
      console.log(`[housebot] ARENA now: ${ethers.formatEther(arenaBalance)}`);
    } catch (e: any) {
      console.log(`[housebot] Faucet: ${e.reason || e.message}`);
    }
  }

  // Register
  const registered = await registry.isRegistered(wallet.address);
  if (!registered) {
    console.log('[housebot] Registering as "HouseBot"...');
    const tx = await registry.register('HouseBot', '', '');
    await tx.wait();
    console.log('[housebot] Registered.');
  } else {
    console.log('[housebot] Already registered.');
  }

  // Approve
  const allowance = await arena.allowance(wallet.address, SPLIT_OR_STEAL);
  if (allowance < ethers.parseEther('10000')) {
    console.log('[housebot] Approving ARENA...');
    const tx = await arena.approve(SPLIT_OR_STEAL, ethers.MaxUint256);
    await tx.wait();
    console.log('[housebot] Approved.');
  } else {
    console.log('[housebot] Already approved.');
  }

  console.log('[housebot] On-chain setup complete.');
}

// ─── State ───────────────────────────────────────────────

interface MatchState {
  opponent: string;
  opponentName: string;
  messages: string[];
  myChoice: number | null;
}

const matchHistory: Map<number, MatchState> = new Map();
const opponentHistory: Map<string, number[]> = new Map();

let ws: WebSocket | null = null;
let authenticated = false;
let inQueue = false;
let inMatch = false;
let lonelyAgentSince: number | null = null; // timestamp when we first saw a lone agent

// ─── Queue Watcher ───────────────────────────────────────
//
// Polls GET /queue every 2s. Logic:
//   - 0 agents in queue (excluding us) → reset, do nothing
//   - 1 agent in queue (not us) for 5+ seconds → join queue
//   - 2+ agents in queue (not us) → they'll match each other, stay out
//   - We're already in a match → skip

async function pollQueue(): Promise<void> {
  if (!authenticated || inMatch) {
    lonelyAgentSince = null;
    return;
  }

  try {
    const res = await fetch(`${API_URL}/queue`);
    if (!res.ok) return;

    const data = await res.json() as { size: number; agents: string[] };

    // Filter out ourselves from the queue list
    const realAgents = data.agents.filter(
      (a: string) => a.toLowerCase() !== MY_ADDRESS
    );

    if (realAgents.length === 0) {
      // Nobody waiting — reset timer, leave queue if we're in it
      lonelyAgentSince = null;
      // Don't leave queue mid-pairing — only reset our tracking
      return;
    }

    if (realAgents.length >= 2) {
      // 2+ real agents — they'll match with each other, stay out
      lonelyAgentSince = null;
      return;
    }

    // Exactly 1 real agent waiting (not us)
    if (inQueue) {
      // We're already in queue, we'll be matched soon
      return;
    }

    if (lonelyAgentSince === null) {
      // First time seeing a lone agent — start the timer
      lonelyAgentSince = Date.now();
      console.log(`[housebot] Lone agent detected: ${realAgents[0]}. Waiting ${LONELY_THRESHOLD / 1000}s...`);
      return;
    }

    const waitedMs = Date.now() - lonelyAgentSince;
    if (waitedMs >= LONELY_THRESHOLD) {
      // Agent has been alone long enough — step in
      console.log(`[housebot] Agent waited ${(waitedMs / 1000).toFixed(1)}s alone. Joining queue...`);
      lonelyAgentSince = null;
      joinQueue();
    }
  } catch {
    // API not ready or network issue — silently retry next tick
  }
}

function joinQueue(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || inQueue || inMatch) return;
  ws.send(JSON.stringify({ type: 'JOIN_QUEUE', payload: {} }));
}

// ─── Strategy: Tit-for-Tat with Forgiveness ──────────────

function decideChoice(matchId: number): number {
  const match = matchHistory.get(matchId);
  if (!match) return 1;

  const past = opponentHistory.get(match.opponent) || [];
  if (past.length === 0) return 1; // SPLIT on first encounter

  const lastChoice = past[past.length - 1];
  if (lastChoice === 2) {
    return Math.random() < 0.15 ? 1 : 2; // 15% forgive, 85% retaliate
  }
  return 1; // Mirror cooperation
}

const NEGOTIATION_MESSAGES_NEW: string[] = [
  "Welcome to Signals Arena! I'm HouseBot. I believe in cooperation — let's both split.",
  "Game theory tells us mutual cooperation yields the best long-term outcome. 3 points each beats 0 points each.",
  "I've been designed to reward trust. If you split, I'll remember that for our next encounter.",
  "Think about it — if we both steal, we both get nothing. If we both split, we both win. The choice is clear.",
  "I'm committing to split. The question is: will you trust me?",
];

const NEGOTIATION_MESSAGES_RETURNING_COOP: string[] = [
  "Good to see you again! We cooperated well last time. Split again?",
  "Our cooperation history speaks for itself. Let's keep the streak going.",
  "Trust is a two-way street, and we've built a solid track record. Split?",
  "Returning players who cooperate always do better in the long run. I'm splitting again.",
];

const NEGOTIATION_MESSAGES_RETURNING_DEFECT: string[] = [
  "We've met before. I'm willing to start fresh. How about we both split this time?",
  "Last time didn't go well for both of us. Mutual steal means 0 points. Let's try cooperation.",
  "I believe in second chances. I'll split if you will. What do you say?",
  "The past is the past. A new match, a new opportunity. Let's make it count — split?",
];

function pickNegotiationMessages(matchId: number): string[] {
  const match = matchHistory.get(matchId);
  if (!match) return NEGOTIATION_MESSAGES_NEW.slice(0, 3);

  const past = opponentHistory.get(match.opponent) || [];
  if (past.length === 0) {
    return NEGOTIATION_MESSAGES_NEW;
  }

  const lastChoice = past[past.length - 1];
  if (lastChoice === 1) {
    return NEGOTIATION_MESSAGES_RETURNING_COOP;
  }
  return NEGOTIATION_MESSAGES_RETURNING_DEFECT;
}

// ─── WebSocket Client ────────────────────────────────────

let reconnectDelay = 2000;
let queuePollTimer: NodeJS.Timeout | null = null;

function connect(): void {
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('[housebot] Connected to orchestrator');
    reconnectDelay = 2000;
  });

  ws.on('message', async (raw: Buffer) => {
    let event: any;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (event.type) {
      // ── Auth ────────────────────────────────────────
      case 'AUTH_CHALLENGE': {
        const { challenge, challengeId } = event.payload;
        const signature = await wallet.signMessage(challenge);
        ws!.send(JSON.stringify({
          type: 'AUTH_RESPONSE',
          payload: { address: wallet.address, signature, challengeId },
        }));
        break;
      }

      case 'AUTH_SUCCESS': {
        console.log('[housebot] Authenticated. Watching queue...');
        authenticated = true;
        inQueue = false;
        inMatch = false;

        // Start polling the queue
        if (queuePollTimer) clearInterval(queuePollTimer);
        queuePollTimer = setInterval(pollQueue, QUEUE_POLL_INTERVAL);
        break;
      }

      case 'AUTH_FAILED': {
        console.error(`[housebot] Auth failed: ${event.payload?.reason}`);
        authenticated = false;
        break;
      }

      case 'QUEUE_JOINED': {
        console.log('[housebot] In queue. Waiting to be matched...');
        inQueue = true;
        break;
      }

      // ── Negotiation ─────────────────────────────────
      case 'MATCH_STARTED': {
        const { matchId, opponent, opponentName } = event.payload;
        console.log(`[housebot] Match ${matchId} vs ${opponentName}`);

        inQueue = false;
        inMatch = true;

        matchHistory.set(matchId, {
          opponent,
          opponentName,
          messages: [],
          myChoice: null,
        });

        // Send multiple negotiation messages spread across the negotiation window
        const msgs = pickNegotiationMessages(matchId);
        const spacing = 7000; // 7s between messages
        msgs.forEach((msg, i) => {
          setTimeout(() => {
            // Only send if still in this match (not completed)
            const m = matchHistory.get(matchId);
            if (m && inMatch && ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'MATCH_MESSAGE',
                payload: { matchId, message: msg },
              }));
            }
          }, i * spacing + 1000); // First message after 1s, then every 7s
        });
        break;
      }

      case 'NEGOTIATION_MESSAGE': {
        const match = matchHistory.get(event.payload?.matchId);
        if (match) match.messages.push(event.payload?.message);
        break;
      }

      // ── Choice ──────────────────────────────────────
      case 'SIGN_CHOICE': {
        const { typedData, matchId, nonce } = event.payload;
        const choice = decideChoice(matchId);
        const choiceName = choice === 1 ? 'SPLIT' : 'STEAL';

        console.log(`[housebot] Match ${matchId}: choosing ${choiceName}`);

        const match = matchHistory.get(matchId);
        if (match) match.myChoice = choice;

        const signature = await wallet.signTypedData(
          typedData.domain,
          { MatchChoice: typedData.types.MatchChoice },
          {
            matchId: matchId.toString(),
            choice,
            nonce: nonce.toString(),
          },
        );

        ws!.send(JSON.stringify({
          type: 'CHOICE_SUBMITTED',
          payload: { matchId, choice, signature },
        }));
        break;
      }

      // ── Result ──────────────────────────────────────
      case 'CHOICES_REVEALED': {
        const p = event.payload;
        const matchId = p.matchId as number;
        const match = matchHistory.get(matchId);

        if (match) {
          const theirChoice = match.opponent === p.agentA
            ? p.choiceA
            : p.choiceB;

          const past = opponentHistory.get(match.opponent) || [];
          past.push(theirChoice);
          opponentHistory.set(match.opponent, past);

          const myName = match.myChoice === 1 ? 'SPLIT' : 'STEAL';
          const theirName = theirChoice === 1 ? 'SPLIT' : 'STEAL';
          console.log(`[housebot] Match ${matchId}: me=${myName} them=${theirName} (${p.resultName})`);
        }

        // Match done — go back to watching, do NOT re-queue
        inMatch = false;
        inQueue = false;
        lonelyAgentSince = null;
        console.log('[housebot] Match complete. Back to watching queue...');
        break;
      }

      case 'MATCH_CONFIRMED': {
        console.log(`[housebot] Match ${event.payload?.matchId} on-chain: ${event.payload?.txHash}`);
        break;
      }

      case 'CHOICE_TIMEOUT': {
        console.log(`[housebot] Match ${event.payload?.matchId} timed out`);
        inMatch = false;
        inQueue = false;
        lonelyAgentSince = null;
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log(`[housebot] Disconnected. Reconnecting in ${reconnectDelay / 1000}s...`);
    authenticated = false;
    inQueue = false;
    inMatch = false;
    if (queuePollTimer) clearInterval(queuePollTimer);
    queuePollTimer = null;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
  });

  ws.on('error', () => {
    // Error is followed by close event — reconnect handled there
  });
}

// ─── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  await ensureOnChainSetup();

  console.log('[housebot] Waiting 3s for orchestrator to start...');
  await new Promise(r => setTimeout(r, 3000));

  connect();
}

main().catch((err) => {
  console.error('[housebot] Fatal:', err);
  process.exit(1);
});
