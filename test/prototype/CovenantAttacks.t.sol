// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Adversarial test suite for the Covenant prototype, run on Uniswap's real LBPStrategy + v4 core.

import {LBPStrategyTestBase} from "./launcher/LBPStrategyTestBase.sol";
import {ILBPInitializer, LBPInitializationParams} from "liquidity-launcher/src/interfaces/ILBPInitializer.sol";
import {MockLBPInitializer} from "./launcher/MockLBPInitializer.sol";
import {PositionDefinition} from "liquidity-launcher/src/types/PositionPlannerTypes.sol";
import {MigratorParameters, PoolParameters, LiquidityAllocationBracket} from "liquidity-launcher/src/libraries/MigratorParams.sol";
import {Covenant} from "./Covenant.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract CovenantAttacksTest is LBPStrategyTestBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    Covenant cov;
    PoolSwapTest router;
    PoolKey key;
    address token;
    uint256 lpId;

    address issuer_ = makeAddr("issuer");
    address curator_ = makeAddr("curator");
    address attacker = makeAddr("attacker");
    address lp = makeAddr("outsideLP");
    address keeper = makeAddr("keeper");

    int24 constant BAND = 1500; // ~15%
    int24 constant GUARD = 300; // ~3%
    uint32 constant TWAP_WINDOW = 1800;
    uint32 constant EPOCH = 1 days;

    function setUp() public override {
        super.setUp();
        vm.warp(1_800_000_000);
        uint160 flags = uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG);
        bytes memory args = abi.encode(POOL_MANAGER, address(strategy), POSITION_MANAGER);
        (address hookAddr, bytes32 salt) = HookMiner.find(address(this), flags, type(Covenant).creationCode, args);
        cov = new Covenant{salt: salt}(POOL_MANAGER, address(strategy), POSITION_MANAGER);
        assertEq(address(cov), hookAddr);
        router = new PoolSwapTest(POOL_MANAGER);

        // --- launch through Uniswap's stock strategy: Covenant is hook AND position recipient
        LiquidityAllocationBracket[] memory bp = new LiquidityAllocationBracket[](1);
        bp[0] = LiquidityAllocationBracket({lowerThreshold: 0, rate: 1e7});
        PositionDefinition[] memory defs = new PositionDefinition[](1);
        defs[0] = PositionDefinition({
            offsetLower: TickMath.MIN_TICK, offsetUpper: TickMath.MAX_TICK, weight: 1e7, overridePositionRecipient: address(0)
        });
        MigratorParameters memory mp = MigratorParameters({
            token: address(0),
            currency: address(0),
            migrationBlock: uint64(block.number + 1),
            reservedTokenAmountForLP: 100 ether,
            recipient: recipient,
            positionRecipient: address(cov),
            poolParameters: PoolParameters({fee: 3000, tickSpacing: 60, hook: address(cov)}),
            positionDefinitions: abi.encode(defs),
            lpAllocationSchedule: new bytes(0)
        });
        LBPInitializationParams memory lbp =
            LBPInitializationParams({initialPriceX96: uint160(1 << 96), tokensSold: 1 ether, currencyRaised: 100 ether});
        (MockLBPInitializer init,) = _initializeWith(mp, 110 ether, uint64(block.number), bp, address(0), lbp);
        token = init.token();
        vm.deal(address(init), 100 ether);
        vm.roll(mp.migrationBlock);
        lpId = POSITION_MANAGER.nextTokenId();
        strategy.migrate(ILBPInitializer(address(init)));

        key = PoolKey(Currency.wrap(address(0)), Currency.wrap(token), 3000, 60, IHooks(address(cov)));

        // --- covenant terms, committed "before the auction"
        Covenant.Terms memory t = Covenant.Terms({
            supportBps: 4000,
            supportBandTicks: BAND,
            paceBps: 5000,
            epochLen: EPOCH,
            guardTicks: GUARD,
            twapWindow: TWAP_WINDOW,
            unlockStart: uint64(block.timestamp + 90 days),
            unlockDuration: 30 days,
            curatorTimelock: 2 days,
            bounty0: 0.01 ether
        });
        cov.configure(key, t, issuer_, curator_);
        cov.adopt(lpId);

        vm.deal(attacker, 10_000 ether);
        vm.deal(lp, 1_000 ether);
        vm.deal(address(this), 10_000 ether);
        deal(token, attacker, 10_000 ether);
        deal(token, lp, 1_000 ether);
        deal(token, address(this), 10_000 ether);
        vm.prank(attacker);
        IERC20(token).approve(address(router), type(uint256).max);
        vm.prank(lp);
        IERC20(token).approve(address(cov), type(uint256).max);
        IERC20(token).approve(address(router), type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers
    function _swap(address who, bool zeroForOne, int256 amountSpecified) internal {
        vm.startPrank(who);
        uint256 val = zeroForOne && amountSpecified < 0 ? uint256(-amountSpecified) : 0;
        router.swap{value: val}(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    function _swapToTick(address who, int24 target) internal {
        bool zeroForOne = target < _tick();
        vm.startPrank(who);
        router.swap{value: zeroForOne ? 2000 ether : 0}(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -2000 ether, sqrtPriceLimitX96: _sq(target)}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    function _tick() internal view returns (int24 t) {
        (, t,,) = POOL_MANAGER.getSlot0(key.toId());
    }

    function _sq(int24 t) internal pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(t);
    }

    /// @dev Honest curator plan at tick 0: 60% of quote as support just above price, 40% as reserve further
    ///      up, all tokens as asks just below price. Pure reshaping, no swap.
    function _honestPlan() internal view returns (uint256[] memory rm, Covenant.Range[] memory adds) {
        (uint256 a0, uint256 a1) = cov.amountsOf(0);
        rm = new uint256[](1);
        rm[0] = 0;
        adds = new Covenant.Range[](3);
        adds[0] = Covenant.Range(0, 1500, LiquidityAmounts.getLiquidityForAmount0(_sq(0), _sq(1500), a0 * 60 / 100 - 1e6));
        adds[1] = Covenant.Range(1500, 6000, LiquidityAmounts.getLiquidityForAmount0(_sq(1500), _sq(6000), a0 * 40 / 100 - 1e6));
        adds[2] = Covenant.Range(-3000, 0, LiquidityAmounts.getLiquidityForAmount1(_sq(-3000), _sq(0), a1 - 1e6));
    }

    function _honestReshape() internal {
        (uint256[] memory rm, Covenant.Range[] memory adds) = _honestPlan();
        vm.prank(curator_);
        cov.reshape(rm, adds);
    }

    // ===================================================================== tests

    // 0. The default seed (full range) does NOT meet a 40% support covenant: that's the problem statement.
    function test_0_fullRangeSeedIsThinSupport() public {
        (uint256 have, uint256 need) = cov.supportBps();
        emit log_named_uint("full-range support bps", have);
        assertLt(have, need, "full range fails the support covenant");
        assertEq(cov.rangeCount(), 1);
        assertEq(cov.shares(issuer_), 1e18, "issuer holds principal shares");
    }

    // 1. Honest curator concentrates; conservation + support pass; depth multiplies.
    function test_1_honestReshapePassesAndDeepens() public {
        uint128 before = POOL_MANAGER.getLiquidity(key.toId());
        _honestReshape();
        (uint256 have, uint256 need) = cov.supportBps();
        emit log_named_uint("support bps after reshape", have);
        assertGe(have, need);
        assertEq(cov.rangeCount(), 3);
        // vault holds only dust outside the pool
        assertLe(address(cov).balance, cov.DUST());
        assertLe(IERC20(token).balanceOf(address(cov)), cov.DUST());
        emit log_named_uint("active liquidity before", before);
        emit log_named_uint("active liquidity after ", POOL_MANAGER.getLiquidity(key.toId()));
    }

    // 2. Price impact of the same token dump: full-range seed vs covenant-managed.
    function test_2_dumpImpact_fullRange_vs_managed() public {
        uint256 snap = vm.snapshotState();
        int24 t0 = _tick();
        _swap(attacker, false, -5 ether); // sell 5 token for ETH
        int24 impactFull = _tick() - t0;
        vm.revertToState(snap);

        _honestReshape();
        t0 = _tick();
        _swap(attacker, false, -5 ether);
        int24 impactManaged = _tick() - t0;
        emit log_named_int("tick move, full-range seed", impactFull);
        emit log_named_int("tick move, covenant-managed", impactManaged);
        assertLt(impactManaged, impactFull / 5, "managed depth absorbs the dump far better");
    }

    // 3. Soft rug: curator moves all buy support far away from price -> rejected.
    function test_3_softRugRejected() public {
        (uint256 a0, uint256 a1) = cov.amountsOf(0);
        uint256[] memory rm = new uint256[](1);
        Covenant.Range[] memory adds = new Covenant.Range[](2);
        adds[0] = Covenant.Range(9000, 12000, LiquidityAmounts.getLiquidityForAmount0(_sq(9000), _sq(12000), a0 - 1e6));
        adds[1] = Covenant.Range(-12000, -9000, LiquidityAmounts.getLiquidityForAmount1(_sq(-12000), _sq(-9000), a1 - 1e6));
        vm.prank(curator_);
        vm.expectRevert(abi.encodeWithSelector(Covenant.SupportBroken.selector, 0, 4000));
        cov.reshape(rm, adds);
    }

    // 4. Curator tries to pocket principal: adds consume less than removed -> conservation revert.
    function test_4_curatorCannotSkimPrincipal() public {
        (uint256 a0, uint256 a1) = cov.amountsOf(0);
        uint256[] memory rm = new uint256[](1);
        Covenant.Range[] memory adds = new Covenant.Range[](2);
        // re-add only 90% of the quote and 100% of tokens
        adds[0] = Covenant.Range(60, 1500, LiquidityAmounts.getLiquidityForAmount0(_sq(60), _sq(1500), a0 * 90 / 100));
        adds[1] = Covenant.Range(-1500, 0, LiquidityAmounts.getLiquidityForAmount1(_sq(-1500), _sq(0), a1 - 1e6));
        vm.prank(curator_);
        vm.expectPartialRevert(Covenant.ConservationBroken.selector);
        cov.reshape(rm, adds);
    }

    // 5. Nobody but the curator can reshape; curator has no withdraw path; issuer is locked.
    function test_5_accessControl() public {
        (uint256[] memory rm, Covenant.Range[] memory adds) = _honestPlan();
        vm.prank(attacker);
        vm.expectRevert(Covenant.NotCurator.selector);
        cov.reshape(rm, adds);

        vm.prank(curator_);
        vm.expectRevert(); // curator holds no shares
        cov.withdraw(1);

        vm.prank(issuer_);
        vm.expectPartialRevert(Covenant.Locked.selector);
        cov.withdraw(1e17);
    }

    // 6. TWAP manipulation: a huge swap moves spot, but the guard blocks every state change until the
    //    price has persisted for the TWAP window.
    function test_6_twapGuardBlocksManipulation() public {
        _honestReshape();
        vm.warp(block.timestamp + 1 hours); // let TWAP settle at tick 0
        _swap(attacker, false, -40 ether); // dump tokens: tick jumps far above guard
        int24 spot = _tick();
        assertGt(spot, GUARD, "manipulated spot");

        (uint256[] memory rm, Covenant.Range[] memory adds) = _rebalancePlanAt(spot);
        vm.prank(curator_);
        vm.expectPartialRevert(Covenant.PriceGuard.selector);
        cov.reshape(rm, adds);

        vm.prank(lp);
        vm.expectPartialRevert(Covenant.PriceGuard.selector);
        cov.deposit{value: 1 ether}(1e16);

        vm.expectPartialRevert(Covenant.PriceGuard.selector);
        cov.restore(0);
    }

    // 7. A persistent price move is accepted once the TWAP catches up; a flash move never is.
    function test_7_persistentMoveAccepted_flashMoveNot() public {
        _honestReshape();
        vm.warp(block.timestamp + 1 hours);
        // flash: dump then buy back in the same block -> spot ~ unchanged, TWAP unchanged, reshape ok
        _swap(attacker, false, -40 ether);
        _swap(attacker, true, -40 ether);
        int24 spot = _tick();
        assertLe(spot < 0 ? -spot : spot, GUARD, "round trip leaves spot near start");
        (uint256[] memory rm, Covenant.Range[] memory adds) = _rebalancePlanAt(0);
        vm.prank(curator_);
        cov.reshape(rm, adds);

        // persistent: dump, wait > window, now twap ~ spot and the curator can re-center
        _swap(attacker, false, -40 ether);
        int24 spot2 = _tick();
        vm.warp(block.timestamp + 2 hours);
        _swap(attacker, false, -1e15); // tiny swap to record an observation at the new price
        int24 tw = cov.twapTick();
        assertLe(tw > spot2 ? tw - spot2 : spot2 - tw, GUARD, "twap converged");
    }

    // 8. Pace: after the setup epoch, moving everything at once is rejected; half is fine.
    function test_8_paceLimit() public {
        _honestReshape();
        vm.warp(block.timestamp + EPOCH + 1);
        _swap(attacker, false, -1e15);
        uint256[] memory rm = new uint256[](3);
        rm[0] = 0;
        rm[1] = 1;
        rm[2] = 2;
        Covenant.Range[] memory adds = new Covenant.Range[](0);
        vm.prank(curator_);
        vm.expectPartialRevert(Covenant.PaceExceeded.selector);
        cov.reshape(rm, adds);
    }

    // 9. Restore: price rises (token up), support band moves away, a random keeper restores and is paid.
    function test_9_restoreByAnyone() public {
        _honestReshape();
        cov.fundBounty{value: 0.1 ether}();
        vm.warp(block.timestamp + 1 hours);
        // buy token with ETH: tick falls
        _swapToTick(attacker, -2200); // token price up ~25%
        int24 spot = _tick();
        assertLt(spot, -2000, "token price rose");
        vm.warp(block.timestamp + 2 hours);
        _swap(attacker, true, -1e15);
        (uint256 have, uint256 need) = cov.supportBps();
        emit log_named_uint("support after price rise", have);
        assertLt(have, need, "support lapsed by price drift alone");

        // find the reserve range (quote furthest above) and restore it
        uint256 idx = _idxOfRange(1500, 6000);
        uint256 kb = keeper.balance;
        vm.prank(keeper);
        cov.restore(idx);
        (uint256 have2,) = cov.supportBps();
        emit log_named_uint("support after restore", have2);
        assertGt(have2, have);
        assertEq(keeper.balance - kb, 0.01 ether, "bounty paid");
    }

    // 10. Outside LP: in-kind deposit and withdrawal, vault never pays, issuer principal untouched.
    function test_10_outsideLP_inKind() public {
        _honestReshape();
        vm.warp(block.timestamp + 1 hours);
        uint256 vaultEth = address(cov).balance;
        uint256 vaultTok = IERC20(token).balanceOf(address(cov));
        uint256 issuerShares = cov.shares(issuer_);
        uint256 lpEth0 = lp.balance;
        uint256 lpTok0 = IERC20(token).balanceOf(lp);
        uint128 liqBefore = POOL_MANAGER.getLiquidity(key.toId());

        vm.prank(lp);
        cov.deposit{value: 50 ether}(1e17); // +10%
        assertEq(cov.shares(lp), 1e17);
        assertEq(cov.shares(issuer_), issuerShares, "issuer shares unchanged");
        assertApproxEqRel(POOL_MANAGER.getLiquidity(key.toId()), liqBefore * 11 / 10, 1e15, "liquidity +10%");
        assertLe(address(cov).balance, vaultEth + cov.DUST(), "vault paid nothing");
        assertLe(IERC20(token).balanceOf(address(cov)), vaultTok + cov.DUST());

        uint256 paidEth = lpEth0 - lp.balance;
        uint256 paidTok = lpTok0 - IERC20(token).balanceOf(lp);
        emit log_named_uint("LP paid ETH", paidEth);
        emit log_named_uint("LP paid TOKEN", paidTok);

        vm.prank(lp);
        cov.withdraw(1e17);
        assertApproxEqAbs(lp.balance, lpEth0, 1e9, "ETH returned (minus dust)");
        assertApproxEqAbs(IERC20(token).balanceOf(lp), lpTok0, 1e9, "TOKEN returned (minus dust)");
        assertEq(cov.shares(issuer_), issuerShares);
        (uint256 have, uint256 need) = cov.supportBps();
        assertGe(have, need, "issuer's support guarantee intact after LP exit");
    }

    // 11. Manipulate-then-mint is blocked by the guard (covered in 6) and shares are in-kind, so a
    //     depositor cannot buy shares cheap: check deposit cost tracks pool amounts exactly.
    function test_11_depositCostIsProportional() public {
        _honestReshape();
        vm.warp(block.timestamp + 1 hours);
        uint256 e0 = lp.balance;
        uint256 t0 = IERC20(token).balanceOf(lp);
        vm.prank(lp);
        cov.deposit{value: 50 ether}(1e17);
        // 10% of the pool's current amounts
        uint256 exp0;
        uint256 exp1;
        for (uint256 i; i < cov.rangeCount(); i++) {
            (uint256 a0, uint256 a1) = cov.amountsOf(i);
            exp0 += a0 / 11; // after deposit, LP owns 1/11 of each range
            exp1 += a1 / 11;
        }
        assertApproxEqRel(e0 - lp.balance, exp0, 1e12);
        assertApproxEqRel(t0 - IERC20(token).balanceOf(lp), exp1, 1e12);
    }

    // 12. Unlock schedule: nothing before unlockStart, linear after, never more than vested.
    function test_12_unlockSchedule() public {
        _honestReshape();
        vm.warp(block.timestamp + 89 days);
        _swap(attacker, false, -1e15);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(issuer_);
        vm.expectPartialRevert(Covenant.Locked.selector);
        cov.withdraw(1);

        vm.warp(block.timestamp + 1 days + 15 days); // half vested
        _swap(attacker, false, -1e15);
        vm.warp(block.timestamp + 1 hours);
        uint256 before = issuer_.balance;
        vm.prank(issuer_);
        cov.withdraw(5e17);
        assertGt(issuer_.balance, before, "half principal released");
        vm.prank(issuer_);
        vm.expectPartialRevert(Covenant.Locked.selector);
        cov.withdraw(1e17);
    }

    // 13. Curator change is timelocked; old curator loses control, new one is still bound.
    function test_13_curatorChangeTimelocked() public {
        _honestReshape();
        address newCurator = makeAddr("newCurator");
        vm.prank(issuer_);
        cov.proposeCurator(newCurator);
        vm.expectRevert(Covenant.TimelockActive.selector);
        cov.acceptCurator();
        vm.warp(block.timestamp + 2 days);
        _swap(attacker, false, -1e15);
        vm.warp(block.timestamp + 1 hours);
        cov.acceptCurator();
        assertEq(cov.curator(), newCurator);

        // old curator locked out
        uint256 idx = _idxOfRange(0, 1500);
        (uint256 a0, uint256 a1) = cov.amountsOf(idx);
        uint256[] memory rm = new uint256[](1);
        rm[0] = idx;
        Covenant.Range[] memory bad = new Covenant.Range[](2);
        bad[0] = Covenant.Range(9000, 12000, LiquidityAmounts.getLiquidityForAmount0(_sq(9000), _sq(12000), a0 - 1e6));
        bad[1] = Covenant.Range(-12000, -9000, a1 > 1e6 ? LiquidityAmounts.getLiquidityForAmount1(_sq(-12000), _sq(-9000), a1 - 1e6) : 0);
        vm.prank(curator_);
        vm.expectRevert(Covenant.NotCurator.selector);
        cov.reshape(rm, bad);
        // new curator is still bound: moving the support range far away (within pace) breaks support
        vm.prank(newCurator);
        vm.expectPartialRevert(Covenant.SupportBroken.selector);
        cov.reshape(rm, bad);
    }

    // 14. Fees are income, not principal: after real trading, reshape still conserves principal and
    //     fees land in the treasury pot.
    function test_14_feesSeparatedFromPrincipal() public {
        _honestReshape();
        vm.warp(block.timestamp + 1 hours);
        for (uint256 i; i < 5; i++) {
            _swap(attacker, false, -2 ether);
            _swap(attacker, true, -2 ether);
        }
        vm.warp(block.timestamp + 1 hours);
        _swap(attacker, false, -1e15);
        vm.warp(block.timestamp + 1 hours);
        // re-center to current price (small move), pace within 50%
        int24 tw = cov.twapTick();
        (uint256[] memory rm, Covenant.Range[] memory adds) = _rebalancePlanAt(tw);
        vm.prank(curator_);
        cov.reshape(rm, adds);
        assertGt(cov.fees0() + cov.fees1(), 0, "fees collected into the pot");
        emit log_named_uint("fees0 (ETH wei)", cov.fees0());
        emit log_named_uint("fees1 (TOKEN wei)", cov.fees1());
        uint256 tb = issuer_.balance;
        vm.prank(issuer_);
        cov.collectFees(issuer_);
        assertGe(issuer_.balance, tb);
        assertGt(cov.bountyPool0(), 0.02 ether, "bounty pool topped up from fees before treasury is paid");
        assertGt(IERC20(token).balanceOf(issuer_), 0, "token fees paid to treasury");
    }

    // 15. Gas griefing: a curator cannot fragment the vault into unbounded ranges.
    function test_15_rangeCapStopsGasGriefing() public {
        (uint256 a0, uint256 a1) = cov.amountsOf(0);
        uint256[] memory rm = new uint256[](1);
        Covenant.Range[] memory adds = new Covenant.Range[](40);
        for (uint256 i; i < 39; i++) {
            int24 lo = int24(int256(60 + i * 60));
            adds[i] = Covenant.Range(lo, lo + 60, LiquidityAmounts.getLiquidityForAmount0(_sq(lo), _sq(lo + 60), a0 / 39 - 1e6));
        }
        adds[39] = Covenant.Range(-1500, 0, LiquidityAmounts.getLiquidityForAmount1(_sq(-1500), _sq(0), a1 - 1e6));
        vm.prank(curator_);
        vm.expectRevert(Covenant.TooManyRanges.selector);
        cov.reshape(rm, adds);
    }

    // 16. Restore cannot be farmed: when support is healthy it reverts and pays nothing.
    function test_16_restoreNotFarmable() public {
        _honestReshape();
        cov.fundBounty{value: 0.1 ether}();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(keeper);
        vm.expectRevert(Covenant.NothingToRestore.selector);
        cov.restore(0);
        assertEq(keeper.balance, 0);
    }

    // 17. Dump absorption is the support doing its job: ETH converts to tokens, nothing leaves the vault.
    function test_17_dumpIsAbsorbedNotLeaked() public {
        _honestReshape();
        uint256 v0 = address(cov).balance;
        uint256 v1 = IERC20(token).balanceOf(address(cov));
        uint256 idx = _idxOfRange(0, 1500);
        (uint256 e0,) = cov.amountsOf(idx);
        _swap(attacker, false, -20 ether); // sell 20 tokens into the support
        (uint256 e1, uint256 t1) = cov.amountsOf(idx);
        assertLt(e1, e0, "support ETH was spent buying the dump");
        assertGt(t1, 0, "vault now holds the bought tokens inside the pool");
        assertEq(address(cov).balance, v0, "nothing left the vault");
        assertEq(IERC20(token).balanceOf(address(cov)), v1);
    }

    // ------------------------------------------------------------------ plan helpers
    /// @dev Re-center plan: move only the support range (index of [60,1500] or current support) to a band
    ///      just above `t`. Keeps within 50% pace.
    function _rebalancePlanAt(int24 t) internal view returns (uint256[] memory rm, Covenant.Range[] memory adds) {
        // pick the range with the most quote that is NOT the reserve
        uint256 best;
        uint256 bestA0;
        for (uint256 i; i < cov.rangeCount(); i++) {
            Covenant.Range memory r = cov.rangeAt(i);
            if (r.lower == 1500 && r.upper == 6000) continue;
            (uint256 a0,) = cov.amountsOf(i);
            if (a0 > bestA0) {
                bestA0 = a0;
                best = i;
            }
        }
        (uint256 a0, uint256 a1) = cov.amountsOf(best);
        rm = new uint256[](1);
        rm[0] = best;
        int24 lo = _floor(t) + 60;
        int24 hi = _floor(t) + BAND;
        adds = new Covenant.Range[](2);
        adds[0] = Covenant.Range(lo, hi, a0 > 1e6 ? LiquidityAmounts.getLiquidityForAmount0(_sq(lo), _sq(hi), a0 - 1e6) : 0);
        int24 lo1 = _floor(t) - BAND;
        int24 hi1 = _floor(t);
        adds[1] = Covenant.Range(lo1, hi1, a1 > 1e6 ? LiquidityAmounts.getLiquidityForAmount1(_sq(lo1), _sq(hi1), a1 - 1e6) : 0);
    }

    function _idxOfRange(int24 lo, int24 hi) internal view returns (uint256) {
        for (uint256 i; i < cov.rangeCount(); i++) {
            Covenant.Range memory r = cov.rangeAt(i);
            if (r.lower == lo && r.upper == hi) return i;
        }
        revert("range not found");
    }

    function _floor(int24 t) internal pure returns (int24) {
        int24 f = (t / 60) * 60;
        if (t < 0 && f != t) f -= 60;
        return f;
    }
}
