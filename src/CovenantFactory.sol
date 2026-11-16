// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {ICovenantFactory} from "./interfaces/ICovenantFactory.sol";
import {ICovenantHook} from "./interfaces/ICovenantHook.sol";
import {VaultConfig} from "./types/CovenantTypes.sol";
import {TermsLib} from "./libraries/TermsLib.sol";
import {CovenantVault} from "./CovenantVault.sol";
import {VaultOps} from "./vault/VaultOps.sol";

/// @title CovenantFactory
/// @notice One per chain. Deploys the vault implementation once and creates a minimal-proxy clone per launch.
/// @dev Every term is validated here, once, so a vault can never exist with terms outside TermsLib's bounds. The
///      factory has no owner and no settings: what it deploys is fixed by its constructor arguments.
contract CovenantFactory is ICovenantFactory {
    using PoolIdLibrary for PoolKey;

    ICovenantHook public immutable hook;
    /// @inheritdoc ICovenantFactory
    address public immutable implementation;

    /// @inheritdoc ICovenantFactory
    mapping(address vault => bool) public isVault;

    constructor(IPoolManager poolManager, IPositionManager positionManager, ICovenantHook hook_, VaultOps ops) {
        hook = hook_;
        implementation = address(new CovenantVault(poolManager, positionManager, hook_, ops));
    }

    /// @inheritdoc ICovenantFactory
    function createVault(PoolKey calldata key, VaultConfig calldata config, bytes32 salt)
        external
        returns (address vault)
    {
        _validate(key, config);
        vault = Clones.cloneDeterministic(implementation, _salt(msg.sender, salt));
        CovenantVault(payable(vault)).initialize(key, config);
        isVault[vault] = true;
        emit VaultCreated(
            vault, key.toId(), msg.sender, config.issuer, config.curator, config.quoteIsCurrency0, config.terms
        );
    }

    /// @inheritdoc ICovenantFactory
    function predictVault(address creator, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(creator, salt));
    }

    /// @dev Keyed by creator, so nobody can take an issuer's precomputed address with different terms.
    function _salt(address creator, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }

    function _validate(PoolKey calldata key, VaultConfig calldata config) internal view {
        if (address(key.hooks) != address(hook)) revert WrongHook(address(key.hooks));
        if (Currency.unwrap(key.currency0) >= Currency.unwrap(key.currency1)) revert InvalidPoolKey();
        // Static fees only: the hook has no fee logic, so a dynamic-fee pool would be stuck at zero.
        if (key.fee > LPFeeLibrary.MAX_LP_FEE) revert InvalidPoolKey();
        if (key.tickSpacing < TickMath.MIN_TICK_SPACING || key.tickSpacing > TickMath.MAX_TICK_SPACING) {
            revert InvalidPoolKey();
        }
        // The launched token is always an ERC20, so native ETH can only be the quote.
        if (key.currency0.isAddressZero() && !config.quoteIsCurrency0) revert QuoteMismatch();
        if (config.issuer == address(0) || config.treasury == address(0)) revert ZeroAddress();
        TermsLib.validate(config.terms, key.tickSpacing, hook.MAX_WINDOW());
    }
}
