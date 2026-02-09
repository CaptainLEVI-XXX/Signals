// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {CustomRevert} from "../libraries/CustomRevert.sol";

contract AgentRegistry {
    using CustomRevert for bytes4;

    error AlreadyRegistered();
    error NotRegistered();
    error InvalidName();
    error AgentNotFound();
    error AgentNotActive();

    struct Agent {
        uint256 id;
        address wallet;
        string name;
        string avatarUrl;
        string metadataUri;
    }

    uint256 public agentCount;
    mapping(uint256 => Agent) private _agentsById;
    mapping(address => uint256) public agentIdByWallet;
    uint256 public constant MAX_NAME_LENGTH = 32;
    uint256 public constant MAX_URI_LENGTH = 256;

    event AgentRegistered(uint256 indexed id, address indexed wallet, string name);
    event AgentUpdated(uint256 indexed id, address indexed wallet);
    event AgentDeactivated(uint256 indexed id, address indexed wallet);
    event AgentReactivated(uint256 indexed id, address indexed wallet);

    function register(string calldata name, string calldata avatarUrl, string calldata metadataUri)
        external
        returns (uint256 id)
    {
        // Check not already registered
        if (agentIdByWallet[msg.sender] != 0) AlreadyRegistered.selector.revertWith();

        // Validate name
        // need to add this revert structure in the skills docs
        uint256 nameLength = bytes(name).length;
        if (nameLength == 0 || nameLength > MAX_NAME_LENGTH) {
            InvalidName.selector.revertWith();
        }

        // Validate URLs (just length check, content validation off-chain)
        require(bytes(avatarUrl).length <= MAX_URI_LENGTH, "Avatar URL too long");
        require(bytes(metadataUri).length <= MAX_URI_LENGTH, "Metadata URI too long");

        id = ++agentCount;

        _agentsById[id] =
            Agent({id: id, wallet: msg.sender, name: name, avatarUrl: avatarUrl, metadataUri: metadataUri});

        //create a reverse mapping
        agentIdByWallet[msg.sender] = id;

        emit AgentRegistered(id, msg.sender, name);
    }

    function updateProfile(string calldata name, string calldata avatarUrl, string calldata metadataUri) external {
        uint256 id = agentIdByWallet[msg.sender];
        if (id == 0) {
            NotRegistered.selector.revertWith();
        }

        // Validate name
        uint256 nameLength = bytes(name).length;
        if (nameLength == 0 || nameLength > MAX_NAME_LENGTH) {
            InvalidName.selector.revertWith();
        }

        // Validate URLs
        require(bytes(avatarUrl).length <= MAX_URI_LENGTH, "Avatar URL too long");
        require(bytes(metadataUri).length <= MAX_URI_LENGTH, "Metadata URI too long");

        // Update storage
        Agent storage agent = _agentsById[id];
        agent.name = name;
        agent.avatarUrl = avatarUrl;
        agent.metadataUri = metadataUri;

        emit AgentUpdated(id, msg.sender);
    }

    function getAgent(uint256 id) external view returns (Agent memory) {
        if (id == 0 || id > agentCount) {
            AgentNotFound.selector.revertWith();
        }
        return _agentsById[id];
    }

    function getAgentByWallet(address wallet) external view returns (Agent memory) {
        uint256 id = agentIdByWallet[wallet];
        if (id == 0) {
            AgentNotFound.selector.revertWith();
        }
        return _agentsById[id];
    }

    function isRegistered(address wallet) external view returns (bool) {
        return agentIdByWallet[wallet] != 0;
    }

    function getAgents(uint256 startId, uint256 count) external view returns (Agent[] memory agents) {
        if (startId == 0 || startId > agentCount) {
            return new Agent[](0);
        }

        // Calculate actual count (don't exceed total)
        uint256 endId = startId + count;
        if (endId > agentCount + 1) {
            endId = agentCount + 1;
        }

        uint256 actualCount = endId - startId;
        agents = new Agent[](actualCount);

        for (uint256 i = 0; i < actualCount; i++) {
            agents[i] = _agentsById[startId + i];
        }
    }
}
