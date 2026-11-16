// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {InitializerHook} from "liquidity-launcher/src/periphery/hooks/InitializerHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {TwapOracle} from "./libraries/TwapOracle.sol";
import {ICovenantHook} from "./interfaces/ICovenantHook.sol";

/// @title CovenantHook
/// @notice One deployment per chain serves every Covenant launch on that chain.
/// @dev Inherits Uniswap's InitializerHook unchanged, so LBPStrategy accepts it as a launch's pool hook and only that
///      strategy can initialize pools with it. On top it runs one TwapOracle per pool:
///      - afterInitialize seeds the oracle with the pool's opening tick (the auction's clearing price);
///      - afterSwap records the new spot tick.
///      The hook never touches liquidity and returns no deltas, so it cannot change what a swap pays.
contract CovenantHook is InitializerHook, ICovenantHook {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using TwapOracle for TwapOracle.State;

    struct PoolInfo {
        bool initialized;
        int24 initialTick;
        uint32 initializedAt;
    }

    /// @inheritdoc ICovenantHook
    uint32 public constant MAX_WINDOW = TwapOracle.MAX_WINDOW;

    /// @inheritdoc ICovenantHook
    uint256 public immutable maxTickRate;

    mapping(PoolId poolId => TwapOracle.State) internal _oracles;
    mapping(PoolId poolId => PoolInfo) internal _pools;

    /// @param poolManager_ The chain's v4 PoolManager.
    /// @param strategy The chain's LBPStrategy, the only address allowed to initialize pools with this hook.
    /// @param maxTickRate_ Ticks per second the recorded tick may move. 10 lets a 20% move register in about three
    ///        minutes while a one-block spike moves it by at most 20 ticks on a 2-second chain.
    constructor(IPoolManager poolManager_, address strategy, uint256 maxTickRate_)
        InitializerHook(poolManager_, strategy)
    {
        if (maxTickRate_ == 0 || maxTickRate_ > uint256(int256(TickMath.MAX_TICK))) {
            revert InvalidTickRate(maxTickRate_);
        }
        maxTickRate = maxTickRate_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeInitialize = true;
        permissions.afterInitialize = true;
        permissions.afterSwap = true;
    }

    function supportsInterface(bytes4 interfaceId) public pure override returns (bool) {
        return interfaceId == type(ICovenantHook).interfaceId || super.supportsInterface(interfaceId);
    }

    // ------------------------------------------------------------------------------------------------ callbacks

    function _afterInitialize(address, PoolKey calldata key, uint160, int24 tick) internal override returns (bytes4) {
        PoolId poolId = key.toId();
        uint32 time = uint32(block.timestamp);
        _oracles[poolId].initialize(time, tick);
        _pools[poolId] = PoolInfo({initialized: true, initialTick: tick, initializedAt: time});
        emit OracleInitialized(poolId, tick);
        return IHooks.afterInitialize.selector;
    }

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        PoolId poolId = key.toId();
        (, int24 tick,,) = poolManager.getSlot0(poolId);
        _oracles[poolId].write(uint32(block.timestamp), tick, maxTickRate);
        return (IHooks.afterSwap.selector, 0);
    }

    // ------------------------------------------------------------------------------------------------ views

    /// @inheritdoc ICovenantHook
    function consult(PoolId poolId, uint32 window) external view returns (int24) {
        return _oracles[poolId].consult(uint32(block.timestamp), window, maxTickRate);
    }

    /// @inheritdoc ICovenantHook
    function recordedTick(PoolId poolId) external view returns (int24) {
        return _oracles[poolId].recordedTick(uint32(block.timestamp), maxTickRate);
    }

    /// @inheritdoc ICovenantHook
    function poolInfo(PoolId poolId)
        external
        view
        returns (bool initialized, int24 initialTick, uint32 initializedAt)
    {
        PoolInfo memory info = _pools[poolId];
        return (info.initialized, info.initialTick, info.initializedAt);
    }
}
