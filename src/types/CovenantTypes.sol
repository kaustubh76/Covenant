// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice The covenant a vault is bound by. Fixed when the vault is created, before the auction, and never
///         changeable afterwards. Bidders read these numbers before they bid.
/// @dev Ticks here are distances, so they mean the same thing in either pool orientation.
struct Terms {
    /// @dev S. Minimum share of the vault's quote that must sit as buy support (1e4 = 100%).
    uint16 supportBps;
    /// @dev B. Depth of the support band below the reference price, in ticks.
    int24 supportBandTicks;
    /// @dev M. Share of vault value the curator may restructure per epoch (1e4 = 100%).
    uint16 paceBps;
    /// @dev E. Seconds per epoch. Pace refills at M per E; the Anchor climbs at most B per E.
    uint32 epochLength;
    /// @dev G. Largest |spot - TWAP| at which the vault accepts a state change.
    int24 guardTicks;
    /// @dev W. TWAP averaging window, in seconds.
    uint32 twapWindow;
    /// @dev Seconds after adoption before the issuer's principal starts to vest.
    uint32 lockDuration;
    /// @dev Seconds over which principal vests linearly once the lock ends. Zero means a cliff.
    uint32 vestDuration;
    /// @dev T. Seconds between proposing a new curator and it taking effect.
    uint32 curatorTimelock;
    /// @dev Most quote paid to the caller of a successful restore.
    uint128 bounty;
    /// @dev Share of every trading fee paid to the curator (1e4 = 100%). The rest accrues pro rata to all shares.
    uint16 curatorFeeBps;
}

/// @notice One liquidity position the vault owns directly in the PoolManager.
struct Range {
    int24 tickLower;
    int24 tickUpper;
    uint128 liquidity;
}

/// @notice Liquidity a reshape removes from an existing range.
/// @dev `liquidity` above the range's current liquidity is clamped, so type(uint128).max removes it all.
struct Cut {
    uint256 index;
    uint128 liquidity;
}

/// @notice A range a reshape adds, sized on-chain from what the reshape freed.
/// @dev Shares are basis points of the currency available to the reshape (freed by its cuts plus the vault's
///      idle balance). SINK instead takes whatever of that currency is left after every other leg.
struct Leg {
    int24 tickLower;
    int24 tickUpper;
    uint16 share0;
    uint16 share1;
}

/// @notice Everything a vault is created with.
struct VaultConfig {
    /// @dev true when the quote asset is the pool's currency0 (always the case for native ETH).
    bool quoteIsCurrency0;
    Terms terms;
    address issuer;
    address treasury;
    address curator;
}
