// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title MockToken
/// @notice ERC20 + ERC20Permit for testing SplitOrSteal
contract MockToken is ERC20, ERC20Permit {
    constructor() ERC20("Arena Token", "ARENA") ERC20Permit("Arena Token") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function nonces(address owner) public view override(ERC20Permit) returns (uint256) {
        return super.nonces(owner);
    }
}
