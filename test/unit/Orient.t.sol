// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Orient} from "../../src/libraries/Orient.sol";
import {RangeMath} from "../../src/libraries/RangeMath.sol";

contract OrientTest is Test {
    function testFuzz_floorAndCeil(int24 tick, uint16 spacingSeed) public pure {
        tick = int24(bound(tick, TickMath.MIN_TICK, TickMath.MAX_TICK));
        int24 s = int24(int256(bound(spacingSeed, 1, uint256(int256(TickMath.MAX_TICK_SPACING)))));
        int24 f = Orient.floorTo(tick, s);
        int24 c = Orient.ceilTo(tick, s);
        assertEq(f % s, 0, "floor aligned");
        assertEq(c % s, 0, "ceil aligned");
        assertLe(f, tick);
        assertGt(int256(f) + s, int256(tick));
        assertGe(c, tick);
        assertLt(int256(c) - s, int256(tick));
        if (tick % s == 0) {
            assertEq(f, tick);
            assertEq(c, tick);
        }
    }

    function testFuzz_conversionsAreInvolutions(int24 lo, int24 width, bool quoteIs0) public pure {
        lo = int24(bound(lo, TickMath.MIN_TICK, TickMath.MAX_TICK - 1));
        int24 hi = int24(bound(width, int256(lo) + 1, TickMath.MAX_TICK));
        assertEq(Orient.toPool(quoteIs0, Orient.toPrice(quoteIs0, lo)), lo);
        (int24 pl, int24 pu) = Orient.rangeToPrice(quoteIs0, lo, hi);
        assertLt(pl, pu, "stays ordered");
        (int24 l2, int24 h2) = Orient.rangeToPool(quoteIs0, pl, pu);
        assertEq(l2, lo);
        assertEq(h2, hi);
        (uint256 q, uint256 t) = Orient.split(quoteIs0, 1, 2);
        (uint256 a0, uint256 a1) = Orient.join(quoteIs0, q, t);
        assertEq(a0, 1);
        assertEq(a1, 2);
    }

    /// @notice The convention the vault relies on: with the price above a range (in price ticks) the range holds
    ///         only quote; below it, only tokens. Checked against real position math in both orientations.
    function testFuzz_priceTicksMeanBidsBelowAsksAbove(int24 pl, uint16 widthSeed, uint16 gapSeed, bool quoteIs0)
        public
        pure
    {
        pl = int24(bound(pl, -300_000, 300_000));
        int24 pu = pl + int24(int256(bound(widthSeed, 1, 20_000)));
        int24 gap = int24(int256(bound(gapSeed, 1, 20_000)));

        (uint256 quote, uint256 token) = _holdings(quoteIs0, pl, pu, pu + gap);
        assertGt(quote, 0, "bid below the price holds quote");
        assertEq(token, 0, "and no tokens");

        (quote, token) = _holdings(quoteIs0, pl, pu, pl - gap);
        assertEq(quote, 0, "ask above the price holds no quote");
        assertGt(token, 0, "only tokens");
    }

    /// @dev What a price-tick range [pl, pu] holds when the price tick is `price`.
    function _holdings(bool quoteIs0, int24 pl, int24 pu, int24 price)
        internal
        pure
        returns (uint256 quote, uint256 token)
    {
        (int24 lo, int24 hi) = Orient.rangeToPool(quoteIs0, pl, pu);
        (uint256 a0, uint256 a1) =
            RangeMath.amounts(TickMath.getSqrtPriceAtTick(Orient.toPool(quoteIs0, price)), lo, hi, 1e20);
        return Orient.split(quoteIs0, a0, a1);
    }
}
