// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ArenaToken} from "../src/split-or-steal/ArenaToken.sol";
import {AgentRegistry} from "../src/split-or-steal/AgentRegistry.sol";
import {SplitOrSteal} from "../src/split-or-steal/SplitOrSteal.sol";

/// @title Deploy
/// @notice Deploys the contracts: ArenaToken + AgentRegistry + SplitOrSteal
/// @dev SplitOrSteal includes BettingEngine - no separate BettingPool contract needed
///
/// Usage:
///   forge script script/Deploy.s.sol:Deploy --rpc-url $MONAD_RPC_URL --broadcast
///
/// Environment variables:
///   PRIVATE_KEY - Deployer private key
///   TREASURY_ADDRESS - Address to receive house fees (defaults to deployer)
contract Deploy is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);

        console.log("=== DEPLOYMENT STARTING ===");
        console.log("Deployer:", deployer);
        console.log("Treasury:", treasury);
        console.log("Balance:", deployer.balance);
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy ArenaToken (ERC20 + ERC20Permit + Faucet)
        ArenaToken arenaToken = new ArenaToken();
        console.log("1. ArenaToken deployed at:", address(arenaToken));

        // 2. Deploy AgentRegistry
        AgentRegistry agentRegistry = new AgentRegistry();
        console.log("2. AgentRegistry deployed at:", address(agentRegistry));

        // 3. Deploy SplitOrSteal (game + betting engine unified)
        SplitOrSteal game = new SplitOrSteal(
            address(arenaToken),
            address(agentRegistry),
            deployer, // operator
            treasury // treasury
        );
        console.log("3. SplitOrSteal deployed at:", address(game));

        vm.stopBroadcast();

        console.log("");
        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("");
        console.log("Copy these to orchestrator/.env:");
        console.log("--------------------------------");
        console.log("ARENA_TOKEN_ADDRESS=", address(arenaToken));
        console.log("AGENT_REGISTRY_ADDRESS=", address(agentRegistry));
        console.log("SPLIT_OR_STEAL_ADDRESS=", address(game));
        console.log("TREASURY_ADDRESS=", treasury);
        console.log("--------------------------------");
    }
}
