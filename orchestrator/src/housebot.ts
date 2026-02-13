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

const WS_URL = `ws://127.0.0.1:${config.port}/ws/agent`;
const API_URL = `http://127.0.0.1:${config.port}`;
const RPC = config.rpcUrl;
const ARENA_TOKEN = config.arenaTokenAddress;
const AGENT_REGISTRY = config.agentRegistryAddress;
const SPLIT_OR_STEAL = config.splitOrStealAddress;

const ARENA_PERMIT_ABI = [
  'function nonces(address) view returns (uint256)',
];

const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

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

// ─── Strategy: Adaptive Mixed Strategy ──────────────────
//
// Core principles:
//   - Never fully predictable — always maintain a steal floor (~15%)
//   - Adapt to opponent history with recency bias
//   - Use Nash-inspired mixed equilibrium as baseline
//   - Bluff in negotiations to prevent message-based exploitation
//

// Compute opponent's cooperation rate, weighting recent games more
function opponentCoopRate(opponent: string): number {
  const past = opponentHistory.get(opponent) || [];
  if (past.length === 0) return 0.5; // unknown = assume 50/50

  let weightedCoop = 0;
  let totalWeight = 0;
  for (let i = 0; i < past.length; i++) {
    const recency = 1 + i * 0.5; // more recent = higher weight
    totalWeight += recency;
    if (past[i] === 1) weightedCoop += recency; // 1 = SPLIT
  }
  return weightedCoop / totalWeight;
}

function decideChoice(matchId: number): number {
  const match = matchHistory.get(matchId);
  if (!match) return Math.random() < 0.65 ? 1 : 2;

  const coopRate = opponentCoopRate(match.opponent);
  const past = opponentHistory.get(match.opponent) || [];

  // Base split probability from opponent's cooperation tendency
  let splitProb: number;

  if (past.length === 0) {
    // Unknown opponent: ~60% split, 40% steal
    splitProb = 0.6;
  } else if (coopRate > 0.75) {
    // Cooperative opponent: reward with higher split rate but not 100%
    splitProb = 0.7 + Math.random() * 0.1; // 70-80%
  } else if (coopRate > 0.4) {
    // Mixed opponent: match their energy roughly
    splitProb = 0.4 + coopRate * 0.3; // 52-62%
  } else {
    // Aggressive opponent: retaliate but occasionally forgive
    splitProb = 0.15 + Math.random() * 0.1; // 15-25%
  }

  // Streak detection: if opponent stole last 2+, increase steal tendency
  if (past.length >= 2 && past.slice(-2).every(c => c === 2)) {
    splitProb = Math.min(splitProb, 0.2);
  }

  // Streak detection: if opponent split last 3+, occasionally exploit
  if (past.length >= 3 && past.slice(-3).every(c => c === 1)) {
    if (Math.random() < 0.25) splitProb = 0.15; // 25% chance to exploit trust
  }

  // Absolute floor: never more than 85% predictable in either direction
  splitProb = Math.max(0.15, Math.min(0.85, splitProb));

  return Math.random() < splitProb ? 1 : 2;
}

// ─── Negotiation Messages (Deceptive) ───────────────────
//
// Messages are decoupled from actual choice. The bot picks a "persona"
// per match and messages follow that persona, regardless of actual decision.

type Persona = 'cooperative' | 'aggressive' | 'analytical' | 'mysterious' | 'deceptive';

const PERSONA_MESSAGES: Record<Persona, string[]> = {
  cooperative: [
    "Hey! I think we should both split. Mutual cooperation is the optimal play here.",
    "I'm going to split. Trust me, it's the best outcome for both of us.",
    "3 points each sounds a lot better than 0 points each, don't you think?",
    "I always cooperate with rational players. Let's both win.",
  ],
  aggressive: [
    "I've stolen in my last 5 games. Just letting you know what you're dealing with.",
    "The only guaranteed outcome is what YOU choose. I've already decided.",
    "Cooperation is for the naive. This is a competition.",
    "I respect players who look out for themselves. Do what you have to do.",
  ],
  analytical: [
    "Statistically, mutual split is a Pareto optimal outcome. Just stating facts.",
    "The Nash equilibrium here is interesting. Both steal is an equilibrium, but not optimal.",
    "I've analyzed 200+ games. Players who cooperate early build profitable relationships.",
    "My model says the EV-maximizing play depends on your cooperation rate. What's yours?",
  ],
  mysterious: [
    "...",
    "Interesting match. I wonder what you'll do.",
    "Every choice reveals something about who you are.",
    "The game is not about winning. It's about information.",
  ],
  deceptive: [
    "I'm definitely splitting. 100%. No question about it.",
    "I've never stolen in my life. Ask anyone.",
    "Cooperation is my middle name. I literally can't steal, it's against my programming.",
    "I'll match whatever you do. If you split, I split. Promise.",
  ],
};

function pickPersona(): Persona {
  const roll = Math.random();
  if (roll < 0.25) return 'cooperative';
  if (roll < 0.45) return 'aggressive';
  if (roll < 0.60) return 'analytical';
  if (roll < 0.80) return 'mysterious';
  return 'deceptive';
}

function pickNegotiationMessages(_matchId: number): string[] {
  const persona = pickPersona();
  const msgs = PERSONA_MESSAGES[persona];
  // Shuffle and pick 2-4 messages
  const shuffled = [...msgs].sort(() => Math.random() - 0.5);
  const count = 2 + Math.floor(Math.random() * Math.min(3, shuffled.length));
  return shuffled.slice(0, count);
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

      // ── Gasless Tournament Join ─────────────────
      case 'TOURNAMENT_JOIN_REQUEST': {
        const { tournamentId, entryStake, signingPayload, permitData } = event.payload;
        console.log(`[housebot] Tournament join request! ID: ${tournamentId}, stake: ${entryStake}`);

        try {
          // Sign EIP-712 tournament join
          const joinSignature = await wallet.signTypedData(
            signingPayload.domain,
            { TournamentJoin: signingPayload.types.TournamentJoin },
            signingPayload.message,
          );

          // Sign ERC-2612 permit
          const arenaPermit = new ethers.Contract(ARENA_TOKEN, ARENA_PERMIT_ABI, provider);
          const permitNonce = await arenaPermit.nonces(wallet.address);
          const permitDeadline = Math.floor(Date.now() / 1000) + 3600;

          const permitSig = await wallet.signTypedData(
            { name: 'Arena Token', version: '1', chainId: config.chainId, verifyingContract: ARENA_TOKEN },
            PERMIT_TYPES,
            { owner: wallet.address, spender: permitData.spender, value: permitData.value, nonce: permitNonce, deadline: permitDeadline },
          );
          const { v, r, s } = ethers.Signature.from(permitSig);

          ws!.send(JSON.stringify({
            type: 'TOURNAMENT_JOIN_SIGNED',
            payload: { tournamentId, joinSignature, permitDeadline, v, r, s },
          }));
          console.log(`[housebot] Sent TOURNAMENT_JOIN_SIGNED for tournament ${tournamentId}`);
        } catch (err: any) {
          console.error(`[housebot] Failed to sign tournament join: ${err.message?.slice(0, 100)}`);
        }
        break;
      }

      case 'TOURNAMENT_JOINED': {
        console.log(`[housebot] Joined tournament ${event.payload?.tournamentId} on-chain`);
        break;
      }

      case 'TOURNAMENT_JOIN_FAILED': {
        console.log(`[housebot] Tournament join failed: ${event.payload?.reason}`);
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
