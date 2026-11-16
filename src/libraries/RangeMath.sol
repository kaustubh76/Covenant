// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";

/// @title RangeMath
/// @notice Position amounts and valuation, using the same rounding the PoolManager uses on removal.
library RangeMath {
    /// @notice Currency amounts that liquidity `liquidity` over [tickLower, tickUpper] holds at `sqrtPriceX96`.
    /// @dev Rounded down, which is exactly what removing that liquidity pays out (fees excluded).
    function amounts(uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper, uint128 liquidity)
        internal
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(tickUpper);
        if (sqrtPriceX96 <= sqrtA) {
            amount0 = SqrtPriceMath.getAmount0Delta(sqrtA, sqrtB, liquidity, false);
        } else if (sqrtPriceX96 < sqrtB) {
            amount0 = SqrtPriceMath.getAmount0Delta(sqrtPriceX96, sqrtB, liquidity, false);
            amount1 = SqrtPriceMath.getAmount1Delta(sqrtA, sqrtPriceX96, liquidity, false);
        } else {
            amount1 = SqrtPriceMath.getAmount1Delta(sqrtA, sqrtB, liquidity, false);
        }
    }

    /// @notice Quote that liquidity `liquidity` holds over the price-tick interval [priceLower, priceUpper] once the
    ///         price is at or above `priceUpper`: the quote that buys tokens as the price falls through the interval.
    /// @dev Empty and inverted intervals hold nothing.
    function quoteBetween(bool quoteIs0, uint128 liquidity, int24 priceLower, int24 priceUpper)
        internal
        pure
        returns (uint256)
    {
        if (priceUpper <= priceLower || liquidity == 0) return 0;
        if (quoteIs0) {
            // price ticks [a, b] are pool ticks [-b, -a]; quote is currency0
            return SqrtPriceMath.getAmount0Delta(
                TickMath.getSqrtPriceAtTick(-priceUpper), TickMath.getSqrtPriceAtTick(-priceLower), liquidity, false
            );
        }
        return SqrtPriceMath.getAmount1Delta(
            TickMath.getSqrtPriceAtTick(priceLower), TickMath.getSqrtPriceAtTick(priceUpper), liquidity, false
        );
    }

    /// @notice `tokenAmount` of the launched token expressed in quote at pool price `sqrtPriceX96`. Rounded down.
    function tokenToQuote(bool quoteIs0, uint256 tokenAmount, uint160 sqrtPriceX96) internal pure returns (uint256) {
        if (tokenAmount == 0) return 0;
        // The pool price is currency1 per currency0, (sqrtP / 2^96)^2.
        if (quoteIs0) {
            // token is currency1: quote = token / price
            return FullMath.mulDiv(
                FullMath.mulDiv(tokenAmount, FixedPoint96.Q96, sqrtPriceX96), FixedPoint96.Q96, sqrtPriceX96
            );
        }
        // token is currency0: quote = token * price
        return FullMath.mulDiv(
            FullMath.mulDiv(tokenAmount, sqrtPriceX96, FixedPoint96.Q96), sqrtPriceX96, FixedPoint96.Q96
        );
    }
}
