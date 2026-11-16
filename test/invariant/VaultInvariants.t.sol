// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {CovenantVault} from "../../src/CovenantVault.sol";
import {ICovenantHook} from "../../src/interfaces/ICovenantHook.sol";
import {Range, Cut, Leg} from "../../src/types/CovenantTypes.sol";
import {Orient} from "../../src/libraries/Orient.sol";
import {RangeMath} from "../../src/libraries/RangeMath.sol";
import {CovenantTestBase} from "../base/CovenantTestBase.sol";
import {TestToken} from "../base/TestToken.sol";
import {Presets} from "../base/Presets.sol";

/// @notice Drives the vault the way the world would: traders (including pushes through empty ticks), time, the
///         curator, keepers, LPs and the issuer, in any order. Records what the invariants need to check.
contract VaultHandler is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint16 constant SINK = type(uint16).max;
    uint256 constant NEVER = type(uint256).max;

    IPoolManager immutable pm;
    CovenantVault immutable vault;
    PoolSwapTest immutable router;
    TestToken immutable token;
    ICovenantHook immutable hook;
    address immutable curator;
    address immutable issuer;
    PoolKey key;
    bool immutable q0;

    address[3] public lps = [address(0x1a01), address(0x1a02), address(0x1a03)];
    address trader = address(0x7a01);
    address keeper = address(0x6e01);

    // ghosts
    uint256 public maxConservationError;
    bool public supportViolated;
    bool public roundTripProfit;
    uint256 public reshapes;
    uint256 public restores;
    uint256 public deposits;
    uint256 public withdrawals;

    constructor(
        IPoolManager pm_,
        CovenantVault vault_,
        PoolSwapTest router_,
        TestToken token_,
        ICovenantHook hook_,
        address curator_,
        address issuer_
    ) {
        pm = pm_;
        vault = vault_;
        router = router_;
        token = token_;
        hook = hook_;
        curator = curator_;
        issuer = issuer_;
        key = vault_.poolKey();
        q0 = vault_.quoteIsCurrency0();
        for (uint256 i; i < lps.length; i++) {
            vm.deal(lps[i], 1e30);
            token.mint(lps[i], 1e30);
            vm.prank(lps[i]);
            token.approve(address(vault), type(uint256).max);
        }
        vm.deal(trader, 1e30);
        token.mint(trader, 1e30);
        vm.prank(trader);
        token.approve(address(router), type(uint256).max);
    }

    // ------------------------------------------------------------------------------------------------ actions

    function swap(bool buyTokens, uint256 amountSeed, bool throughEmptyTicks) external {
        uint256 amount = _bound(amountSeed, 1e12, 60 ether);
        bool zeroForOne = buyTokens == q0;
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        // Ordinary trades stay within 25% of the price; pushes through empty ticks go up to 30,000 ticks.
        (, int24 t,,) = pm.getSlot0(key.toId());
        int24 reach = throughEmptyTicks ? int24(30_000) : int24(2500);
        int24 target = zeroForOne ? t - reach : t + reach;
        if (target > TickMath.MIN_TICK && target < TickMath.MAX_TICK) limit = TickMath.getSqrtPriceAtTick(target);
        vm.prank(trader);
        try router.swap{value: zeroForOne && q0 ? amount : 0}(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amount), sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) {} catch {}
    }

    function warp(uint256 secondsSeed) external {
        uint256 dt = _bound(secondsSeed, 1 minutes, 2 days);
        skip(dt);
        vm.roll(block.number + dt / 2 + 1);
    }

    /// @notice Cut part of a range and re-place it next to the price, with sinks: the curator's everyday move.
    function reshape(uint256 rangeSeed, uint256 fractionSeed) external {
        _maybeSettle(rangeSeed >> 128);
        uint256 n = vault.rangeCount();
        if (n == 0) return;
        uint256 idx = rangeSeed % n;
        Range memory r = vault.rangeAt(idx);
        uint128 cut = uint128(FullMathLite.mulDiv(r.liquidity, _bound(fractionSeed, 1, 8), 16));
        if (cut == 0) return;
        Cut[] memory cuts = new Cut[](1);
        cuts[0] = Cut(idx, cut);

        int24 s = key.tickSpacing;
        (, int24 spotTick,,) = pm.getSlot0(key.toId());
        int24 p = Orient.toPrice(q0, spotTick);
        Leg[] memory legs = new Leg[](2);
        legs[0] = _leg(Orient.floorTo(p - 900, s), Orient.floorTo(p - 1, s) - s, true);
        legs[1] = _leg(Orient.ceilTo(p + 1, s) + s, Orient.ceilTo(p + 900, s) + s, false);

        (uint256 q0Before, uint256 t0Before) = _principal();
        vm.prank(curator);
        try vault.reshape(cuts, legs, NEVER) {
            reshapes++;
            (uint256 q1, uint256 t1) = _principal();
            _recordConservation(q0Before, q1);
            _recordConservation(t0Before, t1);
            (uint256 have, uint256 need) = vault.support();
            if (have < need) supportViolated = true;
        } catch {}
    }

    function restore(uint256 seed) external {
        _maybeSettle(seed);
        uint256 n = vault.rangeCount();
        (, int24 spotTick,,) = pm.getSlot0(key.toId());
        int24 spot = Orient.toPrice(q0, spotTick);
        uint256[] memory tmp = new uint256[](n);
        uint256 k;
        for (uint256 i; i < n; i++) {
            Range memory r = vault.rangeAt(i);
            (int24 pl,) = Orient.rangeToPrice(q0, r.tickLower, r.tickUpper);
            if (pl < spot) tmp[k++] = i;
        }
        uint256[] memory idx = new uint256[](k);
        for (uint256 i; i < k; i++) {
            idx[i] = tmp[i];
        }
        (uint256 q0Before, uint256 t0Before) = _principal();
        vm.prank(keeper);
        try vault.restore(idx, NEVER) {
            restores++;
            (uint256 q1, uint256 t1) = _principal();
            _recordConservation(q0Before, q1);
            _recordConservation(t0Before, t1);
        } catch {}
    }

    function deposit(uint256 actorSeed, uint256 sharesSeed) external {
        _maybeSettle(actorSeed >> 128);
        address who = lps[actorSeed % lps.length];
        uint256 shares = _bound(sharesSeed, 1e12, 2e17);
        vm.prank(who);
        try vault.deposit{value: q0 ? 5000 ether : 0}(shares, type(uint256).max, type(uint256).max, NEVER) {
            deposits++;
        } catch {}
    }

    function withdraw(uint256 actorSeed, uint256 fractionSeed) external {
        address who = lps[actorSeed % lps.length];
        uint256 held = vault.sharesOf(who);
        if (held == 0) return;
        uint256 shares = held * _bound(fractionSeed, 1, 4) / 4;
        vm.prank(who);
        try vault.withdraw(shares, 0, 0, NEVER) {
            withdrawals++;
        } catch {}
    }

    /// @notice Deposit and withdraw the same shares with nothing in between: never a profit.
    function roundTrip(uint256 actorSeed, uint256 sharesSeed) external {
        _maybeSettle(actorSeed >> 128);
        address who = lps[actorSeed % lps.length];
        uint256 shares = _bound(sharesSeed, 1e12, 2e17);
        vm.prank(who);
        try vault.deposit{value: q0 ? 5000 ether : 0}(shares, type(uint256).max, type(uint256).max, NEVER) returns (
            uint256 p0, uint256 p1
        ) {
            vm.prank(who);
            (uint256 g0, uint256 g1) = vault.withdraw(shares, 0, 0, NEVER);
            if (g0 > p0 || g1 > p1) roundTripProfit = true;
        } catch {}
    }

    function poke() external {
        try vault.poke() {} catch {}
    }

    function collectFees() external {
        try vault.collectFees() {} catch {}
    }

    function claimFees(uint256 actorSeed) external {
        vm.prank(lps[actorSeed % lps.length]);
        try vault.claimFees() {} catch {}
    }

    function claimCuratorFees() external {
        vm.prank(curator);
        try vault.claimCuratorFees() {} catch {}
    }

    function withdrawPrincipal(uint256 fractionSeed) external {
        uint256 allowed = vault.principalWithdrawable();
        if (allowed == 0) return;
        vm.prank(issuer);
        try vault.withdrawPrincipal(allowed * _bound(fractionSeed, 1, 4) / 4, 0, 0, NEVER) {} catch {}
    }

    // ------------------------------------------------------------------------------------------------ helpers

    /// @dev Guarded actions right after a big swap would only test the Guard. Half the time, wait the move out first.
    function _maybeSettle(uint256 seed) internal {
        if (seed % 2 == 0) return;
        (, int24 spot,,) = pm.getSlot0(key.toId());
        int24 tw = hook.consult(key.toId(), vault.terms().twapWindow);
        int24 g = vault.terms().guardTicks;
        if (spot - tw > g || tw - spot > g) {
            skip(4 hours);
            vm.roll(block.number + 7200);
        }
    }

    function _leg(int24 priceLower, int24 priceUpper, bool isBid) internal view returns (Leg memory) {
        (int24 lo, int24 hi) = Orient.rangeToPool(q0, priceLower, priceUpper);
        bool quoteSide = isBid; // bids take quote, asks take tokens
        bool currency0 = quoteSide == q0;
        return currency0 ? Leg(lo, hi, SINK, 0) : Leg(lo, hi, 0, SINK);
    }

    function _principal() internal view returns (uint256 quote, uint256 tk) {
        (uint160 sqrtP,,,) = pm.getSlot0(key.toId());
        Range[] memory rs = vault.ranges();
        uint256 a0 = vault.idle0();
        uint256 a1 = vault.idle1();
        for (uint256 i; i < rs.length; i++) {
            (uint256 x0, uint256 x1) = RangeMath.amounts(sqrtP, rs[i].tickLower, rs[i].tickUpper, rs[i].liquidity);
            a0 += x0;
            a1 += x1;
        }
        return Orient.split(q0, a0, a1);
    }

    function _recordConservation(uint256 before, uint256 after_) internal {
        uint256 err = before > after_ ? before - after_ : after_ - before;
        if (err > maxConservationError) maxConservationError = err;
    }
}

library FullMathLite {
    function mulDiv(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        return a * b / d;
    }
}

contract VaultInvariantTest is CovenantTestBase {
    VaultHandler handler;

    function setUp() public override {
        super.setUp();
        _launch(Presets.standard());
        _honestSeed();
        vm.deal(address(this), 10 ether);
        vault.fundBounty{value: 1 ether}(1 ether);
        handler = new VaultHandler(PM, vault, swapRouter, token, hook, curator, issuer);
        targetContract(address(handler));
    }

    /// @notice The vault's balances cover everything it books outside the pool.
    function invariant_solvent() public view {
        _assertSolvent();
    }

    /// @notice What the vault books is exactly what it owns in the PoolManager, without duplicates, within the cap.
    function invariant_positionsMatchThePoolManager() public view {
        _assertPositionsMatchPoolManager();
        assertLe(vault.rangeCount(), 16);
    }

    /// @notice Every share is accounted for: the issuer's principal plus each LP's balance.
    function invariant_sharesAddUp() public view {
        uint256 sum = vault.principalShares();
        for (uint256 i; i < 3; i++) {
            sum += vault.sharesOf(handler.lps(i));
        }
        assertEq(sum, vault.totalShares());
    }

    /// @notice The issuer never takes out more principal than has vested.
    function invariant_principalNeverAboveVested() public view {
        assertLe(vault.principalWithdrawn() + vault.principalShares(), 1e18);
        assertLe(vault.principalWithdrawn() + vault.principalWithdrawable(), 1e18);
    }

    /// @notice Reshape and restore move principal between ranges and never change how much there is, beyond the
    ///         few wei liquidity rounding costs.
    function invariant_reshapeAndRestoreConservePrincipal() public view {
        assertLe(handler.maxConservationError(), 1000);
    }

    /// @notice Support is never below S after a curator action.
    function invariant_supportHoldsAfterEveryReshape() public view {
        assertFalse(handler.supportViolated());
    }

    /// @notice Everything anyone can claim as fees is backed by fees the vault actually holds.
    function invariant_feeClaimsAreBackedByThePot() public view {
        (uint256 s0, uint256 s1) = vault.feesOwed(address(0)); // the issuer's principal
        for (uint256 i; i < 3; i++) {
            (uint256 a0, uint256 a1) = vault.feesOwed(handler.lps(i));
            s0 += a0;
            s1 += a1;
        }
        s0 += vault.curatorFees0(curator);
        s1 += vault.curatorFees1(curator);
        assertLe(s0, vault.feePot0(), "currency0 fee claims");
        assertLe(s1, vault.feePot1(), "currency1 fee claims");
    }

    /// @notice In-kind shares cannot be round-tripped for profit.
    function invariant_depositThenWithdrawNeverProfits() public view {
        assertFalse(handler.roundTripProfit());
    }

    /// @notice How much each run exercised, visible with -vv.
    function afterInvariant() external view {
        console.log("reshapes %s, restores %s", handler.reshapes(), handler.restores());
        console.log("deposits %s, withdrawals %s", handler.deposits(), handler.withdrawals());
    }

    /// @notice The handler is only worth its invariants if its actions succeed often. A long deterministic campaign
    ///         through the same handler shows they do.
    function test_handlerExercisesTheVault() public {
        uint256 seed = 42;
        for (uint256 i; i < 400; i++) {
            seed = uint256(keccak256(abi.encode(seed)));
            uint256 action = seed % 10;
            if (action == 0) handler.swap(seed & 1 == 0, seed >> 8, false);
            else if (action == 1) handler.swap(seed & 1 == 0, seed >> 8, true);
            else if (action == 2) handler.warp(seed >> 16);
            else if (action == 3 || action == 4) handler.reshape(seed >> 24, seed >> 32);
            else if (action == 5) handler.restore(seed >> 40);
            else if (action == 6) handler.deposit(seed >> 48, seed >> 56);
            else if (action == 7) handler.withdraw(seed >> 64, seed >> 72);
            else if (action == 8) handler.roundTrip(seed >> 80, seed >> 88);
            else handler.collectFees();
        }
        console.log("reshapes %s, restores %s", handler.reshapes(), handler.restores());
        console.log("deposits %s, withdrawals %s", handler.deposits(), handler.withdrawals());
        // Many reshape attempts fail on the covenant itself (Pace spent, bids under the Anchor's ceiling, the Guard
        // after a jump). The point is that enough succeed for the invariants to bite.
        assertGe(handler.reshapes(), 10, "curator actions succeed");
        assertGe(handler.restores(), 1, "restores happen");
        assertGe(handler.deposits(), 10, "deposits succeed");
        assertGe(handler.withdrawals(), 10, "withdrawals succeed");
        invariant_solvent();
        invariant_positionsMatchThePoolManager();
        invariant_sharesAddUp();
        invariant_reshapeAndRestoreConservePrincipal();
        invariant_supportHoldsAfterEveryReshape();
        invariant_depositThenWithdrawNeverProfits();
    }
}

import {console} from "forge-std/console.sol";
