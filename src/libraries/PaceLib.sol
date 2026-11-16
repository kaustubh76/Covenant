// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title PaceLib
/// @notice A refilling allowance for how much of the vault a curator may restructure.
/// @dev The allowance is a fraction of vault value, not an amount of currency, so growing the vault with a deposit
///      does not let the curator move more of the existing layout. It refills continuously at M per epoch and holds
///      at most M, so no single block can move more than M. Over any window of one epoch at most 2M can move (a full
///      allowance at the start plus one epoch of refill); fixed epochs allowed the same 2M across a boundary within
///      two blocks.
library PaceLib {
    /// @dev 1e9 = the whole vault.
    uint256 internal constant ONE = 1e9;

    /// @notice The allowance available now, in units of ONE.
    function available(uint64 budget, uint64 updatedAt, uint16 paceBps, uint32 epochLength, uint256 timestamp)
        internal
        pure
        returns (uint256)
    {
        uint256 cap = uint256(paceBps) * ONE / 1e4;
        uint256 elapsed = timestamp > updatedAt ? timestamp - updatedAt : 0;
        uint256 refilled = uint256(budget) + cap * elapsed / epochLength;
        return refilled > cap ? cap : refilled;
    }

    /// @notice `part` as a fraction of `whole` in units of ONE, rounded up so the curator is never undercharged.
    function fraction(uint256 part, uint256 whole) internal pure returns (uint256) {
        if (part == 0) return 0;
        if (whole == 0 || part >= whole) return ONE;
        return (part * ONE + whole - 1) / whole;
    }
}
