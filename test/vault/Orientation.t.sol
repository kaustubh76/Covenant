// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {ICovenantVault} from "../../src/interfaces/ICovenantVault.sol";
import {Range, Cut, Leg} from "../../src/types/CovenantTypes.sol";
import {Orient} from "../../src/libraries/Orient.sol";
import {RangeMath} from "../../src/libraries/RangeMath.sol";
import {CovenantTestBase} from "../base/CovenantTestBase.sol";
import {TestToken} from "../base/TestToken.sol";
import {Presets} from "../base/Presets.sol";

/// @notice The rules most sensitive to pool orientation, run once per orientation. With the quote as currency1
///         every comparison between ticks flips, and v4 decides which side of a range holds which currency by tick,
///         not by price. This is where an orientation bug would hide.
abstract contract OrientationCases is CovenantTestBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    int24 internal constant OPEN = 2600; // price tick 2600: 1.297 quote per token, as the default auction clears
    int24 seedPrice;

    function _orientation() internal pure virtual returns (bool nativeQuote, bool quoteIsCurrency0);

    function setUp() public override {
        super.setUp();
        (bool nativeQuote, bool quoteIsCurrency0) = _orientation();
        _launchDirect(Presets.standard(), nativeQuote, quoteIsCurrency0, OPEN);
        seedPrice = _spotPrice();
        assertEq(seedPrice, OPEN);
        _honestSeed();
        _fundBounty(1 ether);
        _wait(1 hours);
    }

    function test_orientation_seedConcentratesConservesAndPasses() public view {
        (uint256 have, uint256 need) = vault.support();
        assertGe(have, need);
        assertEq(vault.rangeCount(), 4);
        _assertPositionsMatchPoolManager();
        _assertSolvent();
        // bids hold only quote and sit under the price; asks hold only tokens and sit over it
        (uint160 sqrtP,,,) = PM.getSlot0(key.toId());
        for (uint256 i; i < vault.rangeCount(); i++) {
            Range memory r = vault.rangeAt(i);
            (int24 pl, int24 pu) = Orient.rangeToPrice(q0, r.tickLower, r.tickUpper);
            (uint256 a0, uint256 a1) = RangeMath.amounts(sqrtP, r.tickLower, r.tickUpper, r.liquidity);
            (uint256 quote, uint256 tk) = Orient.split(q0, a0, a1);
            if (pu < seedPrice) assertEq(tk, 0, "a bid holds no tokens");
            if (pl > seedPrice) assertEq(quote, 0, "an ask holds no quote");
        }
    }

    function test_orientation_dumpLapsesSupportAndRestoreRepairsIt() public {
        _swapToTick(key, attacker, Orient.toPool(q0, seedPrice - 3000), 100_000 ether);
        _settleTwap();
        (uint256 have, uint256 need) = vault.support();
        assertLt(have, need, "lapsed");
        int24 lowestAsk = _lowestAsk();

        uint256[] memory idx = _quoteRangesBelowTheBand();
        uint256 before = _quoteBalance(keeper);
        vm.prank(keeper);
        vault.restore(idx, NEVER);
        (uint256 after_,) = vault.support();
        assertGe(after_, need, "restored");
        assertEq(_quoteBalance(keeper) - before, terms.bounty, "bounty in the quote asset");
        assertGe(_lowestAsk(), lowestAsk, "no ask moved down");
        _assertPositionsMatchPoolManager();
        _assertSolvent();
    }

    function test_orientation_quickPumpFindsNothingToRestore() public {
        (uint256 quoteBefore,) = _principal();
        _swapToTick(key, attacker, Orient.toPool(q0, seedPrice + 30_000), 100_000 ether);
        _wait(2 hours);
        uint256[] memory idx = _quoteRanges();
        vm.prank(attacker);
        vm.expectPartialRevert(ICovenantVault.NothingToRestore.selector);
        vault.restore(idx, NEVER);
        _sellAllTokens(attacker);
        (uint256 quoteAfter,) = _principal();
        assertGe(quoteAfter + 1e9, quoteBefore, "the vault keeps its quote");
    }

    function test_orientation_patientPumpCannotDragRestore() public {
        _swapToTick(key, attacker, Orient.toPool(q0, seedPrice + 30_000), 100_000 ether);
        _keepPoked(4 days);
        (uint256 have, uint256 need) = vault.support();
        assertLt(have, need);
        uint256[] memory idx = _quoteRanges();
        vm.prank(attacker);
        vm.expectPartialRevert(ICovenantVault.RestoreBandEmpty.selector);
        vault.restore(idx, NEVER);
    }

    function test_orientation_bidCeilingHoldsAfterAPump() public {
        _swapToTick(key, attacker, Orient.toPool(q0, seedPrice + 15_000), 100_000 ether);
        _settleTwap();
        int24 p = _spotPrice();
        (uint256 idx,) = _rangeWithMostQuote();
        Cut[] memory cuts = new Cut[](1);
        cuts[0] = Cut(idx, vault.rangeAt(idx).liquidity / 4);
        Leg[] memory legs = new Leg[](1);
        legs[0] = _bid(p - 900, p - 120, SINK);
        vm.prank(curator);
        vm.expectPartialRevert(ICovenantVault.BidAboveCeiling.selector);
        vault.reshape(cuts, legs, NEVER);
    }

    function test_orientation_lpRoundTripIsProportional() public {
        _wait(1 days);
        address who = lp;
        _fundLp(who);
        (uint256 q, uint256 t) = _principal();
        uint256 value = key.currency0.isAddressZero() ? 1000 ether : 0;
        vm.prank(who);
        (uint256 p0, uint256 p1) = vault.deposit{value: value}(1e17, type(uint256).max, type(uint256).max, NEVER);
        (uint256 pq, uint256 pt) = Orient.split(q0, p0, p1);
        assertApproxEqRel(pq, q / 10, 1e12);
        assertApproxEqRel(pt, t / 10, 1e12);
        vm.prank(who);
        (uint256 g0, uint256 g1) = vault.withdraw(1e17, 0, 0, NEVER);
        assertLe(g0, p0);
        assertLe(g1, p1);
        assertApproxEqAbs(g0, p0, 20);
        assertApproxEqAbs(g1, p1, 20);
    }

    function test_orientation_guardBlocksAfterASpike() public {
        _swapToTick(key, attacker, Orient.toPool(q0, seedPrice - 1500), 100_000 ether);
        Cut[] memory cuts = new Cut[](1);
        cuts[0] = Cut(0, 1);
        vm.prank(curator);
        vm.expectPartialRevert(ICovenantVault.PriceGuard.selector);
        vault.reshape(cuts, new Leg[](0), NEVER);
    }

    function test_orientation_anchorFollowsDropAndClimbsSlowly() public {
        _swapToTick(key, attacker, Orient.toPool(q0, seedPrice - 3000), 100_000 ether);
        _settleTwap();
        assertEq(vault.poke(), _twapPrice() + terms.guardTicks, "follows a drop at once");
        int24 low = vault.anchor();
        _swapToTick(key, attacker, Orient.toPool(q0, seedPrice + 20_000), 1_000_000 ether);
        _keepPoked(1 days);
        assertLe(int256(vault.anchor()) - low, int256(terms.supportBandTicks) + 31, "climbs one band per day");
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _quote() internal view returns (Currency) {
        return q0 ? key.currency0 : key.currency1;
    }

    function _quoteBalance(address who) internal view returns (uint256) {
        return _quote().balanceOf(who);
    }

    function _fundBounty(uint256 amount) internal {
        Currency quote = _quote();
        if (quote.isAddressZero()) {
            vm.deal(address(this), address(this).balance + amount);
            vault.fundBounty{value: amount}(amount);
        } else {
            TestToken(Currency.unwrap(quote)).mint(address(this), amount);
            TestToken(Currency.unwrap(quote)).approve(address(vault), amount);
            vault.fundBounty(amount);
        }
    }

    function _fundLp(address who) internal {
        vm.deal(who, 10_000 ether);
        for (uint256 i; i < 2; i++) {
            Currency c = i == 0 ? key.currency0 : key.currency1;
            if (c.isAddressZero()) continue;
            TestToken(Currency.unwrap(c)).mint(who, 10_000 ether);
            vm.prank(who);
            TestToken(Currency.unwrap(c)).approve(address(vault), type(uint256).max);
        }
    }

    function _sellAllTokens(address who) internal {
        uint256 amount = token.balanceOf(who);
        if (amount > 0) _swap(key, who, Currency.unwrap(key.currency0) == address(token), amount, 0);
    }

    function _quoteRanges() internal view returns (uint256[] memory idx) {
        int24 spot = _spotPrice();
        uint256 n = vault.rangeCount();
        uint256[] memory tmp = new uint256[](n);
        uint256 k;
        for (uint256 i; i < n; i++) {
            Range memory r = vault.rangeAt(i);
            (int24 pl,) = Orient.rangeToPrice(q0, r.tickLower, r.tickUpper);
            if (pl < spot) tmp[k++] = i;
        }
        idx = new uint256[](k);
        for (uint256 i; i < k; i++) {
            idx[i] = tmp[i];
        }
    }

    function _quoteRangesBelowTheBand() internal view returns (uint256[] memory idx) {
        int24 a = vault.anchor();
        int24 t = _twapPrice();
        int24 bottom = (a < t ? a : t) - terms.supportBandTicks;
        uint256 n = vault.rangeCount();
        uint256[] memory tmp = new uint256[](n);
        uint256 k;
        for (uint256 i; i < n; i++) {
            Range memory r = vault.rangeAt(i);
            (int24 pl,) = Orient.rangeToPrice(q0, r.tickLower, r.tickUpper);
            if (pl < bottom && pl < t) tmp[k++] = i;
        }
        idx = new uint256[](k);
        for (uint256 i; i < k; i++) {
            idx[i] = tmp[i];
        }
    }

    function _rangeWithMostQuote() internal view returns (uint256 best, uint256 most) {
        (uint160 sqrtP,,,) = PM.getSlot0(key.toId());
        for (uint256 i; i < vault.rangeCount(); i++) {
            Range memory r = vault.rangeAt(i);
            (uint256 a0, uint256 a1) = RangeMath.amounts(sqrtP, r.tickLower, r.tickUpper, r.liquidity);
            (uint256 q,) = Orient.split(q0, a0, a1);
            if (q > most) (most, best) = (q, i);
        }
    }

    function _lowestAsk() internal view returns (int24 lowest) {
        lowest = type(int24).max;
        (uint160 sqrtP,,,) = PM.getSlot0(key.toId());
        int24 spot = _spotPrice();
        for (uint256 i; i < vault.rangeCount(); i++) {
            Range memory r = vault.rangeAt(i);
            (uint256 a0, uint256 a1) = RangeMath.amounts(sqrtP, r.tickLower, r.tickUpper, r.liquidity);
            (, uint256 tk) = Orient.split(q0, a0, a1);
            if (tk == 0) continue;
            (int24 pl,) = Orient.rangeToPrice(q0, r.tickLower, r.tickUpper);
            int24 from = pl > spot ? pl : spot;
            if (from < lowest) lowest = from;
        }
    }
}

/// @notice Native ETH quote (always currency0).
contract Orientation_NativeQuote is OrientationCases {
    function _orientation() internal pure override returns (bool, bool) {
        return (true, true);
    }
}

/// @notice ERC20 quote that sorts before the token (currency0), e.g. USDC paired with a token at a higher address.
contract Orientation_TokenQuoteAsCurrency0 is OrientationCases {
    function _orientation() internal pure override returns (bool, bool) {
        return (false, true);
    }
}

/// @notice ERC20 quote that sorts after the token (currency1). Every tick comparison flips.
contract Orientation_TokenQuoteAsCurrency1 is OrientationCases {
    function _orientation() internal pure override returns (bool, bool) {
        return (false, false);
    }
}
