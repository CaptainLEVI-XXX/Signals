import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const SplitOrStealArtifact = require('./abis/SplitOrSteal.json');
const AgentRegistryArtifact = require('./abis/AgentRegistry.json');
const ArenaTokenArtifact = require('./abis/ArenaToken.json');

export const SPLIT_OR_STEAL_ABI = SplitOrStealArtifact.abi;
export const AGENT_REGISTRY_ABI = AgentRegistryArtifact.abi;
export const ARENA_TOKEN_ABI = ArenaTokenArtifact.abi;
