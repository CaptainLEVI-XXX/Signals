/**
 * Test Tournament — spins up 4 agents, joins tournament queue,
 * handles on-chain join, plays all tournament matches, then exits.
 *
 * Usage: npx tsx src/test-tournament.ts
 */

import { ethers } from 'ethers';
import WebSocket from 'ws';
import { config } from './config.js';

// ─── Config ────────────────────────────────────────────

const RPC = config.rpcUrl;
const SERVER_URL = process.env.SERVER_URL || `http://127.0.0.1:${config.port}`;
const WS_URL = process.env.SERVER_URL
  ? `${SERVER_URL.replace(/^http/, 'ws')}/ws/agent`
  : `ws://127.0.0.1:${config.port}/ws/agent`;
const ARENA_TOKEN = config.arenaTokenAddress;
const AGENT_REGISTRY = config.agentRegistryAddress;
const SPLIT_OR_STEAL = config.splitOrStealAddress;

const AGENT_KEYS = [
  process.env.TEST_AGENT_PRIVATE_KEY!,
  process.env.HOUSEBOT_PRIVATE_KEY!,
  '0x4c612d094ec99ec3aaa6ee74aea267a372ad721482a3ba18403204aea8a1ae35',
  '0xba0b56fd22c3b3eeb3522de13548a330c396da2d4449c5afbc27983e25a3cb31',
];

const AGENT_NAMES = ['TourneyBot-1', 'TourneyBot-2', 'TourneyBot-3', 'TourneyBot-4'];
const STRATEGIES = ['SPLIT', 'STEAL', 'SPLIT', 'SPLIT']; // varied strategies

// ─── ABIs ──────────────────────────────────────────────

const ARENA_ABI = [
  'function faucet() external',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'function allowance(address, address) view returns (uint256)',
];

const REGISTRY_ABI = [
  'function register(string, string, string) external',
  'function isRegistered(address) view returns (bool)',
  'function getAgentByWallet(address) view returns (tuple(uint256 id, address wallet, string name, string avatarUrl, string metadataUri))',
];

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

// ─── State tracking ────────────────────────────────────

const provider = new ethers.JsonRpcProvider(RPC);
const agentWallets = AGENT_KEYS.map(k => new ethers.Wallet(k, provider));
const agentConnections = new Map<string, WebSocket>(); // address -> ws
let completedMatches = 0;
let totalExpectedMatches = 0;
let tournamentComplete = false;

// ─── Logging ───────────────────────────────────────────

function log(agent: number, msg: string) {
  const name = AGENT_NAMES[agent] || `Agent-${agent}`;
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${name}] ${msg}`);
}

function logGlobal(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [TOURNAMENT] ${msg}`);
}

// ─── On-chain setup ────────────────────────────────────

async function setupAgent(index: number): Promise<void> {
  const wallet = agentWallets[index];
  const name = AGENT_NAMES[index];
  log(index, `Address: ${wallet.address}`);

  // Check MON balance, fund from operator if needed
  const monBalance = await provider.getBalance(wallet.address);
  if (monBalance < ethers.parseEther('0.1')) {
    log(index, 'Funding with MON from operator...');
    const operator = new ethers.Wallet(config.operatorPrivateKey, provider);
    const tx = await operator.sendTransaction({
      to: wallet.address,
      value: ethers.parseEther('0.5'),
    });
    await tx.wait();
    log(index, 'Funded with 0.5 MON');
  } else {
    log(index, `MON: ${ethers.formatEther(monBalance)}`);
  }

  const arena = new ethers.Contract(ARENA_TOKEN, ARENA_ABI, wallet);
  const registry = new ethers.Contract(AGENT_REGISTRY, REGISTRY_ABI, wallet);

  // Claim ARENA from faucet if needed
  let arenaBalance = await arena.balanceOf(wallet.address);
  if (arenaBalance < ethers.parseEther('10')) {
    log(index, 'Claiming ARENA from faucet...');
    const faucetTx = await arena.faucet();
    await faucetTx.wait();
    arenaBalance = await arena.balanceOf(wallet.address);
  }
  log(index, `ARENA: ${ethers.formatEther(arenaBalance)}`);

  // Register if needed
  const registered = await registry.isRegistered(wallet.address);
  if (!registered) {
    log(index, `Registering as "${name}"...`);
    const regTx = await registry.register(name, '', '');
    await regTx.wait();
    log(index, 'Registered');
  } else {
    try {
      const agentData = await registry.getAgentByWallet(wallet.address);
      log(index, `Already registered as "${agentData.name}"`);
    } catch {
      log(index, 'Already registered');
    }
  }

  // Approve SplitOrSteal for ARENA spending
  const allowance = await arena.allowance(wallet.address, SPLIT_OR_STEAL);
  if (allowance < ethers.parseEther('100')) {
    log(index, 'Approving ARENA spend...');
    const appTx = await arena.approve(SPLIT_OR_STEAL, ethers.MaxUint256);
    await appTx.wait();
    log(index, 'Approved');
  } else {
    log(index, 'Already approved');
  }
}

// ─── Gasless tournament join (sign + permit) ───────────

async function signTournamentJoin(
  index: number,
  tournamentId: number,
  signingPayload: any,
  permitData: { spender: string; value: string },
): Promise<{ joinSignature: string; permitDeadline: number; v: number; r: string; s: string }> {
  const agentWallet = agentWallets[index];

  // 1. Sign the EIP-712 tournament join message
  const joinSignature = await agentWallet.signTypedData(
    signingPayload.domain,
    { TournamentJoin: signingPayload.types.TournamentJoin },
    signingPayload.message,
  );
  log(index, `Signed tournament join for tournament ${tournamentId}`);

  // 2. Sign the ERC-2612 permit for token approval
  const arenaPermit = new ethers.Contract(ARENA_TOKEN, ARENA_PERMIT_ABI, provider);
  const permitNonce = await arenaPermit.nonces(agentWallet.address);
  const permitDeadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour

  const permitDomain = {
    name: 'Arena Token',
    version: '1',
    chainId: config.chainId,
    verifyingContract: ARENA_TOKEN,
  };

  const permitSig = await agentWallet.signTypedData(
    permitDomain,
    PERMIT_TYPES,
    {
      owner: agentWallet.address,
      spender: permitData.spender,
      value: permitData.value,
      nonce: permitNonce,
      deadline: permitDeadline,
    },
  );

  const { v, r, s } = ethers.Signature.from(permitSig);
  log(index, `Signed permit for ${ethers.formatEther(permitData.value)} ARENA`);

  return { joinSignature, permitDeadline, v, r, s };
}

// ─── WebSocket agent connection ────────────────────────

function connectAgent(index: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const wallet = agentWallets[index];
    const strategy = STRATEGIES[index];
    const ws = new WebSocket(WS_URL);

    agentConnections.set(wallet.address.toLowerCase(), ws);

    ws.on('open', () => {
      log(index, 'Connected to orchestrator');
    });

    ws.on('message', async (raw: Buffer) => {
      let event: any;
      try { event = JSON.parse(raw.toString()); } catch { return; }

      switch (event.type) {
        // ─── Auth ─────────────────────────────
        case 'AUTH_CHALLENGE': {
          const { challenge, challengeId } = event.payload;
          log(index, 'Signing auth challenge...');
          const sig = await wallet.signMessage(challenge);
          ws.send(JSON.stringify({
            type: 'AUTH_RESPONSE',
            payload: { address: wallet.address, signature: sig, challengeId },
          }));
          break;
        }

        case 'AUTH_SUCCESS': {
          log(index, `Authenticated as ${event.payload?.name}`);
          resolve();
          break;
        }

        case 'AUTH_FAILED': {
          log(index, `Auth failed: ${event.payload?.reason}`);
          reject(new Error(`Auth failed for agent ${index}`));
          break;
        }

        // ─── Tournament Queue ─────────────────
        case 'TOURNAMENT_QUEUE_JOINED': {
          log(index, `In tournament queue (${event.payload?.queueSize}/${event.payload?.minPlayers} needed)`);
          break;
        }

        case 'TOURNAMENT_QUEUE_UPDATE': {
          log(index, `Tournament queue: ${event.payload?.size} agents`);
          break;
        }

        // ─── Tournament Join Request (gasless) ──
        case 'TOURNAMENT_JOIN_REQUEST': {
          const { tournamentId, entryStake, signingPayload, permitData } = event.payload;
          log(index, `Received tournament join request! ID: ${tournamentId}, stake: ${entryStake}`);

          try {
            const result = await signTournamentJoin(index, tournamentId, signingPayload, permitData);
            ws.send(JSON.stringify({
              type: 'TOURNAMENT_JOIN_SIGNED',
              payload: {
                tournamentId,
                joinSignature: result.joinSignature,
                permitDeadline: result.permitDeadline,
                v: result.v,
                r: result.r,
                s: result.s,
              },
            }));
            log(index, `Sent TOURNAMENT_JOIN_SIGNED for tournament ${tournamentId}`);
          } catch (err: any) {
            log(index, `Failed to sign tournament join: ${err.message?.slice(0, 100)}`);
          }
          break;
        }

        case 'TOURNAMENT_JOINED': {
          log(index, `Joined tournament ${event.payload?.tournamentId} on-chain (tx: ${(event.payload?.txHash as string)?.slice(0, 16)}...)`);
          break;
        }

        case 'TOURNAMENT_JOIN_FAILED': {
          log(index, `Failed to join tournament ${event.payload?.tournamentId}: ${event.payload?.reason}`);
          break;
        }

        // ─── Tournament events ────────────────
        case 'TOURNAMENT_CREATED': {
          logGlobal(`Tournament ${event.payload?.tournamentId} created`);
          break;
        }

        case 'TOURNAMENT_STARTED': {
          logGlobal(`Tournament started with ${event.payload?.playerCount} players, ${event.payload?.totalRounds} rounds`);
          break;
        }

        case 'TOURNAMENT_ROUND_STARTED': {
          logGlobal(`Round ${event.payload?.round}/${event.payload?.totalRounds} — ${event.payload?.matches} matches`);
          if (event.payload?.byePlayer) {
            logGlobal(`Bye: ${event.payload.byePlayer.slice(0, 10)}...`);
          }
          break;
        }

        case 'TOURNAMENT_UPDATE': {
          logGlobal(`Round progress: ${event.payload?.matchesCompleted}/${event.payload?.matchesTotal}`);
          break;
        }

        case 'TOURNAMENT_ROUND_COMPLETE': {
          logGlobal(`Round ${event.payload?.round} complete!`);
          const standings = event.payload?.standings as any[];
          if (standings) {
            standings.forEach((s: any, i: number) => {
              logGlobal(`  #${i + 1}: ${s.address.slice(0, 10)}... — ${s.points} pts`);
            });
          }
          break;
        }

        case 'TOURNAMENT_COMPLETE': {
          logGlobal('═══════════════════════════════════════');
          logGlobal('TOURNAMENT COMPLETE!');
          const finalStandings = event.payload?.standings as any[];
          if (finalStandings) {
            finalStandings.forEach((s: any, i: number) => {
              const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
              logGlobal(`  ${medal} #${i + 1}: ${s.address.slice(0, 10)}... — ${s.points} pts`);
            });
          }
          logGlobal('═══════════════════════════════════════');
          tournamentComplete = true;
          // Give time for final messages, then exit
          setTimeout(() => {
            logGlobal('Test complete! Exiting...');
            process.exit(0);
          }, 3000);
          break;
        }

        case 'TOURNAMENT_PLAYER_JOINED': {
          logGlobal(`Player joined tournament: ${event.payload?.player?.slice(0, 10)}... (${event.payload?.playerCount} total)`);
          break;
        }

        // ─── Match flow ───────────────────────
        case 'MATCH_STARTED': {
          const { matchId, opponentName, opponentStats } = event.payload;
          log(index, `Match ${matchId} started vs ${opponentName}`);
          if (opponentStats) {
            log(index, `  Opponent stats: ${opponentStats.matchesPlayed} matches, ${Math.round(opponentStats.splitRate * 100)}% split rate`);
          }

          // Send a negotiation message based on strategy
          const messages: Record<string, string> = {
            SPLIT: "I believe in cooperation. Let's both split and maximize our shared reward!",
            STEAL: "I promise to split with you. Trust me, we'll both benefit from cooperation.",
          };
          ws.send(JSON.stringify({
            type: 'MATCH_MESSAGE',
            payload: { matchId, message: messages[strategy] },
          }));
          break;
        }

        case 'NEGOTIATION_MESSAGE': {
          log(index, `  Opponent: "${(event.payload?.message as string)?.slice(0, 60)}..."`);
          break;
        }

        case 'SIGN_CHOICE': {
          const { typedData, matchId, nonce } = event.payload;
          const choice = strategy === 'STEAL' ? 2 : 1;
          log(index, `Match ${matchId}: choosing ${strategy} (${choice})`);

          const signature = await wallet.signTypedData(
            typedData.domain,
            { MatchChoice: typedData.types.MatchChoice },
            {
              matchId: matchId.toString(),
              choice,
              nonce: nonce.toString(),
            },
          );

          ws.send(JSON.stringify({
            type: 'CHOICE_SUBMITTED',
            payload: { matchId, choice, signature },
          }));
          break;
        }

        case 'CHOICE_ACCEPTED': {
          log(index, `Choice accepted for match ${event.payload?.matchId}`);
          break;
        }

        case 'CHOICE_LOCKED': {
          // Another agent locked their choice
          break;
        }

        case 'CHOICES_REVEALED': {
          const p = event.payload;
          const choiceAStr = p.choiceA === 1 ? 'SPLIT' : 'STEAL';
          const choiceBStr = p.choiceB === 1 ? 'SPLIT' : 'STEAL';
          log(index, `Match ${p.matchId} result: ${p.resultName} (A: ${choiceAStr}, B: ${choiceBStr})`);
          break;
        }

        case 'MATCH_CONFIRMED': {
          log(index, `Match ${event.payload?.matchId} confirmed on-chain: ${(event.payload?.txHash as string)?.slice(0, 16)}...`);
          completedMatches++;
          break;
        }

        case 'CHOICE_TIMEOUT': {
          log(index, `Match ${event.payload?.matchId} timed out!`);
          completedMatches++;
          break;
        }

        case 'CHOICE_PHASE_STARTED': {
          // Choice phase started notification for spectators
          break;
        }

        case 'ERROR': {
          log(index, `ERROR: ${event.payload?.message}`);
          break;
        }
      }
    });

    ws.on('error', (err) => {
      log(index, `WebSocket error: ${err.message}`);
      reject(err);
    });

    ws.on('close', () => {
      log(index, 'Disconnected');
    });
  });
}

// ─── Main ──────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('  TOURNAMENT TEST — 4 Agents');
  console.log('═══════════════════════════════════════════════');
  console.log('');

  // Validate keys
  for (let i = 0; i < AGENT_KEYS.length; i++) {
    if (!AGENT_KEYS[i]) {
      console.error(`Missing private key for agent ${i}`);
      process.exit(1);
    }
  }

  // Check for duplicate addresses
  const addresses = agentWallets.map(w => w.address.toLowerCase());
  const uniqueAddresses = new Set(addresses);
  if (uniqueAddresses.size !== addresses.length) {
    console.error('ERROR: Duplicate agent addresses detected!');
    addresses.forEach((a, i) => console.log(`  Agent ${i}: ${a}`));
    process.exit(1);
  }

  // Step 1: On-chain setup for all agents (sequential to avoid nonce issues with operator)
  logGlobal('Step 1: On-chain setup...');
  for (let i = 0; i < agentWallets.length; i++) {
    await setupAgent(i);
    console.log('');
  }

  // Step 2: Connect all agents via WebSocket
  logGlobal('Step 2: Connecting agents...');
  const connectPromises = agentWallets.map((_, i) => connectAgent(i));
  await Promise.all(connectPromises);
  logGlobal('All 4 agents authenticated!');
  console.log('');

  // Step 3: All agents join tournament queue
  logGlobal('Step 3: Joining tournament queue...');
  // Stagger joins slightly to make the output readable
  for (let i = 0; i < agentWallets.length; i++) {
    const ws = agentConnections.get(agentWallets[i].address.toLowerCase());
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'JOIN_TOURNAMENT_QUEUE', payload: {} }));
      log(i, 'Sent JOIN_TOURNAMENT_QUEUE');
      await new Promise(r => setTimeout(r, 500)); // 500ms stagger
    }
  }

  console.log('');
  logGlobal('Waiting for tournament to be created and played...');
  logGlobal('(This will take a few minutes — negotiation + choice phases per match per round)');
  console.log('');

  // Safety timeout — if nothing happens in 10 minutes, exit
  setTimeout(() => {
    if (!tournamentComplete) {
      logGlobal('TIMEOUT: Tournament did not complete within 10 minutes.');
      process.exit(1);
    }
  }, 10 * 60 * 1000);
}

main().catch((err) => {
  console.error('[TOURNAMENT] Fatal error:', err);
  process.exit(1);
});
