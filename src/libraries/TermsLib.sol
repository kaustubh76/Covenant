// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Terms} from "../types/CovenantTypes.sol";

/// @title TermsLib
/// @notice Bounds every covenant term must satisfy. Checked once, when a vault is created.
library TermsLib {
    int24 internal constant MAX_GUARD_TICKS = 10_000;
    int24 internal constant MAX_BAND_TICKS = 200_000;
    uint32 internal constant MIN_EPOCH = 1 hours;
    uint32 internal constant MAX_EPOCH = 30 days;
    uint32 internal constant MIN_WINDOW = 5 minutes;
    uint16 internal constant MAX_CURATOR_FEE_BPS = 3000;

    error InvalidSupportBps(uint16 supportBps);
    error InvalidGuardTicks(int24 guardTicks);
    /// @dev The band must leave room for at least three tick spacings beyond the guard, or `restore` could have
    ///      no aligned range to place quote in.
    error InvalidSupportBand(int24 supportBandTicks, int24 minimum);
    error InvalidPaceBps(uint16 paceBps);
    error InvalidEpochLength(uint32 epochLength);
    error InvalidTwapWindow(uint32 twapWindow, uint32 maximum);
    error InvalidCuratorFeeBps(uint16 curatorFeeBps);

    function validate(Terms memory t, int24 tickSpacing, uint32 maxWindow) internal pure {
        if (t.supportBps == 0 || t.supportBps > 1e4) revert InvalidSupportBps(t.supportBps);
        if (t.guardTicks <= 0 || t.guardTicks > MAX_GUARD_TICKS) revert InvalidGuardTicks(t.guardTicks);
        int24 minBand = t.guardTicks + 3 * tickSpacing;
        if (t.supportBandTicks < minBand || t.supportBandTicks > MAX_BAND_TICKS) {
            revert InvalidSupportBand(t.supportBandTicks, minBand);
        }
        if (t.paceBps == 0 || t.paceBps > 1e4) revert InvalidPaceBps(t.paceBps);
        if (t.epochLength < MIN_EPOCH || t.epochLength > MAX_EPOCH) revert InvalidEpochLength(t.epochLength);
        if (t.twapWindow < MIN_WINDOW || t.twapWindow > maxWindow) revert InvalidTwapWindow(t.twapWindow, maxWindow);
        if (t.curatorFeeBps > MAX_CURATOR_FEE_BPS) revert InvalidCuratorFeeBps(t.curatorFeeBps);
    }
}
