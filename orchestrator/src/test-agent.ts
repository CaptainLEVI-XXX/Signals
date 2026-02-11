/**
 * Test Agent — quick throwaway script to verify the orchestrator works.
 * Connects, registers, joins queue, plays one match, then exits.
 */

import { ethers } from 'ethers';
import WebSocket from 'ws';
import { config } from './config.js';

const RPC = config.rpcUrl;
const WS_URL = `ws://127.0.0.1:${config.wsPort}/ws/agent`;
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

// Use fixed test wallet from .env
const TEST_KEY = process.env.TEST_AGENT_PRIVATE_KEY;
if (!TEST_KEY) {
  console.error('[test-agent] TEST_AGENT_PRIVATE_KEY is required in .env');
  process.exit(1);
}
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(TEST_KEY, provider);

console.log('[test-agent] ═══════════════════════════════════');
console.log(`[test-agent] Address: ${wallet.address}`);
console.log('[test-agent] ═══════════════════════════════════');

async function fundFromOperator(): Promise<void> {
  const monBalance = await provider.getBalance(wallet.address);
  if (monBalance >= ethers.parseEther('0.1')) {
    console.log(`[test-agent] MON: ${ethers.formatEther(monBalance)} (sufficient)`);
    return;
  }
  const operator = new ethers.Wallet(config.operatorPrivateKey, provider);
  console.log('[test-agent] Funding test wallet with 0.5 MON from operator...');
  const tx = await operator.sendTransaction({
    to: wallet.address,
    value: ethers.parseEther('0.5'),
  });
  await tx.wait();
  console.log('[test-agent] Funded.');
}

async function onChainSetup(): Promise<void> {
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

  // Faucet (skip if already have tokens)
  let arenaBalance = await arena.balanceOf(wallet.address);
  if (arenaBalance < ethers.parseEther('10')) {
    console.log('[test-agent] Claiming ARENA from faucet...');
    const faucetTx = await arena.faucet();
    await faucetTx.wait();
    arenaBalance = await arena.balanceOf(wallet.address);
  }
  console.log(`[test-agent] ARENA: ${ethers.formatEther(arenaBalance)}`);

  // Register (skip if already registered)
  const registered = await registry.isRegistered(wallet.address);
  if (!registered) {
    console.log('[test-agent] Registering as "TestAgent"...');
    const regTx = await registry.register('TestAgent', '', '');
    await regTx.wait();
    console.log('[test-agent] Registered.');
  } else {
    console.log('[test-agent] Already registered.');
  }

  // Approve (skip if already approved)
  const allowance = await arena.allowance(wallet.address, SPLIT_OR_STEAL);
  if (allowance < ethers.parseEther('10')) {
    console.log('[test-agent] Approving ARENA spend...');
    const appTx = await arena.approve(SPLIT_OR_STEAL, ethers.MaxUint256);
    await appTx.wait();
    console.log('[test-agent] Approved.');
  } else {
    console.log('[test-agent] Already approved.');
  }
}

function connect(): void {
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('[test-agent] Connected to orchestrator');
  });

  ws.on('message', async (raw: Buffer) => {
    let event: any;
    try { event = JSON.parse(raw.toString()); } catch { return; }

    switch (event.type) {
      case 'AUTH_CHALLENGE': {
        const { challenge, challengeId } = event.payload;
        console.log('[test-agent] Signing auth challenge...');
        const sig = await wallet.signMessage(challenge);
        ws.send(JSON.stringify({
          type: 'AUTH_RESPONSE',
          payload: { address: wallet.address, signature: sig, challengeId },
        }));
        break;
      }

      case 'AUTH_SUCCESS': {
        console.log('[test-agent] Authenticated! Joining queue...');
        ws.send(JSON.stringify({ type: 'JOIN_QUEUE', payload: {} }));
        break;
      }

      case 'AUTH_FAILED': {
        console.error(`[test-agent] Auth failed: ${event.payload?.reason}`);
        process.exit(1);
      }

      case 'QUEUE_JOINED': {
        console.log('[test-agent] In queue. Waiting for match...');
        break;
      }

      case 'MATCH_STARTED': {
        const { matchId, opponentName } = event.payload;
        console.log(`[test-agent] Match ${matchId} started vs ${opponentName}`);
        ws.send(JSON.stringify({
          type: 'MATCH_MESSAGE',
          payload: { matchId, message: "Hello! I'm a test agent. Let's split!" },
        }));
        break;
      }

      case 'NEGOTIATION_MESSAGE': {
        console.log(`[test-agent] Opponent says: "${event.payload?.message}"`);
        break;
      }

      case 'SIGN_CHOICE': {
        const { typedData, matchId, nonce } = event.payload;
        const choice = 1; // Always SPLIT
        console.log(`[test-agent] Match ${matchId}: choosing SPLIT`);

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

      case 'CHOICES_REVEALED': {
        const p = event.payload;
        const theirA = p.choiceA === 1 ? 'SPLIT' : 'STEAL';
        const theirB = p.choiceB === 1 ? 'SPLIT' : 'STEAL';
        console.log(`[test-agent] Match ${p.matchId} result: ${p.resultName}`);
        console.log(`[test-agent]   Agent A: ${theirA}, Agent B: ${theirB}`);
        break;
      }

      case 'MATCH_CONFIRMED': {
        console.log(`[test-agent] On-chain tx: ${event.payload?.txHash}`);
        console.log('[test-agent] Test complete! Exiting...');
        ws.close();
        setTimeout(() => process.exit(0), 1000);
        break;
      }

      case 'CHOICE_TIMEOUT': {
        console.log(`[test-agent] Match ${event.payload?.matchId} timed out`);
        ws.close();
        setTimeout(() => process.exit(1), 1000);
        break;
      }

      // ── Gasless Tournament Join ─────────────────
      case 'TOURNAMENT_JOIN_REQUEST': {
        const { tournamentId, entryStake, signingPayload, permitData } = event.payload;
        console.log(`[test-agent] Tournament join request! ID: ${tournamentId}, stake: ${entryStake}`);

        try {
          const joinSignature = await wallet.signTypedData(
            signingPayload.domain,
            { TournamentJoin: signingPayload.types.TournamentJoin },
            signingPayload.message,
          );

          const arenaPermit = new ethers.Contract(ARENA_TOKEN, ARENA_PERMIT_ABI, provider);
          const permitNonce = await arenaPermit.nonces(wallet.address);
          const permitDeadline = Math.floor(Date.now() / 1000) + 3600;

          const permitSig = await wallet.signTypedData(
            { name: 'Arena Token', version: '1', chainId: config.chainId, verifyingContract: ARENA_TOKEN },
            PERMIT_TYPES,
            { owner: wallet.address, spender: permitData.spender, value: permitData.value, nonce: permitNonce, deadline: permitDeadline },
          );
          const { v, r, s } = ethers.Signature.from(permitSig);

          ws.send(JSON.stringify({
            type: 'TOURNAMENT_JOIN_SIGNED',
            payload: { tournamentId, joinSignature, permitDeadline, v, r, s },
          }));
          console.log(`[test-agent] Sent TOURNAMENT_JOIN_SIGNED for tournament ${tournamentId}`);
        } catch (err: any) {
          console.error(`[test-agent] Failed to sign tournament join: ${err.message?.slice(0, 100)}`);
        }
        break;
      }

      case 'TOURNAMENT_JOINED': {
        console.log(`[test-agent] Joined tournament ${event.payload?.tournamentId} on-chain`);
        break;
      }

      case 'TOURNAMENT_JOIN_FAILED': {
        console.log(`[test-agent] Tournament join failed: ${event.payload?.reason}`);
        break;
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[test-agent] WebSocket error:', err.message);
    process.exit(1);
  });

  ws.on('close', () => {
    console.log('[test-agent] Disconnected.');
  });
}

async function main(): Promise<void> {
  await fundFromOperator();
  await onChainSetup();
  console.log('[test-agent] Setup complete. Connecting to orchestrator...');
  connect();
}

main().catch((err) => {
  console.error('[test-agent] Fatal:', err);
  process.exit(1);
});
