// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SplitOrSteal} from "../src/split-or-steal/SplitOrSteal.sol";

/// @title DeploySplitOrStealOnly
/// @notice Redeploys only SplitOrSteal, reusing existing ArenaToken + AgentRegistry
///
/// Usage:
///   forge script script/DeploySplitOrStealOnly.s.sol:DeploySplitOrStealOnly \
///     --rpc-url $MONAD_RPC_URL --broadcast
///
/// Environment variables:
///   PRIVATE_KEY - Deployer private key
///   TREASURY_ADDRESS - Address to receive house fees (defaults to deployer)
contract DeploySplitOrStealOnly is Script {
    // Existing deployments (unchanged)
    address constant ARENA_TOKEN = 0x82C69946Cb7d881447e70a058a47Aa5715Ae7428;
    address constant AGENT_REGISTRY = 0xe0D7c422Ce11C22EdF75966203058519c5Ab6a0C;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);

        console.log("=== REDEPLOY SplitOrSteal ONLY ===");
        console.log("Deployer:", deployer);
        console.log("Treasury:", treasury);
        console.log("ArenaToken (existing):", ARENA_TOKEN);
        console.log("AgentRegistry (existing):", AGENT_REGISTRY);
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        SplitOrSteal game = new SplitOrSteal(
            ARENA_TOKEN,
            AGENT_REGISTRY,
            deployer,  // operator
            treasury   // treasury
        );

        vm.stopBroadcast();

        console.log("SplitOrSteal deployed at:", address(game));
        console.log("");
        console.log("Update these in .env files:");
        console.log("SPLIT_OR_STEAL_ADDRESS=", address(game));
    }
}
