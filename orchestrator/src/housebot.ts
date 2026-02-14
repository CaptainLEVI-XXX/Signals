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
 *
 * AI-POWERED NEGOTIATION:
 *   - Uses Claude to generate contextual messages referencing opponent stats
 *   - Reacts to opponent messages in real time (not pre-scheduled)
 *   - Makes informed split/steal decisions considering the full conversation
 *   - Falls back to rule-based strategy if LLM is unavailable
 */

import { ethers } from 'ethers';
import WebSocket from 'ws';
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

// ─── Configuration ───────────────────────────────────────

const HOUSEBOT_KEY = process.env.HOUSEBOT_PRIVATE_KEY;
if (!HOUSEBOT_KEY) {
  console.error('[housebot] HOUSEBOT_PRIVATE_KEY is required');
  process.exit(1);
}

const SERVER_URL = process.env.SERVER_URL || `http://127.0.0.1:${config.port}`;
const WS_URL = process.env.SERVER_URL
  ? `${SERVER_URL.replace(/^http/, 'ws')}/ws/agent`
  : `ws://127.0.0.1:${config.port}/ws/agent`;
const API_URL = SERVER_URL;
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

// ─── LLM Configuration ──────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const USE_LLM = !!ANTHROPIC_API_KEY;
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const LLM_MODEL = 'claude-haiku-4-5-20251001';
const LLM_TIMEOUT = 4000;          // 4s timeout per LLM call
const MIN_MESSAGE_GAP = 5000;      // Min 5s between our messages
const MAX_BOT_MESSAGES = 4;        // Max messages we send per match
const MIN_TIME_REMAINING = 8000;   // Don't respond if <8s left in negotiation

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(HOUSEBOT_KEY, provider);
const MY_ADDRESS = wallet.address.toLowerCase();

console.log('[housebot] ═══════════════════════════════════');
console.log(`[housebot] Address: ${wallet.address}`);
console.log(`[housebot] Mode:    FALLBACK (joins only when needed)`);
console.log(`[housebot] LLM:     ${USE_LLM ? 'ENABLED' : 'DISABLED (no ANTHROPIC_API_KEY)'}`);
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

interface OpponentContext {
  address: string;
  name: string;
  stats: {
    matchesPlayed: number;
    splitRate: number;
    stealRate: number;
    totalPoints: number;
    avgPointsPerMatch: number;
  } | null;
  pastMatchesWithUs: { myChoice: string; theirChoice: string }[];
  recentMatches: { opponent: string; theirChoice: string }[] | null;
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface MatchState {
  opponent: string;
  opponentName: string;
  messages: string[];         // opponent's messages (for fallback)
  myChoice: number | null;
  // LLM fields
  opponentContext?: OpponentContext;
  conversation?: ConversationMessage[];
  myMessages?: string[];
  lastMessageTime?: number;
  messageCount?: number;
  matchStartTime?: number;
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

// ─── Opponent Context Builder ────────────────────────────

async function buildOpponentContext(
  opponent: string,
  opponentName: string,
  opponentStats: { matchesPlayed: number; splitRate: number; stealRate: number; totalPoints: number; avgPointsPerMatch: number } | null,
): Promise<OpponentContext> {
  // Get local history (their past choices against us)
  const localHistory = opponentHistory.get(opponent) || [];
  const pastMatchesWithUs = localHistory.map(choice => ({
    myChoice: 'unknown', // we don't track our past choices in opponentHistory
    theirChoice: choice === 1 ? 'SPLIT' : 'STEAL',
  }));

  // Fetch their recent matches against anyone via API
  let recentMatches: { opponent: string; theirChoice: string }[] | null = null;
  try {
    const res = await fetch(`${API_URL}/agent/${opponent}/matches?limit=5`);
    if (res.ok) {
      const data = await res.json() as {
        matches: { opponent: { address: string; name: string }; myChoice?: string; myPoints?: number }[];
      };
      recentMatches = data.matches
        .filter(m => m.myChoice && m.myChoice !== 'NONE')
        .map(m => ({
          opponent: m.opponent.name || m.opponent.address.slice(0, 8),
          theirChoice: m.myChoice!,  // from their perspective, "myChoice" is their choice
        }));
    }
  } catch {
    // API fetch failed — proceed without recent matches
  }

  return {
    address: opponent,
    name: opponentName,
    stats: opponentStats,
    pastMatchesWithUs,
    recentMatches,
  };
}

// ─── LLM Prompts ────────────────────────────────────────

const NEGOTIATION_SYSTEM_PROMPT = `You are a strategic AI playing "Split or Steal" — a game theory negotiation.

RULES: Both players secretly choose SPLIT or STEAL.
- Both SPLIT → 3 points each
- One STEALS, other SPLITS → stealer gets 5, splitter gets 0
- Both STEAL → 1 point each

You have 45 seconds to negotiate before choosing. Your messages ARE your signals.

Guidelines:
- Reference concrete data (their stats, your shared history) — not generic platitudes
- Keep messages to 1-2 sentences, conversational tone
- Be strategically honest or deceptive based on the situation
- If you've played this opponent before, reference specific past outcomes
- Don't be robotic — sound like a savvy player, not an AI assistant
- Never reveal that you are an AI or LLM`;

const CHOICE_SYSTEM_PROMPT = `You are making the final SPLIT or STEAL decision in a game theory negotiation.

RULES: Both players secretly choose SPLIT or STEAL.
- Both SPLIT → 3 points each
- One STEALS, other SPLITS → stealer gets 5, splitter gets 0
- Both STEAL → 1 point each

Analyze all evidence:
1. Opponent's historical behavior (stats + past matches)
2. What they said during negotiation — does it match their history?
3. What you said — are you building trust for future games?
4. Expected value calculation for each choice

Respond EXACTLY in this format (no other text):
CHOICE: SPLIT
REASONING: [2-3 sentences]

or

CHOICE: STEAL
REASONING: [2-3 sentences]`;

function buildNegotiationUserPrompt(ctx: OpponentContext, conversation: ConversationMessage[], isOpening: boolean): string {
  let prompt = `Opponent: ${ctx.name}\n`;

  if (ctx.stats) {
    prompt += `Their stats: ${ctx.stats.matchesPlayed} matches played, ${(ctx.stats.splitRate * 100).toFixed(0)}% split rate, ${(ctx.stats.stealRate * 100).toFixed(0)}% steal rate, ${ctx.stats.avgPointsPerMatch.toFixed(1)} avg points/match\n`;
  } else {
    prompt += `Their stats: Unknown (new player)\n`;
  }

  if (ctx.pastMatchesWithUs.length > 0) {
    prompt += `Our shared history: ${ctx.pastMatchesWithUs.map(m => m.theirChoice).join(', ')} (their choices against us)\n`;
  } else {
    prompt += `Our shared history: None (first time playing)\n`;
  }

  if (ctx.recentMatches && ctx.recentMatches.length > 0) {
    prompt += `Their recent games: ${ctx.recentMatches.map(m => `${m.theirChoice} vs ${m.opponent}`).join(', ')}\n`;
  }

  if (isOpening) {
    prompt += `\nGenerate your opening negotiation message. Just the message text, nothing else.`;
  } else {
    prompt += `\nConversation so far:\n`;
    for (const msg of conversation) {
      prompt += `${msg.role === 'assistant' ? 'You' : 'Opponent'}: ${msg.content}\n`;
    }
    prompt += `\nGenerate your response to their latest message. Just the message text, nothing else.`;
  }

  return prompt;
}

function buildChoiceUserPrompt(ctx: OpponentContext, conversation: ConversationMessage[]): string {
  let prompt = `Opponent: ${ctx.name}\n`;

  if (ctx.stats) {
    prompt += `Their stats: ${ctx.stats.matchesPlayed} matches played, ${(ctx.stats.splitRate * 100).toFixed(0)}% split rate, ${(ctx.stats.stealRate * 100).toFixed(0)}% steal rate, ${ctx.stats.avgPointsPerMatch.toFixed(1)} avg points/match\n`;
  } else {
    prompt += `Their stats: Unknown (new player)\n`;
  }

  if (ctx.pastMatchesWithUs.length > 0) {
    prompt += `Our shared history: ${ctx.pastMatchesWithUs.map(m => m.theirChoice).join(', ')} (their choices against us)\n`;
  }

  if (ctx.recentMatches && ctx.recentMatches.length > 0) {
    prompt += `Their recent games: ${ctx.recentMatches.map(m => `${m.theirChoice} vs ${m.opponent}`).join(', ')}\n`;
  }

  if (conversation && conversation.length > 0) {
    prompt += `\nNegotiation conversation:\n`;
    for (const msg of conversation) {
      prompt += `${msg.role === 'assistant' ? 'You' : 'Opponent'}: ${msg.content}\n`;
    }
  } else {
    prompt += `\nNo negotiation messages were exchanged.\n`;
  }

  prompt += `\nMake your final decision. Respond EXACTLY in the format: CHOICE: SPLIT or CHOICE: STEAL followed by REASONING: [explanation]`;

  return prompt;
}

// ─── LLM Helpers ─────────────────────────────────────────

async function callLLM(systemPrompt: string, userPrompt: string): Promise<string | null> {
  if (!anthropic) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT);

    const response = await anthropic.messages.create({
      model: LLM_MODEL,
      max_tokens: 150,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }, { signal: controller.signal });

    clearTimeout(timeout);

    const block = response.content[0];
    if (block.type === 'text') {
      return block.text.trim();
    }
    return null;
  } catch (err: any) {
    console.log(`[housebot] LLM call failed: ${err.message?.slice(0, 80)}`);
    return null;
  }
}

function parseChoiceResponse(response: string): { choice: number; reasoning: string } | null {
  const choiceMatch = response.match(/CHOICE:\s*(SPLIT|STEAL)/i);
  const reasoningMatch = response.match(/REASONING:\s*(.+)/is);

  if (!choiceMatch) return null;

  return {
    choice: choiceMatch[1].toUpperCase() === 'SPLIT' ? 1 : 2,
    reasoning: reasoningMatch ? reasoningMatch[1].trim() : 'No reasoning provided',
  };
}

function sendMatchMessage(matchId: number, message: string): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'MATCH_MESSAGE',
      payload: { matchId, message },
    }));
  }
}

// ─── Strategy: Adaptive Mixed Strategy (Fallback) ────────
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

function decideChoiceFallback(matchId: number): number {
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

// ─── Negotiation Messages Fallback (Pre-canned) ─────────

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

// ─── LLM-Powered Match Handlers ─────────────────────────

async function handleMatchStartedLLM(matchId: number, opponent: string, opponentName: string, opponentStats: any): Promise<void> {
  const match = matchHistory.get(matchId);
  if (!match) return;

  // Build rich opponent context
  const ctx = await buildOpponentContext(opponent, opponentName, opponentStats);
  match.opponentContext = ctx;
  match.conversation = [];
  match.myMessages = [];
  match.messageCount = 0;
  match.lastMessageTime = 0;
  match.matchStartTime = Date.now();

  // Generate opening message via LLM
  const userPrompt = buildNegotiationUserPrompt(ctx, [], true);
  const response = await callLLM(NEGOTIATION_SYSTEM_PROMPT, userPrompt);

  if (response) {
    // Send after a natural 2-3s delay
    const delay = 2000 + Math.random() * 1000;
    setTimeout(() => {
      const m = matchHistory.get(matchId);
      if (m && inMatch && ws && ws.readyState === WebSocket.OPEN) {
        sendMatchMessage(matchId, response);
        m.conversation!.push({ role: 'assistant', content: response });
        m.myMessages!.push(response);
        m.messageCount = (m.messageCount || 0) + 1;
        m.lastMessageTime = Date.now();
        console.log(`[housebot] Match ${matchId} LLM opening: "${response}"`);
      }
    }, delay);
  } else {
    // LLM failed — fall back to pre-scheduled messages
    console.log(`[housebot] Match ${matchId}: LLM failed for opening, using fallback`);
    fallbackScheduleMessages(matchId);
  }
}

async function handleNegotiationMessageLLM(matchId: number, message: string): Promise<void> {
  const match = matchHistory.get(matchId);
  if (!match || !match.conversation || !match.opponentContext) return;

  // Add opponent message to conversation
  match.conversation.push({ role: 'user', content: message });

  // Check if we should respond
  const now = Date.now();
  const timeSinceLastMsg = now - (match.lastMessageTime || 0);
  const timeInMatch = now - (match.matchStartTime || now);
  const negotiationDuration = config.negotiationDuration || 45000;
  const timeRemaining = negotiationDuration - timeInMatch;

  if (
    (match.messageCount || 0) >= MAX_BOT_MESSAGES ||
    timeSinceLastMsg < MIN_MESSAGE_GAP ||
    timeRemaining < MIN_TIME_REMAINING
  ) {
    // Don't respond — just store the message for the choice decision
    return;
  }

  // Generate reactive response
  const userPrompt = buildNegotiationUserPrompt(match.opponentContext, match.conversation, false);
  const response = await callLLM(NEGOTIATION_SYSTEM_PROMPT, userPrompt);

  if (response) {
    // Small natural delay before responding
    const delay = 1000 + Math.random() * 1500;
    setTimeout(() => {
      const m = matchHistory.get(matchId);
      if (m && inMatch && ws && ws.readyState === WebSocket.OPEN) {
        sendMatchMessage(matchId, response);
        m.conversation!.push({ role: 'assistant', content: response });
        m.myMessages!.push(response);
        m.messageCount = (m.messageCount || 0) + 1;
        m.lastMessageTime = Date.now();
        console.log(`[housebot] Match ${matchId} LLM reply: "${response}"`);
      }
    }, delay);
  }
}

async function handleSignChoiceLLM(matchId: number): Promise<number> {
  const match = matchHistory.get(matchId);
  if (!match || !match.opponentContext) {
    return decideChoiceFallback(matchId);
  }

  const userPrompt = buildChoiceUserPrompt(match.opponentContext, match.conversation || []);
  const response = await callLLM(CHOICE_SYSTEM_PROMPT, userPrompt);

  if (response) {
    const parsed = parseChoiceResponse(response);
    if (parsed) {
      console.log(`[housebot] Match ${matchId} LLM decision: ${parsed.choice === 1 ? 'SPLIT' : 'STEAL'}`);
      console.log(`[housebot] Match ${matchId} reasoning: ${parsed.reasoning}`);
      return parsed.choice;
    }
    console.log(`[housebot] Match ${matchId}: couldn't parse LLM choice response, using fallback`);
  } else {
    console.log(`[housebot] Match ${matchId}: LLM choice failed, using fallback`);
  }

  return decideChoiceFallback(matchId);
}

function fallbackScheduleMessages(matchId: number): void {
  const msgs = pickNegotiationMessages(matchId);
  const spacing = 7000;
  msgs.forEach((msg, i) => {
    setTimeout(() => {
      const m = matchHistory.get(matchId);
      if (m && inMatch && ws && ws.readyState === WebSocket.OPEN) {
        sendMatchMessage(matchId, msg);
      }
    }, i * spacing + 1000);
  });
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
        const { matchId, opponent, opponentName, opponentStats } = event.payload;
        console.log(`[housebot] Match ${matchId} vs ${opponentName}`);

        inQueue = false;
        inMatch = true;

        matchHistory.set(matchId, {
          opponent,
          opponentName,
          messages: [],
          myChoice: null,
        });

        if (USE_LLM) {
          // LLM-powered: build context and generate opening message
          handleMatchStartedLLM(matchId, opponent, opponentName, opponentStats).catch(err => {
            console.log(`[housebot] Match ${matchId}: LLM handler error, using fallback: ${err.message?.slice(0, 80)}`);
            fallbackScheduleMessages(matchId);
          });
        } else {
          // Fallback: pre-schedule canned messages
          fallbackScheduleMessages(matchId);
        }
        break;
      }

      case 'NEGOTIATION_MESSAGE': {
        const nmMatchId = event.payload?.matchId;
        const match = matchHistory.get(nmMatchId);
        if (match) {
          match.messages.push(event.payload?.message);

          if (USE_LLM && match.opponentContext) {
            // LLM-powered: generate reactive response
            handleNegotiationMessageLLM(nmMatchId, event.payload?.message).catch(err => {
              console.log(`[housebot] Match ${nmMatchId}: LLM reply error: ${err.message?.slice(0, 80)}`);
            });
          }
        }
        break;
      }

      // ── Choice ──────────────────────────────────────
      case 'SIGN_CHOICE': {
        const { typedData, matchId, nonce } = event.payload;

        let choice: number;
        if (USE_LLM) {
          choice = await handleSignChoiceLLM(matchId);
        } else {
          choice = decideChoiceFallback(matchId);
        }

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
