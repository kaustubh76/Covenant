// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice The token a public testnet launch sells. Its whole supply is minted once, to the issuer, at deployment, and
///         nobody can mint more, so nobody can drain a vault's bids by selling it tokens they printed for free.
///         `TestToken`, whose mint is open, is for local chains and tests only.
contract LaunchToken is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 supply, address holder) ERC20(name_, symbol_) {
        _mint(holder, supply);
    }
}
