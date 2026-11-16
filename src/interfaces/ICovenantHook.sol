// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @title ICovenantHook
/// @notice The pool hook every Covenant launch uses. It gates initialization to Uniswap's LBPStrategy and keeps a
///         manipulation-resistant TWAP for each pool. It holds no funds and has no owner.
interface ICovenantHook {
    /// @notice Emitted when a pool using this hook is initialized and its oracle starts.
    event OracleInitialized(PoolId indexed poolId, int24 tick);

    error InvalidTickRate(uint256 rate);

    /// @notice Longest TWAP window the oracle guarantees full history for.
    function MAX_WINDOW() external view returns (uint32);

    /// @notice Most ticks per second the recorded tick may move toward the spot tick.
    function maxTickRate() external view returns (uint256);

    /// @notice Average recorded tick over the last `window` seconds.
    function consult(PoolId poolId, uint32 window) external view returns (int24);

    /// @notice The recorded (slew-limited) tick now.
    function recordedTick(PoolId poolId) external view returns (int24);

    /// @notice Whether the pool exists under this hook, the tick it was initialized at, and when.
    function poolInfo(PoolId poolId)
        external
        view
        returns (bool initialized, int24 initialTick, uint32 initializedAt);
}
