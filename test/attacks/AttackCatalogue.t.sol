// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTestNoChecks} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTestNoChecks.sol";

import {ICovenantVault} from "../../src/interfaces/ICovenantVault.sol";
import {Range, Cut, Leg} from "../../src/types/CovenantTypes.sol";
import {Orient} from "../../src/libraries/Orient.sol";
import {CovenantTestBase} from "../base/CovenantTestBase.sol";
import {Presets} from "../base/Presets.sol";

/// @notice One test per row of the spec's attack catalogue (docs/SPEC.md section 13.2), then the attacks found while
///         building this version. Each test is named after the attack and asserts the exact revert or outcome.
contract AttackCatalogueTest is CovenantTestBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    int24 seedPrice;

    function setUp() public override {
        super.setUp();
        _launch(Presets.standard());
        seedPrice = _spotPrice();
        _honestSeed();
        vm.deal(address(this), 100 ether);
        vault.fundBounty{value: 1 ether}(1 ether);
        _wait(1 hours);
    }

    // =========================================================================================== spec section 13.2

    /// @notice "Curator withdraws principal": there is no code path. The curator holds no shares, is not the
    ///         issuer, and a reshape can only move value between ranges.
    function test_13_2_01_curatorCannotWithdrawPrincipal() public {
        vm.startPrank(curator);
        vm.expectRevert(abi.encodeWithSelector(ICovenantVault.InsufficientShares.selector, 0, 1));
        vault.withdraw(1, 0, 0, NEVER);
        vm.expectRevert(ICovenantVault.NotIssuer.selector);
        vault.withdrawPrincipal(1, 0, 0, NEVER);
        vm.stopPrank();
        assertEq(curator.balance, 0);
        assertEq(token.balanceOf(curator), 0);
    }

    /// @notice "Curator skims (re-adds less than removed)": what is not re-added may not even sit idle.
    function test_13_2_02_curatorCannotSkim() public {
        Cut[] memory cuts = new Cut[](1);
        cuts[0] = Cut(_indexOfLeg(1), type(uint128).max);
        Leg[] memory legs = new Leg[](1);
        legs[0] = _bid(seedPrice - 1440, seedPrice - 180, 9000); // re-add 90%
        vm.prank(curator);
        vm.expectPartialRevert(ICovenantVault.IdleTooLarge.selector);
        vault.reshape(cuts, legs, NEVER);
    }

    /// @notice "Soft rug (support moved far from price)".
    function test_13_2_03_softRugIsRejected() public {
        Cut[] memory cuts = new Cut[](1);
        cuts[0] = Cut(_indexOfLeg(1), type(uint128).max);
        Leg[] memory legs = new Leg[](1);
        legs[0] = _bid(seedPrice - 12_000, seedPrice - 9000, SINK);
        vm.prank(curator);
        vm.expectPartialRevert(ICovenantVault.SupportBroken.selector);
        vault.reshape(cuts, legs, NEVER);
    }

    /// @notice "Spot manipulation then reshape/deposit/restore": the Guard blocks all three.
    function test_13_2_04_manipulatedSpotBlocksEveryStateChange() public {
        _wait(1 days); // past the setup epoch so deposits are otherwise open
        _fund(lp);
        _swapToTick(key, attacker, Orient.toPool(q0, _spotPrice() - 2000), 100_000 ether);

        Cut[] memory cuts = new Cut[](1);
        cuts[0] = Cut(0, 1);
        vm.prank(curator);
        vm.expectPartialRevert(ICovenantVault.PriceGuard.selector);
        vault.reshape(cuts, new Leg[](0), NEVER);

        vm.prank(lp);
        vm.expectPartialRevert(ICovenantVault.PriceGuard.selector);
        vault.deposit{value: 50 ether}(1e17, type(uint256).max, type(uint256).max, NEVER);

        uint256[] memory idx = new uint256[](1);
        vm.prank(keeper);
        vm.expectPartialRevert(ICovenantVault.PriceGuard.selector);
        vault.restore(idx, NEVER);
    }

    /// @notice "Flash round-trip to confuse the TWAP": same-block moves add no weight.
    function test_13_2_05_flashRoundTripHasNoEffect() public {
        int24 twapBefore = _twapPrice();
        uint160 home = _sqrtSpot();
        _swapToTick(key, attacker, Orient.toPool(q0, _spotPrice() - 5000), 100_000 ether);
        _buyTokens(attacker, 100_000 ether, home); // and straight back, same block
        assertEq(_twapPrice(), twapBefore, "TWAP unchanged");
        Cut[] memory cuts = new Cut[](1);
        cuts[0] = Cut(0, 1);
        vm.prank(curator);
        vault.reshape(cuts, new Leg[](0), NEVER); // Guard passes: nothing to see
    }

    /// @notice "Restructure the whole vault in one block".
    function test_13_2_06_wholeVaultInOneBlockExceedsPace() public {
        _wait(1 days);
        Cut[] memory cuts = _cutAll();
        Leg[] memory legs = _honestLegs(_spotPrice(), 6000);
        vm.prank(curator);
        vm.expectPartialRevert(ICovenantVault.PaceExceeded.selector);
        vault.reshape(cuts, legs, NEVER);
    }

    /// @notice "Replace the curator with a malicious one instantly": timelocked, then bound by the same rules.
    function test_13_2_07_curatorSwapIsTimelockedAndBound() public {
        address evil = makeAddr("evilCurator");
        vm.prank(issuer);
        vault.proposeCurator(evil);
        vm.expectPartialRevert(ICovenantVault.TimelockActive.selector);
        vault.acceptCurator();
        _wait(2 days);
        vault.acceptCurator();

        Cut[] memory cuts = new Cut[](1);
        cuts[0] = Cut(_indexOfLeg(1), type(uint128).max);
        Leg[] memory legs = new Leg[](1);
        legs[0] = _bid(seedPrice - 12_000, seedPrice - 9000, SINK);
        vm.prank(evil);
        vm.expectPartialRevert(ICovenantVault.SupportBroken.selector);
        vault.reshape(cuts, legs, NEVER);
    }

    /// @notice "Fragment into hundreds of ranges to grief gas".
    function test_13_2_08_fragmentationIsCapped() public {
        Cut[] memory cuts = new Cut[](1);
        cuts[0] = Cut(_indexOfLeg(2), type(uint128).max); // the reserve
        Leg[] memory legs = new Leg[](12);
        int24 top = seedPrice - 1500;
        for (uint256 i; i < 12; i++) {
            legs[i] = _bid(top - 60, top, i == 0 ? SINK : 500);
            top -= 60;
        }
        vm.prank(curator);
        vm.expectRevert(abi.encodeWithSelector(ICovenantVault.TooManyRanges.selector, 15, 14));
        vault.reshape(cuts, legs, NEVER);
    }

    /// @notice "Farm the restore bounty": healthy support pays nothing.
    function test_13_2_09_restoreBountyCannotBeFarmed() public {
        uint256[] memory idx = new uint256[](1);
        vm.prank(keeper);
        vm.expectPartialRevert(ICovenantVault.NothingToRestore.selector);
        vault.restore(idx, NEVER);
        assertEq(keeper.balance, 0);
    }

    /// @notice "Manipulate then mint cheap shares": blocked by the Guard, and in-kind shares have no price anyway.
    function test_13_2_10_noCheapShares() public {
        _wait(1 days);
        _fund(lp);
        (uint256 q, uint256 t) = _principal();
        vm.prank(lp);
        (uint256 p0, uint256 p1) = vault.deposit{value: 50 ether}(1e17, type(uint256).max, type(uint256).max, NEVER);
        (uint256 pq, uint256 pt) = Orient.split(q0, p0, p1);
        assertApproxEqRel(pq, q / 10, 1e12, "a tenth of the quote for a tenth of the shares");
        assertApproxEqRel(pt, t / 10, 1e12, "and a tenth of the tokens");
    }

    /// @notice "Outside LP exit damages holders": a proportional exit leaves the shape and the issuer untouched.
    function test_13_2_11_lpExitLeavesHoldersWhole() public {
        _wait(1 days);
        _fund(lp);
        vm.prank(lp);
        vault.deposit{value: 50 ether}(1e17, type(uint256).max, type(uint256).max, NEVER);
        (uint256 before,) = vault.support();
        vm.prank(lp);
        vault.withdraw(1e17, 0, 0, NEVER);
        (uint256 after_,) = vault.support();
        assertEq(after_, before);
        assertEq(vault.principalShares(), 1e18);
    }

    /// @notice "Big dump drains the support": the support buys the dump inside the pool. Nothing leaves the vault.
    function test_13_2_12_dumpIsAbsorbedNotLeaked() public {
        uint256 v0 = address(vault).balance;
        uint256 v1 = token.balanceOf(address(vault));
        (uint256 q, uint256 t) = _principal();
        _sellTokens(attacker, 20 ether);
        (uint256 q2, uint256 t2) = _principal();
        assertLt(q2, q, "support quote bought the dump");
        assertGt(t2, t, "the vault now holds those tokens in the pool");
        assertEq(address(vault).balance, v0, "nothing left the vault");
        assertEq(token.balanceOf(address(vault)), v1);
    }

    /// @notice "Early issuer withdrawal".
    function test_13_2_13_issuerCannotExitEarly() public {
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ICovenantVault.Locked.selector, 0, 1e18));
        vault.withdrawPrincipal(1e18, 0, 0, NEVER);
    }

    /// @notice "Outsider removes vault liquidity via PositionManager/PoolManager": positions are keyed to the vault.
    function test_13_2_14_outsiderCannotTouchVaultPositions() public {
        Range memory r = vault.rangeAt(0);
        PoolModifyLiquidityTestNoChecks router = new PoolModifyLiquidityTestNoChecks(PM);
        vm.prank(attacker);
        vm.expectRevert();
        router.modifyLiquidity(
            key, ModifyLiquidityParams(r.tickLower, r.tickUpper, -int256(uint256(r.liquidity)), 0), ""
        );
        _assertPositionsMatchPoolManager();
    }

    // =========================================================================================== found in this build

    /// @notice A curator colluding with a pumper cannot move bids up behind a price pushed through empty ticks.
    function test_new_colludingCuratorIsHeldToTheAnchor() public {
        _pumpThroughTheAsks(15_000);
        _settleTwap();
        int24 p = _spotPrice();
        Cut[] memory cuts = new Cut[](1);
        cuts[0] = Cut(_indexOfLeg(3), type(uint128).max); // the filled asks: quote now
        Leg[] memory legs = new Leg[](1);
        legs[0] = _bid(p - 900, p - 120, SINK);
        vm.prank(curator);
        vm.expectPartialRevert(ICovenantVault.BidAboveCeiling.selector);
        vault.reshape(cuts, legs, NEVER);
    }

    /// @notice Holding spot away from the TWAP would freeze every Guarded action. Exits are not Guarded.
    function test_new_exitsCannotBeFrozen() public {
        _wait(1 days);
        _fund(lp);
        vm.prank(lp);
        vault.deposit{value: 50 ether}(1e17, type(uint256).max, type(uint256).max, NEVER);
        _swapToTick(key, attacker, Orient.toPool(q0, _spotPrice() - 2500), 100_000 ether);
        vm.prank(lp);
        vault.withdraw(1e17, 0, 0, NEVER);
    }

    /// @notice A restore that moves only dust earns only dust: the bounty is capped at 1% of the quote moved.
    function test_new_dustRestorePaysDust() public {
        _dumpTo(_spotPrice() - 3000);
        _settleTwap();
        (uint256 have, uint256 need) = vault.support();
        assertLt(have, need);
        uint256[] memory idx = _quoteRangesBelowTheBand();
        uint256 before = keeper.balance;
        vm.recordLogs();
        vm.prank(keeper);
        vault.restore(idx, NEVER);
        uint256 paid = keeper.balance - before;
        assertLe(paid, terms.bounty, "never more than the bounty");
        assertGt(paid, 0);
    }

    /// @notice Native-ETH deposits must bring the ETH: the vault never pays for a depositor from its own balances.
    function test_new_depositCannotBeFundedByTheVault() public {
        _wait(1 days);
        _fund(lp);
        vm.prank(lp);
        vm.expectPartialRevert(ICovenantVault.InsufficientPayment.selector);
        vault.deposit{value: 1 ether}(1e17, type(uint256).max, type(uint256).max, NEVER);
        _assertSolvent();
    }

    // =========================================================================================== helpers

    function _fund(address who) internal {
        vm.deal(who, 10_000 ether);
        token.mint(who, 10_000 ether);
        vm.prank(who);
        token.approve(address(vault), type(uint256).max);
    }

    function _sqrtSpot() internal view returns (uint160 sqrtP) {
        (sqrtP,,,) = PM.getSlot0(key.toId());
    }

    /// @dev Exact-input sale of `amount` tokens for quote.
    function _sellTokens(address who, uint256 amount) internal {
        _swap(key, who, !q0, amount, 0);
    }

    /// @dev Exact-input purchase of tokens with `amount` quote, stopping at `limit` (0 = no limit).
    function _buyTokens(address who, uint256 amount, uint160 limit) internal {
        _swap(key, who, q0, amount, limit);
    }

    function _dumpTo(int24 target) internal {
        _swapToTick(key, attacker, Orient.toPool(q0, target), 100_000 ether);
    }

    /// @dev Buy every ask and keep going `ticks` above the seed price through empty ticks.
    function _pumpThroughTheAsks(int24 ticks) internal {
        _swapToTick(key, attacker, Orient.toPool(q0, seedPrice + ticks), 100_000 ether);
    }

    function _indexOfLeg(uint256 legIndex) internal view returns (uint256) {
        Leg memory leg = _honestLegs(seedPrice, 6000)[legIndex];
        for (uint256 i; i < vault.rangeCount(); i++) {
            Range memory r = vault.rangeAt(i);
            if (r.tickLower == leg.tickLower && r.tickUpper == leg.tickUpper) return i;
        }
        revert("leg not found");
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
}
