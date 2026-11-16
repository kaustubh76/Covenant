// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {RangeMath} from "../../src/libraries/RangeMath.sol";
import {Orient} from "../../src/libraries/Orient.sol";

contract RangeMathTest is Test, Deployers {
    int24 constant SPACING = 60; // Deployers uses fee/100*2 for static fees: 3000 -> 60

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
    }

    /// @notice What RangeMath says a position holds is exactly what the PoolManager pays to remove it, and adding
    ///         the same liquidity costs at most one wei more per currency.
    function testFuzz_amountsEqualWhatRemovalPays(int24 lowerSeed, uint16 widthSeed, uint128 liqSeed, int24 priceSeed)
        public
    {
        int24 lower = Orient.floorTo(int24(bound(lowerSeed, -200_000, 200_000)), SPACING);
        int24 upper = lower + SPACING * int24(int256(bound(widthSeed, 1, 3000)));
        int24 priceTick = int24(bound(priceSeed, int256(lower) - 5000, int256(upper) + 5000));
        _checkRoundTrip(TickMath.getSqrtPriceAtTick(priceTick), lower, upper, uint128(bound(liqSeed, 1e3, 1e24)));
    }

    function _checkRoundTrip(uint160 sqrtP, int24 lower, int24 upper, uint128 liquidity) internal {
        (key,) = initPool(currency0, currency1, IHooks(address(0)), 3000, sqrtP);
        int256 l = int256(uint256(liquidity));
        BalanceDelta added = modifyLiquidityNoChecks.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, l, 0), "");
        BalanceDelta removed =
            modifyLiquidityNoChecks.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, -l, 0), "");

        (uint256 a0, uint256 a1) = RangeMath.amounts(sqrtP, lower, upper, liquidity);
        assertEq(uint256(int256(removed.amount0())), a0, "removal pays amount0 exactly");
        assertEq(uint256(int256(removed.amount1())), a1, "removal pays amount1 exactly");
        assertLe(uint256(-int256(added.amount0())) - a0, 1, "adding costs at most 1 wei more of currency0");
        assertLe(uint256(-int256(added.amount1())) - a1, 1, "adding costs at most 1 wei more of currency1");
    }

    /// @notice quoteBetween is the quote a range holds once the price is above it, in both orientations.
    function testFuzz_quoteBetweenIsTheBidSide(int24 aSeed, uint16 widthSeed, uint128 liqSeed) public pure {
        int24 a = int24(bound(aSeed, -400_000, 400_000));
        int24 b = a + int24(int256(bound(widthSeed, 1, 60_000)));
        uint128 liquidity = uint128(bound(liqSeed, 1, 1e30));

        // quote is currency0: price ticks [a, b] are pool ticks [-b, -a]; price >= b means pool tick <= -b
        (uint256 q0,) = RangeMath.amounts(TickMath.getSqrtPriceAtTick(-b), -b, -a, liquidity);
        assertEq(RangeMath.quoteBetween(true, liquidity, a, b), q0, "quote = currency0");

        // quote is currency1: same ticks; price >= b means pool tick >= b
        (, uint256 q1) = RangeMath.amounts(TickMath.getSqrtPriceAtTick(b), a, b, liquidity);
        assertEq(RangeMath.quoteBetween(false, liquidity, a, b), q1, "quote = currency1");
    }

    function test_quoteBetweenEmptyAndInvertedIntervalsHoldNothing() public pure {
        assertEq(RangeMath.quoteBetween(true, 1e18, 100, 100), 0);
        assertEq(RangeMath.quoteBetween(false, 1e18, 100, -100), 0);
        assertEq(RangeMath.quoteBetween(true, 0, -100, 100), 0);
    }

    /// @notice The same token price reads the same in either orientation.
    function testFuzz_tokenToQuoteAgreesAcrossOrientations(int24 priceTick, uint96 amount) public pure {
        priceTick = int24(bound(priceTick, -200_000, 200_000));
        // token price in quote = 1.0001^priceTick in both setups
        uint256 viaQuote0 = RangeMath.tokenToQuote(true, amount, TickMath.getSqrtPriceAtTick(-priceTick));
        uint256 viaQuote1 = RangeMath.tokenToQuote(false, amount, TickMath.getSqrtPriceAtTick(priceTick));
        assertApproxEqRel(viaQuote0, viaQuote1, 1e10, "orientations agree to 1e-8");
    }

    function test_tokenToQuoteKnownPrices() public pure {
        // price tick 0: one token = one quote
        assertApproxEqAbs(RangeMath.tokenToQuote(true, 1e18, TickMath.getSqrtPriceAtTick(0)), 1e18, 1);
        // price tick 6932: 1.0001^6932 = 2.0000
        assertApproxEqRel(RangeMath.tokenToQuote(false, 1e18, TickMath.getSqrtPriceAtTick(6932)), 2e18, 1e14);
        assertApproxEqRel(RangeMath.tokenToQuote(true, 1e18, TickMath.getSqrtPriceAtTick(-6932)), 2e18, 1e14);
        assertEq(RangeMath.tokenToQuote(true, 0, TickMath.getSqrtPriceAtTick(500)), 0);
    }
}
