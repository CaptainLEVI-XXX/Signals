import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const SplitOrStealArtifact = require('../../../contracts/out/SplitOrSteal.sol/SplitOrSteal.json');
const AgentRegistryArtifact = require('../../../contracts/out/AgentRegistry.sol/AgentRegistry.json');
const ArenaTokenArtifact = require('../../../contracts/out/ArenaToken.sol/ArenaToken.json');

export const SPLIT_OR_STEAL_ABI = SplitOrStealArtifact.abi;
export const AGENT_REGISTRY_ABI = AgentRegistryArtifact.abi;
export const ARENA_TOKEN_ABI = ArenaTokenArtifact.abi;
