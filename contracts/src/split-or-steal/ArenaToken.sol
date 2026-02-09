// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CustomRevert} from "../libraries/CustomRevert.sol";


contract ArenaToken is ERC20, ERC20Permit, Ownable {
    using CustomRevert for bytes4;
    uint256 public constant FAUCET_AMOUNT = 100 ether;
    uint256 public constant FAUCET_COOLDOWN = 24 hours;
    uint256 public constant MAX_FAUCET_SUPPLY = 10_000_000 ether;

    uint256 public faucetMinted;
    mapping(address => uint256) public lastFaucetClaim;

    event FaucetClaim(address indexed user, uint256 amount);
    event FaucetToggled(bool enabled);

    error FaucetCooldownActive(uint256 timeRemaining);
    error FaucetSupplyExhausted();

    constructor() ERC20("Arena Token", "ARENA") ERC20Permit("Arena Token") Ownable(msg.sender) {
        _mint(msg.sender, 1_000_000 ether);
    }

    /// @notice Claim 100 ARENA from the faucet (24h cooldown)
    function faucet() external {
        uint256 lastClaim = lastFaucetClaim[msg.sender];
        if (lastClaim != 0) {
            uint256 elapsed = block.timestamp - lastClaim;
            if (elapsed < FAUCET_COOLDOWN) FaucetCooldownActive.selector.revertWith(FAUCET_COOLDOWN - elapsed);
        }

        if (faucetMinted + FAUCET_AMOUNT > MAX_FAUCET_SUPPLY) FaucetSupplyExhausted.selector.revertWith();

        lastFaucetClaim[msg.sender] = block.timestamp;
        faucetMinted += FAUCET_AMOUNT;
        _mint(msg.sender, FAUCET_AMOUNT);

        emit FaucetClaim(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Seconds until user can claim faucet again
    function faucetCooldownRemaining(address user) external view returns (uint256) {
        uint256 lastClaim = lastFaucetClaim[user];
        if (lastClaim == 0) return 0;
        uint256 elapsed = block.timestamp - lastClaim;
        if (elapsed >= FAUCET_COOLDOWN) return 0;
        return FAUCET_COOLDOWN - elapsed;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @dev Required override for ERC20Permit
    function nonces(address owner) public view override(ERC20Permit) returns (uint256) {
        return super.nonces(owner);
    }
}
