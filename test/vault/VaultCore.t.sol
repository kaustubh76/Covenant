// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {CovenantVault} from "../../src/CovenantVault.sol";
import {ICovenantVault} from "../../src/interfaces/ICovenantVault.sol";
import {ICovenantFactory} from "../../src/interfaces/ICovenantFactory.sol";
import {VaultOps} from "../../src/vault/VaultOps.sol";
import {TermsLib} from "../../src/libraries/TermsLib.sol";
import {Terms, Range, Cut, Leg, VaultConfig} from "../../src/types/CovenantTypes.sol";
import {Orient} from "../../src/libraries/Orient.sol";
import {CovenantTestBase} from "../base/CovenantTestBase.sol";
import {Presets} from "../base/Presets.sol";

contract VaultCoreTest is CovenantTestBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function setUp() public override {
        super.setUp();
        _launch(Presets.standard());
    }

    // =========================================================================================== factory

    function test_factory_vaultAddressIsKnownBeforeTheAuction() public {
        VaultConfig memory cfg = VaultConfig(true, Presets.standard(), issuer, treasury, curator);
        TestTokenLike t = TestTokenLike(address(new TestTokenLike()));
        PoolKey memory k = _poolKey(address(0), address(t), 3000, 60, address(hook));
        address predicted = factory.predictVault(address(this), bytes32("launch-2"));
        address created = factory.createVault(k, cfg, bytes32("launch-2"));
        assertEq(created, predicted);
        assertTrue(factory.isVault(created));
        assertEq(CovenantVault(payable(created)).issuer(), issuer);
        // another creator with the same salt gets a different address: nobody can squat an issuer's vault
        assertTrue(factory.predictVault(attacker, bytes32("launch-2")) != predicted);
    }

    function test_factory_rejectsWhatCouldNeverWork() public {
        VaultConfig memory cfg = VaultConfig(true, Presets.standard(), issuer, treasury, curator);
        PoolKey memory k = key;

        k.hooks = IHooks(address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(ICovenantFactory.WrongHook.selector, address(0xBEEF)));
        factory.createVault(k, cfg, bytes32("a"));

        k = key;
        cfg.quoteIsCurrency0 = false; // native ETH can only be the quote
        vm.expectRevert(ICovenantFactory.QuoteMismatch.selector);
        factory.createVault(k, cfg, bytes32("b"));

        cfg = VaultConfig(true, Presets.standard(), address(0), treasury, curator);
        vm.expectRevert(ICovenantFactory.ZeroAddress.selector);
        factory.createVault(k, cfg, bytes32("c"));

        cfg = VaultConfig(true, Presets.standard(), issuer, treasury, curator);
        cfg.terms.supportBps = 0;
        vm.expectRevert(abi.encodeWithSelector(TermsLib.InvalidSupportBps.selector, 0));
        factory.createVault(k, cfg, bytes32("d"));

        k.fee = 0x800000; // dynamic fee flag
        cfg.terms.supportBps = 4000;
        vm.expectRevert(ICovenantFactory.InvalidPoolKey.selector);
        factory.createVault(k, cfg, bytes32("e"));
    }

    function test_factory_onlyTheFactoryInitializesAndOnlyOnce() public {
        VaultConfig memory cfg = VaultConfig(true, Presets.standard(), attacker, attacker, attacker);
        vm.prank(attacker);
        vm.expectRevert(ICovenantVault.NotFactory.selector);
        vault.initialize(key, cfg);

        vm.prank(address(factory));
        vm.expectRevert(ICovenantVault.AlreadyInitialized.selector);
        vault.initialize(key, cfg);

        // the implementation behind every clone is not a vault either
        CovenantVault impl = CovenantVault(payable(factory.implementation()));
        vm.prank(address(factory));
        vm.expectRevert(ICovenantVault.AlreadyInitialized.selector);
        impl.initialize(key, cfg);
    }

    function test_ops_cannotBeCalledDirectly() public {
        vm.expectRevert(VaultOps.NotDelegated.selector);
        ops.execute(abi.encode(uint8(5), bytes("")));
    }

    // =========================================================================================== adoption

    function test_adopt_vaultOwnsThePrincipalDirectly() public view {
        // the launcher's NFT is gone: the position now belongs to the vault in the PoolManager itself
        assertEq(vault.rangeCount(), 1);
        Range memory r = vault.rangeAt(0);
        assertEq(r.tickLower, TickMath.minUsableTick(60), "launcher's full range");
        assertEq(r.tickUpper, TickMath.maxUsableTick(60));
        _assertPositionsMatchPoolManager();

        assertEq(vault.principalShares(), 1e18, "issuer principal minted");
        assertEq(vault.totalShares(), 1e18);
        assertEq(vault.adoptedAt(), block.timestamp, "setup epoch started");
        assertEq(vault.anchor(), _spotPrice(), "anchor starts at the clearing price");
        assertLe(vault.idle0(), 10, "only rounding left idle");
        assertLe(vault.idle1(), 10);
        _assertSolvent();
    }

    function test_adopt_burnedTheLaunchersNft() public {
        vm.expectRevert(bytes("NOT_MINTED")); // PositionManager is a solmate ERC721
        IERC721(address(POSM)).ownerOf(firstLpId);
    }

    function test_adopt_rejectsNftsItDoesNotOwn() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 999;
        vm.expectRevert(); // nonexistent token
        vault.adopt(ids);
    }

    function test_adopt_closedOnceOutsideLpsJoin() public {
        _honestSeed();
        _wait(1 days + 1);
        vm.deal(lp, 1000 ether);
        token.mint(lp, 1000 ether);
        vm.startPrank(lp);
        token.approve(address(vault), type(uint256).max);
        vault.deposit{value: 100 ether}(1e16, type(uint256).max, type(uint256).max, NEVER);
        vm.stopPrank();
        uint256[] memory ids = new uint256[](0);
        vm.expectRevert(ICovenantVault.AlreadyHasOutsideShares.selector);
        vault.adopt(ids);
    }

    // =========================================================================================== the seed

    /// @notice The problem in one number: the launcher's full-range position fails a 40% support covenant.
    function test_seed_fullRangeLaunchFailsTheCovenant() public {
        (uint256 have, uint256 need) = vault.support();
        emit log_named_uint("support, full range at launch (bps)", have);
        assertLt(have, need);
    }

    function test_seed_honestCuratorConcentratesAndPasses() public {
        uint128 before = PM.getLiquidity(key.toId());
        (uint256 q0Before, uint256 t0Before) = _principal();
        _honestSeed();
        (uint256 have, uint256 need) = vault.support();
        emit log_named_uint("support after the seed (bps)", have);
        assertGe(have, need);
        assertEq(vault.rangeCount(), 4, "core, support, reserve, asks");
        _assertPositionsMatchPoolManager();
        _assertSolvent();

        // conservation: nothing left the vault's principal beyond rounding
        (uint256 q0After, uint256 t0After) = _principal();
        assertApproxEqAbs(q0After, q0Before, 1e6, "quote conserved");
        assertApproxEqAbs(t0After, t0Before, 1e6, "tokens conserved");

        // depth at the price
        uint128 afterLiq = PM.getLiquidity(key.toId());
        emit log_named_uint("active liquidity before", before);
        emit log_named_uint("active liquidity after ", afterLiq);
    }

    /// @notice The prototype's reshape took absolute liquidities and reverted if anyone traded first. Here legs are
    ///         shares, sized inside the unlock, so a trade between signing and inclusion changes nothing.
    function test_seed_survivesATradeBeforeInclusion() public {
        Cut[] memory cuts = _cutAll();
        Leg[] memory legs = _honestLegs(_spotPrice(), 6000);
        int24 before = _tick(key);
        _swap(key, trader, true, 0.3 ether, 0); // someone trades first, same block
        assertGt(before - _tick(key), 10, "the price moved");
        vm.prank(curator);
        vault.reshape(cuts, legs, NEVER);
        (uint256 have, uint256 need) = vault.support();
        assertGe(have, need);
    }

    // =========================================================================================== reshape rules

    function test_reshape_onlyTheCurator() public {
        Cut[] memory cuts = _cutAll();
        Leg[] memory legs = _honestLegs(_spotPrice(), 6000);
        vm.prank(attacker);
        vm.expectRevert(ICovenantVault.NotCurator.selector);
        vault.reshape(cuts, legs, NEVER);
        vm.prank(issuer);
        vm.expectRevert(ICovenantVault.NotCurator.selector);
        vault.reshape(cuts, legs, NEVER);
    }

    function test_reshape_respectsTheDeadline() public {
        Cut[] memory cuts = _cutAll();
        Leg[] memory legs = _honestLegs(_spotPrice(), 6000);
        vm.prank(curator);
        vm.expectRevert(abi.encodeWithSelector(ICovenantVault.Expired.selector, block.timestamp - 1));
        vault.reshape(cuts, legs, block.timestamp - 1);
    }

    /// @notice Skim: the curator places only 90% and hopes to strand the rest. It cannot leave the vault, and it
    ///         cannot even sit idle.
    function test_reshape_skimLeavesNothingBehind() public {
        Cut[] memory cuts = _cutAll();
        int24 p = _spotPrice();
        Leg[] memory legs = new Leg[](2);
        legs[0] = _bid(p - 1440, p - 60, 9000); // 90% of the quote
        legs[1] = _ask(p + 120, p + 3000, 10_000);
        vm.prank(curator);
        vm.expectPartialRevert(ICovenantVault.IdleTooLarge.selector);
        vault.reshape(cuts, legs, NEVER);
    }

    /// @notice Soft rug: all buy support moved far below the price.
    function test_reshape_softRugIsRejected() public {
        Cut[] memory cuts = _cutAll();
        int24 p = _spotPrice();
        Leg[] memory legs = new Leg[](2);
        legs[0] = _bid(p - 12_000, p - 9000, SINK);
        legs[1] = _ask(p + 120, p + 3000, SINK);
        vm.prank(curator);
        vm.expectRevert(abi.encodeWithSelector(ICovenantVault.SupportBroken.selector, 0, 4000));
        vault.reshape(cuts, legs, NEVER);
    }

    function test_reshape_guardBlocksAManipulatedPrice() public {
        _honestSeed();
        _settleTwap();
        _swap(key, attacker, false, 60 ether, 0); // dump tokens: spot far from the TWAP
        Cut[] memory cuts = new Cut[](1);
        cuts[0] = Cut(0, 1);
        Leg[] memory legs = new Leg[](0);
        vm.prank(curator);
        vm.expectPartialRevert(ICovenantVault.PriceGuard.selector);
        vault.reshape(cuts, legs, NEVER);
    }

    function test_reshape_paceAppliesAfterTheSetupEpoch() public {
        _honestSeed();
        _wait(1 days + 1);
        // everything at once: over the 50% allowance
        Cut[] memory all = _cutAll();
        Leg[] memory legs = _honestLegs(_spotPrice(), 6000);
        vm.prank(curator);
        vm.expectPartialRevert(ICovenantVault.PaceExceeded.selector);
        vault.reshape(all, legs, NEVER);

        // a third of one range is fine
        Range memory r = vault.rangeAt(0);
        Cut[] memory some = new Cut[](1);
        some[0] = Cut(0, r.liquidity / 3);
        Leg[] memory back = new Leg[](1);
        (int24 pl, int24 pu) = Orient.rangeToPrice(q0, r.tickLower, r.tickUpper);
        back[0] = _isBid(r) ? _bid(pl, pu, 10_000) : _ask(pl, pu, 10_000);
        vm.prank(curator);
        vault.reshape(some, back, NEVER);
        assertLt(vault.paceAvailable(), 5e8, "allowance spent");
    }

    function test_reshape_rangeCapStopsGasGriefing() public {
        Cut[] memory cuts = _cutAll();
        int24 p = _spotPrice();
        Leg[] memory legs = new Leg[](16);
        for (uint256 i; i < 15; i++) {
            int24 top = p - 60 - int24(int256(i)) * 60;
            legs[i] = _bid(top - 60, top, 600);
        }
        legs[15] = _ask(p + 120, p + 3000, SINK);
        legs[0].share0 = SINK; // sink takes the remaining quote
        vm.prank(curator);
        vm.expectRevert(abi.encodeWithSelector(ICovenantVault.TooManyRanges.selector, 16, 14));
        vault.reshape(cuts, legs, NEVER);
    }

    function test_reshape_rejectsMalformedLegs() public {
        Cut[] memory cuts = _cutAll();
        int24 p = _spotPrice();
        Leg[] memory legs = new Leg[](1);

        legs[0] = Leg(1, 61, 1, 1); // not aligned to the 60 spacing
        vm.prank(curator);
        vm.expectRevert(abi.encodeWithSelector(ICovenantVault.InvalidLeg.selector, 0));
        vault.reshape(cuts, legs, NEVER);

        legs = new Leg[](2);
        legs[0] = _bid(p - 1440, p - 60, 6000);
        legs[1] = _bid(p - 3000, p - 1440, 6000); // 120% of the quote
        vm.prank(curator);
        vm.expectRevert(ICovenantVault.SharesExceedWhole.selector);
        vault.reshape(cuts, legs, NEVER);

        legs[0] = _bid(p - 1440, p - 60, SINK);
        legs[1] = _bid(p - 3000, p - 1440, SINK); // two quote sinks
        vm.prank(curator);
        vm.expectRevert(abi.encodeWithSelector(ICovenantVault.InvalidLeg.selector, 1));
        vault.reshape(cuts, legs, NEVER);

        // a sink must sit on one side of the price
        legs = new Leg[](2);
        legs[0] = _bid(p - 1440, p + 1440, SINK);
        legs[1] = _ask(p + 120, p + 3000, SINK);
        if (!q0) (legs[0].share0, legs[0].share1) = (legs[0].share1, legs[0].share0);
        vm.prank(curator);
        vm.expectPartialRevert(ICovenantVault.SinkStraddlesPrice.selector);
        vault.reshape(cuts, legs, NEVER);
    }

    // =========================================================================================== the Anchor

    /// @notice Price rallies far beyond the asks and holds. The Anchor climbs at most B per epoch, so the curator
    ///         cannot move the vault's bids up behind a price that may have been pushed through empty ticks.
    function test_anchor_climbsAtMostOneBandPerEpoch() public {
        _honestSeed();
        int24 start = vault.anchor();
        _pump(20_000);
        _settleTwap();
        vault.poke();
        // Unsynced for 90 minutes: only one window (30 min) of climb counts, B * 1800 / 86400 = 31 ticks.
        assertEq(int256(vault.anchor()) - start, 31, "no allowance banked while unsynced");

        _keepPoked(1 days);
        int256 climbed = int256(vault.anchor()) - start;
        emit log_named_int("anchor climb after one more day, synced (ticks)", climbed);
        assertLe(climbed, int256(terms.supportBandTicks) + 31, "at most one band per epoch");
        assertGe(climbed, int256(terms.supportBandTicks) * 95 / 100, "and close to it when synced");
        assertLt(climbed, 20_000, "far from the pumped price");
    }

    function test_anchor_followsADropAtOnce() public {
        _honestSeed();
        int24 start = vault.anchor();
        _swapToTick(key, attacker, Orient.toPool(q0, start - 3000), 10_000 ether);
        _settleTwap();
        int24 a = vault.anchor();
        assertEq(a, _twapPrice() + terms.guardTicks, "dropped to G above the TWAP");
    }

    /// @notice With the price far above the Anchor, a curator cannot place bids near that price.
    function test_anchor_curatorCannotBidAboveTheCeiling() public {
        _honestSeed();
        _pump(9000);
        _settleTwap();
        _pokeAnchor();
        int24 p = _spotPrice();
        int24 ceiling = vault.anchor() + terms.guardTicks;
        assertGt(p - 600, ceiling, "the price outran the anchor");

        // move the filled asks (now quote) to just under the pumped price
        (uint256 idx, Range memory r) = _rangeWithMostQuote();
        Cut[] memory cuts = new Cut[](1);
        cuts[0] = Cut(idx, r.liquidity / 4);
        Leg[] memory legs = new Leg[](1);
        legs[0] = _bid(p - 600, p - 120, SINK);
        vm.prank(curator);
        vm.expectPartialRevert(ICovenantVault.BidAboveCeiling.selector);
        vault.reshape(cuts, legs, NEVER);
    }

    // =========================================================================================== helpers

    /// @dev Buy tokens until the price tick is `ticks` above where it is.
    function _pump(int24 ticks) internal {
        int24 target = Orient.toPool(q0, _spotPrice() + ticks);
        _swapToTick(key, attacker, target, 100_000 ether);
    }

    function _pokeAnchor() internal {
        vault.poke();
    }

    function _isBid(Range memory r) internal view returns (bool) {
        (, int24 pu) = Orient.rangeToPrice(q0, r.tickLower, r.tickUpper);
        return pu <= _spotPrice();
    }

    function _rangeWithMostQuote() internal view returns (uint256 best, Range memory r) {
        (uint160 sqrtP,,,) = PM.getSlot0(key.toId());
        uint256 most;
        for (uint256 i; i < vault.rangeCount(); i++) {
            Range memory x = vault.rangeAt(i);
            (uint256 a0, uint256 a1) = _amounts(sqrtP, x);
            (uint256 q,) = Orient.split(q0, a0, a1);
            if (q > most) (most, best, r) = (q, i, x);
        }
    }

    function _amounts(uint160 sqrtP, Range memory x) internal pure returns (uint256, uint256) {
        return RangeMathView.amounts(sqrtP, x);
    }
}

import {RangeMath} from "../../src/libraries/RangeMath.sol";

library RangeMathView {
    function amounts(uint160 sqrtP, Range memory x) internal pure returns (uint256, uint256) {
        return RangeMath.amounts(sqrtP, x.tickLower, x.tickUpper, x.liquidity);
    }
}

/// @dev Minimal ERC20 stand-in for a second launch's pool key.
contract TestTokenLike {
    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }
}
