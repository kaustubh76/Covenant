// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title Orient
/// @notice Translates between pool ticks and price ticks, so rule code never branches on pool orientation.
/// @dev A price tick rises with the launched token's price in the quote asset. When the quote is currency0 the pool
///      price is token-per-quote, so the price tick is the negated pool tick. When the quote is currency1 the two are
///      the same. Negation maps MIN_TICK to MAX_TICK exactly, so the conversion is lossless in both directions.
///
///      In price ticks, with the current price at p, a range [lo, hi] holds:
///      - only quote when p >= hi (it is a bid below the price),
///      - only tokens when p <= lo (it is an ask above the price),
///      - both otherwise.
library Orient {
    function toPrice(bool quoteIs0, int24 poolTick) internal pure returns (int24) {
        return quoteIs0 ? -poolTick : poolTick;
    }

    function toPool(bool quoteIs0, int24 priceTick) internal pure returns (int24) {
        return quoteIs0 ? -priceTick : priceTick;
    }

    /// @notice A pool-tick range as a price-tick range. Bounds stay ordered.
    function rangeToPrice(bool quoteIs0, int24 tickLower, int24 tickUpper)
        internal
        pure
        returns (int24 priceLower, int24 priceUpper)
    {
        return quoteIs0 ? (-tickUpper, -tickLower) : (tickLower, tickUpper);
    }

    /// @notice A price-tick range as a pool-tick range. Bounds stay ordered.
    function rangeToPool(bool quoteIs0, int24 priceLower, int24 priceUpper)
        internal
        pure
        returns (int24 tickLower, int24 tickUpper)
    {
        return quoteIs0 ? (-priceUpper, -priceLower) : (priceLower, priceUpper);
    }

    /// @notice Currency0/currency1 amounts as quote/token amounts.
    function split(bool quoteIs0, uint256 amount0, uint256 amount1)
        internal
        pure
        returns (uint256 quote, uint256 token)
    {
        return quoteIs0 ? (amount0, amount1) : (amount1, amount0);
    }

    /// @notice Quote/token amounts as currency0/currency1 amounts.
    function join(bool quoteIs0, uint256 quote, uint256 token)
        internal
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        return quoteIs0 ? (quote, token) : (token, quote);
    }

    /// @notice Largest multiple of `spacing` at or below `tick`.
    function floorTo(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 r = tick % spacing;
        return r >= 0 ? tick - r : tick - r - spacing;
    }

    /// @notice Smallest multiple of `spacing` at or above `tick`.
    function ceilTo(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 f = floorTo(tick, spacing);
        return f == tick ? tick : f + spacing;
    }
}
