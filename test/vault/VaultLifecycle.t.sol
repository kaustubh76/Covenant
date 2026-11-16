// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";

import {ICovenantVault} from "../../src/interfaces/ICovenantVault.sol";
import {Range, Cut, Leg} from "../../src/types/CovenantTypes.sol";
import {Orient} from "../../src/libraries/Orient.sol";
import {RangeMath} from "../../src/libraries/RangeMath.sol";
import {CovenantTestBase} from "../base/CovenantTestBase.sol";
import {Presets} from "../base/Presets.sol";

contract VaultLifecycleTest is CovenantTestBase {
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
    }

    // =========================================================================================== restore

    /// @notice A dump carries the price into the reserve. Support lapses, a random keeper restores it, and is paid.
    function test_restore_anyoneRepairsSupportAfterADump() public {
        _dumpTo(_spotPrice() - 3000);
        _settleTwap();
        (uint256 have, uint256 need) = vault.support();
        emit log_named_uint("support after a 26% dump (bps)", have);
        assertLt(have, need, "support lapsed through price drift alone");

        uint256[] memory idx = _rangesHoldingQuoteOutsideTheBand();
        uint256 paidBefore = keeper.balance;
        vm.prank(keeper);
        vault.restore(idx, NEVER);

        (uint256 after_,) = vault.support();
        emit log_named_uint("support after restore (bps)", after_);
        assertGe(after_, need, "back above S");
        assertEq(keeper.balance - paidBefore, terms.bounty, "bounty paid");
        _assertPositionsMatchPoolManager();
        _assertSolvent();
    }

    /// @notice Restore moves quote up to the band. Tokens it touches keep their prices or move higher, never lower.
    function test_restore_neverSellsTokensCheaper() public {
        _dumpTo(_spotPrice() - 3000);
        _settleTwap();
        uint256[] memory idx = _rangesHoldingQuoteOutsideTheBand();
        int24 lowestAskBefore = _lowestAsk();
        vm.prank(keeper);
        vault.restore(idx, NEVER);
        assertGe(_lowestAsk(), lowestAskBefore, "asks never move down");
        assertGt(_lowestAsk(), _spotPrice(), "and stay above the price");
    }

    function test_restore_healthySupportPaysNothing() public {
        uint256[] memory idx = new uint256[](1);
        vm.prank(keeper);
        vm.expectPartialRevert(ICovenantVault.NothingToRestore.selector);
        vault.restore(idx, NEVER);
        assertEq(keeper.balance, 0);
    }

    function test_restore_rejectsRangesWithNoQuote() public {
        _dumpTo(_spotPrice() - 3000);
        _settleTwap();
        uint256[] memory idx = new uint256[](1);
        idx[0] = _indexOfLeg(3); // the asks: tokens only
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ICovenantVault.NoQuoteToRestore.selector, idx[0]));
        vault.restore(idx, NEVER);
    }

    // =========================================================================================== outside LPs

    function test_lp_depositAndWithdrawInKind() public {
        _wait(1 days + 1);
        _fund(lp);
        uint256 eth0 = lp.balance;
        uint256 tok0 = token.balanceOf(lp);
        (uint256 haveBefore,) = vault.support();
        uint128 activeBefore = PM.getLiquidity(key.toId());

        vm.prank(lp);
        (uint256 paid0, uint256 paid1) =
            vault.deposit{value: 50 ether}(1e17, type(uint256).max, type(uint256).max, NEVER);
        assertEq(vault.sharesOf(lp), 1e17);
        assertEq(vault.principalShares(), 1e18, "issuer principal untouched");
        assertEq(eth0 - lp.balance, paid0, "refunded the rest of the ETH");
        assertEq(tok0 - token.balanceOf(lp), paid1);
        assertApproxEqRel(PM.getLiquidity(key.toId()), uint256(activeBefore) * 11 / 10, 1e12, "+10% depth");
        (uint256 haveMid,) = vault.support();
        assertEq(haveMid, haveBefore, "shape unchanged");

        vm.prank(lp);
        (uint256 got0, uint256 got1) = vault.withdraw(1e17, 0, 0, NEVER);
        assertApproxEqAbs(got0, paid0, 20, "ETH back, less a few wei of rounding");
        assertApproxEqAbs(got1, paid1, 20, "tokens back");
        assertLe(got0, paid0, "never more than paid");
        assertLe(got1, paid1);
        (uint256 haveAfter,) = vault.support();
        assertEq(haveAfter, haveBefore, "holders' guarantee intact");
        _assertSolvent();
    }

    /// @notice Shares cost exactly their fraction of what the vault holds, so there is no price to manipulate.
    function test_lp_depositCostIsExactlyProportional() public {
        _wait(1 days + 1);
        _fund(lp);
        (uint256 quoteBefore, uint256 tokensBefore) = _principal();
        vm.prank(lp);
        (uint256 paid0, uint256 paid1) =
            vault.deposit{value: 50 ether}(1e17, type(uint256).max, type(uint256).max, NEVER);
        (uint256 pq, uint256 pt) = Orient.split(q0, paid0, paid1);
        assertApproxEqRel(pq, quoteBefore / 10, 1e12, "10% of the quote");
        assertApproxEqRel(pt, tokensBefore / 10, 1e12, "10% of the tokens");
    }

    function test_lp_cannotJoinDuringTheSetupEpoch() public {
        _fund(lp);
        vm.prank(lp);
        vm.expectPartialRevert(ICovenantVault.SetupEpoch.selector);
        vault.deposit{value: 50 ether}(1e17, type(uint256).max, type(uint256).max, NEVER);
    }

    function test_lp_cannotUnderpayInNativeEth() public {
        _wait(1 days + 1);
        _fund(lp);
        vm.prank(lp);
        vm.expectPartialRevert(ICovenantVault.InsufficientPayment.selector);
        vault.deposit{value: 1 wei}(1e17, type(uint256).max, type(uint256).max, NEVER);
    }

    function test_lp_slippageLimitsHold() public {
        _wait(1 days + 1);
        _fund(lp);
        vm.prank(lp);
        vm.expectPartialRevert(ICovenantVault.Slippage.selector);
        vault.deposit{value: 50 ether}(1e17, 1, type(uint256).max, NEVER);
    }

    /// @notice An exit never waits on the Guard: a proportional burn cannot hurt anyone left in the vault, and
    ///         blocking it would hand anyone who can move spot through empty ticks a free freeze on withdrawals.
    function test_lp_canExitEvenWhileTheGuardFails() public {
        _wait(1 days + 1);
        _fund(lp);
        vm.prank(lp);
        vault.deposit{value: 50 ether}(1e17, type(uint256).max, type(uint256).max, NEVER);
        _dumpTo(_spotPrice() - 2000); // spot now far from the TWAP
        vm.prank(lp);
        vault.withdraw(1e17, 0, 0, NEVER);
        assertEq(vault.sharesOf(lp), 0);
    }

    // =========================================================================================== release

    function test_release_principalVestsLinearlyAfterTheLock() public {
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ICovenantVault.Locked.selector, 0, 1));
        vault.withdrawPrincipal(1, 0, 0, NEVER);

        _wait(90 days + 15 days); // lock, then half the vest
        assertEq(vault.principalWithdrawable(), 5e17, "half vested");
        uint256 treasuryBefore = treasury.balance;
        vm.prank(issuer);
        vault.withdrawPrincipal(5e17, 0, 0, NEVER);
        assertGt(treasury.balance, treasuryBefore, "paid to the treasury");
        assertEq(vault.principalShares(), 5e17);

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ICovenantVault.Locked.selector, 0, 1e17));
        vault.withdrawPrincipal(1e17, 0, 0, NEVER);

        _wait(15 days);
        vm.prank(issuer);
        vault.withdrawPrincipal(5e17, 0, 0, NEVER);
        assertEq(vault.principalShares(), 0, "all principal released at the end of the vest");
    }

    function test_release_onlyTheIssuer() public {
        _wait(200 days);
        vm.prank(curator);
        vm.expectRevert(ICovenantVault.NotIssuer.selector);
        vault.withdrawPrincipal(1, 0, 0, NEVER);
    }

    // =========================================================================================== governance

    function test_curator_changeIsTimelockedAndTheNewCuratorIsBound() public {
        address next = makeAddr("nextCurator");
        vm.prank(issuer);
        vault.proposeCurator(next);
        vm.expectPartialRevert(ICovenantVault.TimelockActive.selector);
        vault.acceptCurator();

        _wait(2 days);
        vm.prank(keeper); // anyone finalises
        vault.acceptCurator();
        assertEq(vault.curator(), next);

        Cut[] memory cuts = new Cut[](1);
        cuts[0] = Cut(0, 1);
        vm.prank(curator);
        vm.expectRevert(ICovenantVault.NotCurator.selector);
        vault.reshape(cuts, new Leg[](0), NEVER);

        // Same rules for the new curator. Moving just the support band (well within pace) far below the price
        // breaks Support, so it reverts.
        _wait(1 days);
        uint256 supportIdx = _indexOfLeg(1);
        Cut[] memory cuts2 = new Cut[](1);
        cuts2[0] = Cut(supportIdx, type(uint128).max);
        int24 p = _spotPrice();
        Leg[] memory rug = new Leg[](1);
        rug[0] = _bid(p - 12_000, p - 9000, SINK);
        vm.prank(next);
        vm.expectPartialRevert(ICovenantVault.SupportBroken.selector);
        vault.reshape(cuts2, rug, NEVER);
    }

    function test_curator_onlyTheIssuerProposesAndCanCancel() public {
        vm.prank(attacker);
        vm.expectRevert(ICovenantVault.NotIssuer.selector);
        vault.proposeCurator(attacker);

        vm.startPrank(issuer);
        vault.proposeCurator(attacker);
        vault.cancelCuratorProposal();
        vm.stopPrank();
        _wait(3 days);
        vm.expectRevert(ICovenantVault.NoCuratorProposal.selector);
        vault.acceptCurator();
    }

    function test_issuer_transferIsTwoStep() public {
        address next = makeAddr("newIssuer");
        vm.prank(issuer);
        vault.transferIssuer(next);
        assertEq(vault.issuer(), issuer, "nothing changes until accepted");
        vm.prank(attacker);
        vm.expectRevert(ICovenantVault.NotPendingIssuer.selector);
        vault.acceptIssuer();
        vm.prank(next);
        vault.acceptIssuer();
        assertEq(vault.issuer(), next);
    }

    // =========================================================================================== fees

    function test_fees_areIncomeNotPrincipal() public {
        _wait(1 hours);
        for (uint256 i; i < 5; i++) {
            _swap(key, trader, false, 3 ether, 0);
            _swap(key, trader, true, 3 ether, 0);
        }
        (uint256 q, uint256 t) = _principal();
        uint256 bountyBefore = vault.bountyPool();
        uint256 treasury0 = treasury.balance;
        uint256 treasury1 = token.balanceOf(treasury);
        vault.collectFees();

        assertGt(treasury.balance - treasury0 + (vault.bountyPool() - bountyBefore), 0, "quote fees collected");
        assertGt(token.balanceOf(treasury) - treasury1, 0, "token fees to the treasury");
        (uint256 q2, uint256 t2) = _principal();
        assertEq(q2, q, "principal quote untouched");
        assertEq(t2, t, "principal tokens untouched");
        _assertSolvent();
    }

    function test_fees_topUpTheBountyPoolFirst() public {
        // drain the bounty pool below the reserve, then show fees refill it before the treasury is paid
        _dumpTo(_spotPrice() - 3000);
        _settleTwap();
        uint256[] memory idx = _rangesHoldingQuoteOutsideTheBand();
        vm.prank(keeper);
        vault.restore(idx, NEVER);
        for (uint256 i; i < 20; i++) {
            _swap(key, trader, false, 2 ether, 0);
            _swap(key, trader, true, 2 ether, 0);
        }
        vault.collectFees();
        assertGe(vault.bountyPool(), 3 * uint256(terms.bounty) - 1, "reserve of three bounties");
    }

    // =========================================================================================== misc

    function test_strayEthIsRefused() public {
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_poke_isPermissionless() public {
        vm.prank(attacker);
        vault.poke();
    }

    // =========================================================================================== helpers

    function _fund(address who) internal {
        vm.deal(who, 10_000 ether);
        token.mint(who, 10_000 ether);
        vm.prank(who);
        token.approve(address(vault), type(uint256).max);
    }

    /// @dev Sell tokens until the price tick is `target`.
    function _dumpTo(int24 target) internal {
        _swapToTick(key, attacker, Orient.toPool(q0, target), 100_000 ether);
    }

    function _bandBottom() internal view returns (int24) {
        int24 a = vault.anchor();
        int24 t = _twapPrice();
        return (a < t ? a : t) - terms.supportBandTicks;
    }

    /// @dev Ranges whose quote sits (at least partly) below the band, which is what a keeper would pick.
    function _rangesHoldingQuoteOutsideTheBand() internal view returns (uint256[] memory idx) {
        int24 bottom = _bandBottom();
        int24 t = _twapPrice();
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

    function _rangeInsideTheBand() internal view returns (uint256) {
        int24 bottom = _bandBottom();
        int24 t = _twapPrice();
        for (uint256 i; i < vault.rangeCount(); i++) {
            Range memory r = vault.rangeAt(i);
            (int24 pl, int24 pu) = Orient.rangeToPrice(q0, r.tickLower, r.tickUpper);
            if (pl >= bottom && pu <= t) return i;
        }
        revert("no range inside the band");
    }

    /// @dev Index of the range created by leg `legIndex` of the seed layout.
    function _indexOfLeg(uint256 legIndex) internal view returns (uint256) {
        Leg memory leg = _honestLegs(seedPrice, 6000)[legIndex];
        for (uint256 i; i < vault.rangeCount(); i++) {
            Range memory r = vault.rangeAt(i);
            if (r.tickLower == leg.tickLower && r.tickUpper == leg.tickUpper) return i;
        }
        revert("leg not found");
    }

    /// @dev Lowest price tick at which the vault offers tokens.
    function _lowestAsk() internal view returns (int24 lowest) {
        lowest = type(int24).max;
        (uint160 sqrtP,,,) = PM.getSlot0(key.toId());
        for (uint256 i; i < vault.rangeCount(); i++) {
            Range memory r = vault.rangeAt(i);
            (uint256 a0, uint256 a1) = RangeMath.amounts(sqrtP, r.tickLower, r.tickUpper, r.liquidity);
            (, uint256 tk) = Orient.split(q0, a0, a1);
            if (tk == 0) continue;
            (int24 pl,) = Orient.rangeToPrice(q0, r.tickLower, r.tickUpper);
            int24 from = pl > _spotPrice() ? pl : _spotPrice();
            if (from < lowest) lowest = from;
        }
    }
}
