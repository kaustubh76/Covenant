// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Terms, VaultConfig} from "../types/CovenantTypes.sol";

/// @title ICovenantFactory
/// @notice Creates Covenant vaults. An issuer creates the vault before the auction, then names its address as the
///         launch's LP position recipient. Vault addresses are deterministic per creator and salt.
interface ICovenantFactory {
    event VaultCreated(
        address indexed vault,
        PoolId indexed poolId,
        address indexed creator,
        address issuer,
        address curator,
        bool quoteIsCurrency0,
        Terms terms
    );

    error WrongHook(address hook);
    error InvalidPoolKey();
    error QuoteMismatch();
    error ZeroAddress();

    function createVault(PoolKey calldata key, VaultConfig calldata config, bytes32 salt)
        external
        returns (address vault);

    /// @notice The address `createVault` returns for `creator` and `salt`.
    function predictVault(address creator, bytes32 salt) external view returns (address);

    function isVault(address vault) external view returns (bool);

    function implementation() external view returns (address);
}
