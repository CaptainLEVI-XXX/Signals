// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test, console} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/split-or-steal/AgentRegistry.sol";

contract AgentRegistryTest is Test {
    AgentRegistry public registry;

    address public agent1 = makeAddr("agent1");
    address public agent2 = makeAddr("agent2");
    address public agent3 = makeAddr("agent3");

    // Redeclare events for testing
    event AgentRegistered(uint256 indexed id, address indexed wallet, string name);
    event AgentUpdated(uint256 indexed id, address indexed wallet);

    function setUp() public {
        registry = new AgentRegistry();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // REGISTRATION TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_register_success() public {
        vm.prank(agent1);
        uint256 id = registry.register("Agent1", "https://avatar.url", "ipfs://metadata");

        assertEq(id, 1);
        assertEq(registry.agentCount(), 1);
        assertEq(registry.agentIdByWallet(agent1), 1);
        assertTrue(registry.isRegistered(agent1));
    }

    function test_register_multipleAgents() public {
        vm.prank(agent1);
        uint256 id1 = registry.register("Agent1", "", "");

        vm.prank(agent2);
        uint256 id2 = registry.register("Agent2", "", "");

        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(registry.agentCount(), 2);
    }

    function test_register_revertIfAlreadyRegistered() public {
        vm.prank(agent1);
        registry.register("Agent1", "", "");

        vm.prank(agent1);
        vm.expectRevert(AgentRegistry.AlreadyRegistered.selector);
        registry.register("Agent1Again", "", "");
    }

    function test_register_revertIfEmptyName() public {
        vm.prank(agent1);
        vm.expectRevert(AgentRegistry.InvalidName.selector);
        registry.register("", "", "");
    }

    function test_register_revertIfNameTooLong() public {
        string memory longName = "ThisNameIsWayTooLongForTheRegistryLimit";

        vm.prank(agent1);
        vm.expectRevert(AgentRegistry.InvalidName.selector);
        registry.register(longName, "", "");
    }

    function test_register_revertIfAvatarUrlTooLong() public {
        // Create a string longer than 256 bytes
        bytes memory longUrl = new bytes(257);
        for (uint256 i = 0; i < 257; i++) {
            longUrl[i] = "a";
        }

        vm.prank(agent1);
        vm.expectRevert("Avatar URL too long");
        registry.register("Agent1", string(longUrl), "");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PROFILE UPDATE TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_updateProfile_success() public {
        vm.prank(agent1);
        registry.register("Agent1", "", "");

        vm.prank(agent1);
        registry.updateProfile("NewName", "https://new.url", "ipfs://new");

        AgentRegistry.Agent memory agent = registry.getAgentByWallet(agent1);
        assertEq(agent.name, "NewName");
        assertEq(agent.avatarUrl, "https://new.url");
        assertEq(agent.metadataUri, "ipfs://new");
    }

    function test_updateProfile_revertIfNotRegistered() public {
        vm.prank(agent1);
        vm.expectRevert(AgentRegistry.NotRegistered.selector);
        registry.updateProfile("Name", "", "");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTION TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_getAgent_success() public {
        vm.prank(agent1);
        registry.register("Agent1", "https://avatar.url", "ipfs://metadata");

        AgentRegistry.Agent memory agent = registry.getAgent(1);
        assertEq(agent.id, 1);
        assertEq(agent.wallet, agent1);
        assertEq(agent.name, "Agent1");
        assertEq(agent.avatarUrl, "https://avatar.url");
        assertEq(agent.metadataUri, "ipfs://metadata");
    }

    function test_getAgent_revertIfNotFound() public {
        vm.expectRevert(AgentRegistry.AgentNotFound.selector);
        registry.getAgent(1);
    }

    function test_getAgent_revertIfIdZero() public {
        vm.expectRevert(AgentRegistry.AgentNotFound.selector);
        registry.getAgent(0);
    }

    function test_getAgentByWallet_success() public {
        vm.prank(agent1);
        registry.register("Agent1", "", "");

        AgentRegistry.Agent memory agent = registry.getAgentByWallet(agent1);
        assertEq(agent.id, 1);
        assertEq(agent.wallet, agent1);
    }

    function test_getAgentByWallet_revertIfNotFound() public {
        vm.expectRevert(AgentRegistry.AgentNotFound.selector);
        registry.getAgentByWallet(agent1);
    }

    function test_getAgents_pagination() public {
        // Register 5 agents
        string[5] memory names = ["AgentA", "AgentB", "AgentC", "AgentD", "AgentE"];
        for (uint256 i = 0; i < 5; i++) {
            address agent = makeAddr(names[i]);
            vm.prank(agent);
            registry.register(names[i], "", "");
        }

        // Get first 3
        AgentRegistry.Agent[] memory agents = registry.getAgents(1, 3);
        assertEq(agents.length, 3);
        assertEq(agents[0].id, 1);
        assertEq(agents[1].id, 2);
        assertEq(agents[2].id, 3);

        // Get next 2
        agents = registry.getAgents(4, 3);
        assertEq(agents.length, 2); // Only 2 remaining
        assertEq(agents[0].id, 4);
        assertEq(agents[1].id, 5);
    }

    function test_getAgents_emptyIfInvalidStart() public {
        vm.prank(agent1);
        registry.register("Agent1", "", "");

        AgentRegistry.Agent[] memory agents = registry.getAgents(0, 10);
        assertEq(agents.length, 0);

        agents = registry.getAgents(100, 10);
        assertEq(agents.length, 0);
    }

    function test_isRegistered() public {
        assertFalse(registry.isRegistered(agent1));

        vm.prank(agent1);
        registry.register("Agent1", "", "");

        assertTrue(registry.isRegistered(agent1));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENT TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_emitsAgentRegistered() public {
        vm.prank(agent1);
        vm.expectEmit(true, true, false, true);
        emit AgentRegistered(1, agent1, "Agent1");
        registry.register("Agent1", "", "");
    }

    function test_emitsAgentUpdated() public {
        vm.prank(agent1);
        registry.register("Agent1", "", "");

        vm.prank(agent1);
        vm.expectEmit(true, true, false, false);
        emit AgentUpdated(1, agent1);
        registry.updateProfile("NewName", "", "");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FUZZ TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function testFuzz_register_validName(string calldata name) public {
        vm.assume(bytes(name).length > 0 && bytes(name).length <= 32);

        vm.prank(agent1);
        uint256 id = registry.register(name, "", "");

        assertEq(id, 1);
        AgentRegistry.Agent memory agent = registry.getAgent(1);
        assertEq(agent.name, name);
    }
}
