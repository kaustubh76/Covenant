// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {Terms, Range, Cut, Leg} from "../types/CovenantTypes.sol";
import {Orient} from "./Orient.sol";
import {RangeMath} from "./RangeMath.sol";
import {PaceLib} from "./PaceLib.sol";

/// @title CovenantLogic
/// @notice The vault's rule arithmetic: Support, the Anchor, valuation, restore targets, leg validation, sizing.
/// @dev An external library, deployed once per chain and linked into the vault implementation. Clones reach it
///      through the implementation's DELEGATECALL, so `Range[] storage` arguments are each vault's own storage.
///      Everything here is a pure function of its inputs plus that storage; nothing writes state.
library CovenantLogic {
    uint16 internal constant SINK = type(uint16).max;

    error InvalidCut(uint256 index);
    error InvalidLeg(uint256 index);
    error SharesExceedWhole();
    error RestoreBandEmpty(int24 bottomPriceTick, int24 topPriceTick);

    // ------------------------------------------------------------------------------------------------ Support

    /// @notice Share of quote, at the TWAP price, sitting between the TWAP and B below min(TWAP, Anchor). In bps.
    /// @dev Idle quote counts in the total and never in the band, so leaving quote idle cannot help Support.
    function supportBps(Range[] storage ranges, bool q0, int24 twapPrice, int24 anchor, int24 band, uint256 idleQuote)
        public
        view
        returns (uint256)
    {
        int24 bottom = (anchor < twapPrice ? anchor : twapPrice) - band;
        uint256 total = idleQuote;
        uint256 inBand;
        uint256 n = ranges.length;
        for (uint256 i; i < n; i++) {
            Range memory r = ranges[i];
            (int24 pl, int24 pu) = Orient.rangeToPrice(q0, r.tickLower, r.tickUpper);
            int24 hi = pu < twapPrice ? pu : twapPrice;
            total += RangeMath.quoteBetween(q0, r.liquidity, pl, hi);
            inBand += RangeMath.quoteBetween(q0, r.liquidity, pl > bottom ? pl : bottom, hi);
        }
        return total == 0 ? 1e4 : inBand * 1e4 / total;
    }

    // ------------------------------------------------------------------------------------------------ Anchor

    /// @notice The Anchor after a sync at `timestamp`.
    /// @dev Above the Anchor the TWAP pulls it up by at most B per epoch. Only the last W seconds since the previous
    ///      sync count, so a quiet period cannot bank allowance for a later jump; the fraction of a tick not yet
    ///      earned carries over through the returned timestamp. More than G below it, the Anchor drops to G above
    ///      the TWAP at once.
    function anchorAt(int24 current, uint64 updatedAt, int24 twapPrice, Terms memory t, uint256 timestamp)
        public
        pure
        returns (int24 a, uint64 newUpdatedAt)
    {
        a = current;
        newUpdatedAt = uint64(timestamp);
        if (twapPrice > a) {
            uint256 band = uint256(int256(t.supportBandTicks));
            uint256 elapsed = timestamp - updatedAt;
            uint256 credited = elapsed < t.twapWindow ? elapsed : t.twapWindow;
            uint256 rise = band * credited / t.epochLength;
            if (rise >= uint256(int256(twapPrice) - int256(a))) {
                a = twapPrice;
            } else {
                a += int24(int256(rise));
                newUpdatedAt -= uint64(credited - rise * t.epochLength / band);
            }
        } else if (int256(twapPrice) < int256(a) - t.guardTicks) {
            a = twapPrice + t.guardTicks;
        }
    }

    // ------------------------------------------------------------------------------------------------ valuation

    /// @notice Value in quote of `liquidity` over [lower, upper] at `sqrtPrice`.
    function valueOf(bool q0, uint160 sqrtPrice, int24 lower, int24 upper, uint128 liquidity)
        public
        pure
        returns (uint256)
    {
        (uint256 a0, uint256 a1) = RangeMath.amounts(sqrtPrice, lower, upper, liquidity);
        (uint256 quote, uint256 token) = Orient.split(q0, a0, a1);
        return quote + RangeMath.tokenToQuote(q0, token, sqrtPrice);
    }

    /// @notice Everything the vault holds as principal (ranges plus idle), valued in quote at `tick`.
    function totalValue(Range[] storage ranges, bool q0, int24 tick, uint256 idle0, uint256 idle1)
        public
        view
        returns (uint256 v)
    {
        uint160 sqrtPrice = TickMath.getSqrtPriceAtTick(tick);
        uint256 n = ranges.length;
        for (uint256 i; i < n; i++) {
            Range memory r = ranges[i];
            v += valueOf(q0, sqrtPrice, r.tickLower, r.tickUpper, r.liquidity);
        }
        (uint256 quote, uint256 token) = Orient.split(q0, idle0, idle1);
        v += quote + RangeMath.tokenToQuote(q0, token, sqrtPrice);
    }

    /// @notice Fraction of vault value (at `twapTick`) the cuts remove, in units of PaceLib.ONE. Validates the cuts:
    ///         indices strictly increasing and in range, and each removing something.
    function cutFraction(
        Range[] storage ranges,
        Cut[] calldata cuts,
        bool q0,
        int24 twapTick,
        uint256 idle0,
        uint256 idle1
    ) public view returns (uint256) {
        uint160 sqrtTwap = TickMath.getSqrtPriceAtTick(twapTick);
        uint256 len = ranges.length;
        uint256 moved;
        for (uint256 i; i < cuts.length; i++) {
            uint256 idx = cuts[i].index;
            if (idx >= len || (i > 0 && idx <= cuts[i - 1].index)) revert InvalidCut(idx);
            Range memory r = ranges[idx];
            uint128 liquidity = cuts[i].liquidity < r.liquidity ? cuts[i].liquidity : r.liquidity;
            if (liquidity == 0) revert InvalidCut(idx);
            moved += valueOf(q0, sqrtTwap, r.tickLower, r.tickUpper, liquidity);
        }
        return PaceLib.fraction(moved, totalValue(ranges, q0, twapTick, idle0, idle1));
    }

    // ------------------------------------------------------------------------------------------------ restore

    /// @notice Where restore puts things: the band in pool ticks, and the lowest price tick an ask may start at.
    /// @dev The band runs from B below min(TWAP, Anchor) up to the highest aligned tick that is all of:
    ///      - under the spot price, so the range holds only quote;
    ///      - at or under the TWAP and the bid ceiling Anchor + G;
    ///      - at or under the top of the highest range the vault already holds (`vaultTop`, see spanTop).
    ///      The last bound is what makes restore safe to leave permissionless. Whatever pushed the price up, restore
    ///      can only bid where the vault has already offered tokens, so anyone who bought those tokens can sell them
    ///      back for at most what they paid. Without it, a price held up through empty ticks long enough would drag
    ///      the band, and then restore, up behind it.
    function restoreTargets(
        bool q0,
        int24 spacing,
        int24 spotTick,
        int24 twapPrice,
        int24 anchor,
        int24 vaultTop,
        Terms memory t
    ) public pure returns (int24 bandLower, int24 bandUpper, int24 askFloor) {
        int24 spotPrice = Orient.toPrice(q0, spotTick);
        // A quote-only range must end below the price and a token-only range must start above it. Which side of the
        // spot tick counts as "at the price" depends on orientation, because v4 compares ticks, not prices.
        askFloor = Orient.ceilTo(q0 ? spotPrice : spotPrice + 1, spacing);
        int24 top = q0 ? spotPrice - 1 : spotPrice;
        if (twapPrice < top) top = twapPrice;
        if (anchor + t.guardTicks < top) top = anchor + t.guardTicks;
        if (vaultTop < top) top = vaultTop;
        top = Orient.floorTo(top, spacing);
        int24 bottom = Orient.ceilTo((anchor < twapPrice ? anchor : twapPrice) - t.supportBandTicks, spacing);
        if (top <= bottom) revert RestoreBandEmpty(bottom, top);
        (bandLower, bandUpper) = Orient.rangeToPool(q0, bottom, top);
    }

    /// @notice Highest price tick any of the vault's ranges reaches.
    function spanTop(Range[] storage ranges, bool q0) public view returns (int24 top) {
        top = type(int24).min;
        uint256 n = ranges.length;
        for (uint256 i; i < n; i++) {
            (, int24 pu) = Orient.rangeToPrice(q0, ranges[i].tickLower, ranges[i].tickUpper);
            if (pu > top) top = pu;
        }
    }

    // ------------------------------------------------------------------------------------------------ reshape

    /// @notice Check every leg and find the sinks. A sink takes all of one currency left after the other legs.
    /// @return sink0 Index of the currency0 sink, or type(uint256).max.
    /// @return sink1 Index of the currency1 sink, or type(uint256).max.
    function validateLegs(int24 spacing, Leg[] calldata legs) public pure returns (uint256 sink0, uint256 sink1) {
        sink0 = type(uint256).max;
        sink1 = type(uint256).max;
        uint256 sum0;
        uint256 sum1;
        int24 minTick = TickMath.minUsableTick(spacing);
        int24 maxTick = TickMath.maxUsableTick(spacing);
        for (uint256 i; i < legs.length; i++) {
            Leg calldata leg = legs[i];
            if (
                leg.tickLower >= leg.tickUpper || leg.tickLower < minTick || leg.tickUpper > maxTick
                    || leg.tickLower % spacing != 0 || leg.tickUpper % spacing != 0
            ) revert InvalidLeg(i);
            if (leg.share0 == SINK) {
                if (sink0 != type(uint256).max || leg.share1 != 0) revert InvalidLeg(i);
                sink0 = i;
            } else if (leg.share1 == SINK) {
                if (sink1 != type(uint256).max || leg.share0 != 0) revert InvalidLeg(i);
                sink1 = i;
            } else {
                sum0 += leg.share0;
                sum1 += leg.share1;
            }
        }
        if (sum0 > 1e4 || sum1 > 1e4) revert SharesExceedWhole();
    }

    // ------------------------------------------------------------------------------------------------ sizing

    /// @notice Most liquidity [lower, upper] can take from `amount0`/`amount1` at `sqrtPrice`. Rounded down.
    function liquidityFor(uint160 sqrtPrice, int24 lower, int24 upper, uint256 amount0, uint256 amount1)
        public
        pure
        returns (uint128)
    {
        return LiquidityAmounts.getLiquidityForAmounts(
            sqrtPrice, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount0, amount1
        );
    }

    /// @notice What `liquidity` over [lower, upper] holds at `sqrtPrice`, as removal would pay it.
    function amounts(uint160 sqrtPrice, int24 lower, int24 upper, uint128 liquidity)
        public
        pure
        returns (uint256, uint256)
    {
        return RangeMath.amounts(sqrtPrice, lower, upper, liquidity);
    }
}
