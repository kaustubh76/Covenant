// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ILBPInitializer} from "liquidity-launcher/src/interfaces/ILBPInitializer.sol";
import {MigratorParameters} from "liquidity-launcher/src/libraries/MigratorParams.sol";
import {ContinuousClearingAuction} from "continuous-clearing-auction/ContinuousClearingAuction.sol";
import {AuctionParameters} from "continuous-clearing-auction/interfaces/IContinuousClearingAuction.sol";
import {TestToken} from "../base/TestToken.sol";

import {ICovenantVault} from "../../src/interfaces/ICovenantVault.sol";
import {SeedPlanner, IAuctionDemand} from "../../src/periphery/SeedPlanner.sol";
import {Range, Cut, Leg} from "../../src/types/CovenantTypes.sol";
import {Orient} from "../../src/libraries/Orient.sol";
import {CovenantTestBase} from "../base/CovenantTestBase.sol";
import {Presets} from "../base/Presets.sol";

/// @notice The spec's demo (docs/SPEC.md section 18), end to end on Uniswap's real CCA, LBPStrategy and v4, in one
///         test. Each step logs what a viewer would be shown.
contract LaunchToReleaseTest is CovenantTestBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    SeedPlanner planner;
    int24 clearingPrice;
    int24 fullRangeImpact;

    function setUp() public override {
        super.setUp();
        planner = new SeedPlanner();
        vm.deal(address(this), 100 ether);
    }

    function test_demo_launchToRelease() public {
        _step1_launch();
        _step2_migrateAndAdopt();
        _step3_demandShapedSeed();
        _step4_depth();
        _step5_threeRugAttempts();
        _step6_manipulation();
        _step7_rallyKeepsSupport();
        _step8_outsideLp();
        _step9_curatorChange();
        _step10_release();
        _assertPositionsMatchPoolManager();
        _assertSolvent();
    }

    /// @notice Restore, for the demo: a crash strands the reserve below the band, a random address repairs Support
    ///         and is paid from the bounty pool, which fees refill.
    function test_demo_restoreAfterACrash() public {
        _launch(Presets.standard());
        _honestSeed();
        vault.fundBounty{value: 0.1 ether}(0.1 ether);
        _wait(1 hours);

        _swapToTick(key, attacker, Orient.toPool(q0, _spotPrice() - 3000), 100_000 ether);
        _settleTwap();
        (uint256 lapsed, uint256 need) = vault.support();
        emit log_named_uint("after a 26% crash, support (bps)", lapsed);
        assertLt(lapsed, need);

        address anyone = makeAddr("anyone");
        uint256[] memory idx = new uint256[](1);
        idx[0] = _rangeWithMostQuote();
        vm.prank(anyone);
        vault.restore(idx, NEVER);
        (uint256 restored,) = vault.support();
        emit log_named_uint("after restore by a random address (bps)", restored);
        emit log_named_decimal_uint("bounty paid (ETH)", anyone.balance, 18);
        assertGe(restored, need);
        assertEq(anyone.balance, terms.bounty);
    }

    /// @notice Reading a realistic demand curve fits comfortably in one transaction.
    function test_gas_walkOutbidDemand300Levels() public {
        TestToken t = new TestToken("X", "X", 18);
        t.mint(address(this), 1000 ether);
        AuctionParameters memory ap = AuctionParameters({
            currency: address(0),
            tokensRecipient: unsoldRecipient,
            fundsRecipient: address(this),
            startBlock: uint64(block.number + 1),
            endBlock: uint64(block.number + 101),
            claimBlock: uint64(block.number + 111),
            tickSpacing: AUCTION_TICK,
            validationHook: address(0),
            floorPrice: AUCTION_FLOOR,
            requiredCurrencyRaised: 0,
            auctionStepsData: abi.encodePacked(uint24(100_000), uint40(50), uint24(100_000), uint40(50))
        });
        ContinuousClearingAuction a =
            ContinuousClearingAuction(payable(address(ccaFactory.create(address(t), 1000 ether, abi.encode(ap), 0))));
        t.transfer(address(a), 1000 ether);
        a.onTokensReceived();
        vm.roll(a.startBlock());
        address bidder = makeAddr("bidder");
        vm.deal(bidder, 1_000_000 ether);
        uint256 prev = AUCTION_FLOOR;
        for (uint256 i = 1; i <= 300; i++) {
            vm.prank(bidder);
            a.submitBid{value: 2 ether}(_price(i), 2 ether, bidder, prev, "");
            prev = _price(i);
        }
        vm.prank(bidder);
        a.submitBid{value: 5000 ether}(_price(400), 5000 ether, bidder, prev, ""); // clears above every level
        vm.roll(a.endBlock());
        a.checkpoint();

        uint256 g = gasleft();
        SeedPlanner.Level[] memory levels = planner.outbidDemand(IAuctionDemand(address(a)), true);
        uint256 used = g - gasleft();
        emit log_named_uint("outbid levels read", levels.length);
        emit log_named_uint("gas per level", used / levels.length);
        assertGt(levels.length, 250, "most of the 300 levels were outbid");
        assertLt(used, 3_000_000, "reading them fits easily in one transaction");
    }

    // ------------------------------------------------------------------------------------------------ steps

    /// 1. The issuer creates the vault before the auction and names it as hook-pool LP recipient. Bidders can check
    ///    the launch commits to it before they bid.
    function _step1_launch() internal {
        _createAndRegister(Presets.standard());
        MigratorParameters memory mp = strategy.initializers(ILBPInitializer(address(auction)));
        assertEq(mp.positionRecipient, address(vault), "LP goes to the vault");
        assertEq(mp.poolParameters.hook, address(hook), "pool hooked by Covenant");
        assertEq(vault.terms().supportBps, 4000, "covenant readable before bidding");
        emit log("1. launch: vault and terms committed before the auction, bidders can verify");

        _runDefaultAuction(auction);
    }

    /// 2. Anyone migrates through the stock strategy; anyone adopts.
    function _step2_migrateAndAdopt() internal {
        (firstLpId, lastLpId) = _closeAndMigrate(auction);
        assertEq(IERC721(address(POSM)).ownerOf(firstLpId), address(vault), "LP NFT minted to the vault");
        _adoptAll();
        clearingPrice = _spotPrice();
        emit log_named_int("2. migrated and adopted; pool opens at price tick", clearingPrice);
    }

    /// 3. The first reshape, shaped by the auction's own outbid demand.
    function _step3_demandShapedSeed() internal {
        // the launcher's full range, as a twin: measure a dump, then undo it
        uint256 snap = vm.snapshotState();
        int24 impact = _impactOfDump(5 ether);
        vm.revertToState(snap); // reverts this contract's storage too, so keep the result in memory until here
        fullRangeImpact = impact;

        (uint256 before,) = vault.support();
        SeedPlanner.Level[] memory levels = planner.outbidDemand(IAuctionDemand(address(auction)), true);
        assertEq(levels.length, 2, "both losing bids are still on-chain");
        (Cut[] memory cuts, Leg[] memory legs) = planner.plan(
            vault,
            IAuctionDemand(address(auction)),
            SeedPlanner.Params({supportShareBps: 5000, coreShareBps: 300, maxLevels: 6, levelHalfWidth: 2})
        );
        vm.prank(curator);
        vault.reshape(cuts, legs, NEVER);
        (uint256 have, uint256 need) = vault.support();
        emit log_named_uint("3. seed: support before (bps)", before);
        emit log_named_uint("   support after (bps)", have);
        assertLt(before, need);
        assertGe(have, need);
        assertEq(vault.rangeCount(), 5, "core, support, asks, two demand levels");
    }

    /// 4. The same dump, into the launcher's full range and into the Covenant layout.
    function _step4_depth() internal {
        uint256 snap = vm.snapshotState();
        int24 managed = _impactOfDump(5 ether);
        vm.revertToState(snap);
        emit log_named_int("4. depth: a 5-token dump moves the price (ticks), full range", fullRangeImpact);
        emit log_named_int("   and under Covenant", managed);
        assertLt(managed * 3, fullRangeImpact, "at least 3x less price impact");
    }

    /// 5. Three rug attempts, all rejected.
    function _step5_threeRugAttempts() internal {
        vm.prank(curator);
        vm.expectRevert(abi.encodeWithSelector(ICovenantVault.InsufficientShares.selector, 0, 1));
        vault.withdraw(1, 0, 0, NEVER);

        Cut[] memory cuts = new Cut[](1);
        cuts[0] = Cut(_rangeWithMostQuote(), type(uint128).max);
        Leg[] memory legs = new Leg[](1);
        legs[0] = _bid(clearingPrice - 1440, clearingPrice - 180, 9000);
        vm.prank(curator);
        vm.expectPartialRevert(ICovenantVault.IdleTooLarge.selector);
        vault.reshape(cuts, legs, NEVER);

        legs[0] = _bid(clearingPrice - 12_000, clearingPrice - 9000, SINK);
        vm.prank(curator);
        vm.expectPartialRevert(ICovenantVault.SupportBroken.selector);
        vault.reshape(cuts, legs, NEVER);
        emit log("5. withdraw, skim and soft rug: all three revert");
    }

    /// 6. A dump moves spot; reshape and deposit are blocked in that block. Once the move persists, it is accepted.
    function _step6_manipulation() internal {
        _wait(1 days); // past the setup epoch, so deposits are otherwise open
        _fund(lp);
        _swapToTick(key, attacker, Orient.toPool(q0, _spotPrice() - 1000), 100_000 ether);

        Cut[] memory cuts = new Cut[](1);
        cuts[0] = Cut(0, 1);
        vm.prank(curator);
        vm.expectPartialRevert(ICovenantVault.PriceGuard.selector);
        vault.reshape(cuts, new Leg[](0), NEVER);
        vm.prank(lp);
        vm.expectPartialRevert(ICovenantVault.PriceGuard.selector);
        vault.deposit{value: 50 ether}(1e17, type(uint256).max, type(uint256).max, NEVER);

        _settleTwap();
        vm.prank(curator);
        vault.reshape(cuts, new Leg[](0), NEVER);
        emit log("6. manipulated block: reshape and deposit revert; after the TWAP window the move is accepted");
    }

    /// 7. A rally past the asks. The filled asks are quote just under the new price, which counts as support, so
    ///    nothing lapses and restore has nothing to do (and pays nothing).
    function _step7_rallyKeepsSupport() internal {
        _swapToTick(key, trader, Orient.toPool(q0, clearingPrice + 2200), 100_000 ether);
        _settleTwap();
        (uint256 have, uint256 need) = vault.support();
        emit log_named_uint("7. after a 25% rally, support (bps)", have);
        assertGe(have, need, "filled asks are support");
        uint256[] memory idx = new uint256[](1);
        vm.prank(keeper);
        vm.expectPartialRevert(ICovenantVault.NothingToRestore.selector);
        vault.restore(idx, NEVER);
    }

    /// 8. An outside LP joins in kind and leaves; the issuer's principal and the guarantee are untouched.
    function _step8_outsideLp() internal {
        (uint256 supportBefore,) = vault.support();
        vm.prank(lp);
        (uint256 paid0, uint256 paid1) =
            vault.deposit{value: 500 ether}(1e17, type(uint256).max, type(uint256).max, NEVER);
        vm.prank(lp);
        (uint256 got0, uint256 got1) = vault.withdraw(1e17, 0, 0, NEVER);
        (uint256 supportAfter,) = vault.support();
        assertEq(supportAfter, supportBefore);
        assertEq(vault.principalShares(), 1e18);
        assertApproxEqAbs(got0, paid0, 20);
        assertApproxEqAbs(got1, paid1, 20);
        emit log_named_decimal_uint("8. outside LP paid (ETH) and got back the same, less rounding", paid0, 18);
    }

    /// 9. Curator change: timelocked, and the new curator inherits the same rules.
    function _step9_curatorChange() internal {
        address next = makeAddr("nextCurator");
        vm.prank(issuer);
        vault.proposeCurator(next);
        vm.expectPartialRevert(ICovenantVault.TimelockActive.selector);
        vault.acceptCurator();
        _wait(2 days);
        vault.acceptCurator();

        Cut[] memory cuts = new Cut[](1);
        cuts[0] = Cut(_rangeWithMostQuote(), type(uint128).max);
        Leg[] memory legs = new Leg[](1);
        legs[0] = _bid(_spotPrice() - 14_000, _spotPrice() - 11_000, SINK);
        vm.prank(next);
        vm.expectRevert(); // Pace or Support, whichever binds first: both are the covenant
        vault.reshape(cuts, legs, NEVER);
        emit log("9. curator changed after the timelock; the new curator still cannot rug");
    }

    /// 10. Principal vests linearly after the lock; more than vested is refused.
    function _step10_release() internal {
        vm.prank(issuer);
        vm.expectPartialRevert(ICovenantVault.Locked.selector);
        vault.withdrawPrincipal(1, 0, 0, NEVER);
        _wait(90 days + 15 days);
        uint256 vested = vault.principalWithdrawable();
        assertApproxEqRel(
            vested, 5e17 + uint256(5e17) * 3 days / 15 days, 0.01e18, "about half, plus the days already elapsed"
        );
        vm.prank(issuer);
        vault.withdrawPrincipal(vested, 0, 0, NEVER);
        vm.prank(issuer);
        vm.expectPartialRevert(ICovenantVault.Locked.selector);
        vault.withdrawPrincipal(1e16, 0, 0, NEVER);
        emit log_named_decimal_uint("10. release: principal shares withdrawn so far", vested, 18);
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _fund(address who) internal {
        vm.deal(who, 10_000 ether);
        token.mint(who, 10_000 ether);
        vm.prank(who);
        token.approve(address(vault), type(uint256).max);
    }

    function _impactOfDump(uint256 tokens) internal returns (int24) {
        int24 before = _spotPrice();
        _swap(key, attacker, !q0, tokens, 0);
        return before - _spotPrice();
    }

    function _rangeWithMostQuote() internal view returns (uint256 best) {
        (uint160 sqrtP,,,) = PM.getSlot0(key.toId());
        uint256 most;
        for (uint256 i; i < vault.rangeCount(); i++) {
            Range memory r = vault.rangeAt(i);
            (uint256 a0, uint256 a1) = RangeMathLib.amounts(sqrtP, r);
            (uint256 q,) = Orient.split(q0, a0, a1);
            if (q > most) (most, best) = (q, i);
        }
    }
}

import {RangeMath} from "../../src/libraries/RangeMath.sol";

library RangeMathLib {
    function amounts(uint160 sqrtP, Range memory r) internal pure returns (uint256, uint256) {
        return RangeMath.amounts(sqrtP, r.tickLower, r.tickUpper, r.liquidity);
    }
}
