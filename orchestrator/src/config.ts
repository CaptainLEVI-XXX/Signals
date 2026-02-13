import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // Server (HTTP + WebSocket share the same port)
  port: parseInt(process.env.PORT || '3000'),

  // Chain
  rpcUrl: process.env.RPC_URL || 'https://testnet-rpc.monad.xyz',
  chainId: parseInt(process.env.CHAIN_ID || '10143'),
  operatorPrivateKey: process.env.OPERATOR_PRIVATE_KEY || '',

  // Contract addresses
  splitOrStealAddress: process.env.SPLIT_OR_STEAL_ADDRESS || '',
  arenaTokenAddress: process.env.ARENA_TOKEN_ADDRESS || '',
  agentRegistryAddress: process.env.AGENT_REGISTRY_ADDRESS || '',

  // Timing (milliseconds)
  negotiationDuration: 45_000,   // 45s
  choiceDuration: 15_000,        // 15s (35s to 50s)
  settlementBuffer: 10_000,      // 10s (50s to 60s)
  matchDeadline: 60,             // 60s (on-chain, in seconds)
  settlementFlushInterval: 200,  // 200ms batch buffer

  // Batch
  batchCap: 30,

  // Auth
  authChallengeExpiry: 60_000,   // 60s to complete auth
} as const;
