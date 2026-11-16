// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {InitializerHook} from "liquidity-launcher/src/periphery/hooks/InitializerHook.sol";
import {IInitializerHook} from "liquidity-launcher/src/interfaces/IInitializerHook.sol";
import {ContinuousClearingAuction} from "continuous-clearing-auction/ContinuousClearingAuction.sol";

import {CovenantHook} from "../../src/CovenantHook.sol";
import {ICovenantHook} from "../../src/interfaces/ICovenantHook.sol";
import {UniswapStack} from "../base/UniswapStack.sol";
import {TestToken} from "../base/TestToken.sol";

contract CovenantHookTest is UniswapStack {
    using PoolIdLibrary for PoolKey;

    address attacker = makeAddr("attacker");
    address trader = makeAddr("trader");

    // A second deployment authorized to this test, so pools can be created directly.
    CovenantHook localHook;
    PoolModifyLiquidityTest lpRouter;
    TestToken token;

    function setUp() public override {
        super.setUp();
        localHook = _deployHook(address(this));
        lpRouter = new PoolModifyLiquidityTest(PM);
        token = new TestToken("T", "T", 18);
        token.mint(address(this), 1e30);
        token.approve(address(lpRouter), type(uint256).max);
        vm.deal(address(this), 1e30);
    }

    /// @dev ETH/token pool on `h` at tick 0 with deep full-range-ish liquidity.
    function _directPool(address h) internal returns (PoolKey memory key) {
        key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(token)), 3000, 60, IHooks(h));
        PM.initialize(key, TickMath.getSqrtPriceAtTick(0));
        lpRouter.modifyLiquidity{value: 1000 ether}(key, ModifyLiquidityParams(-60_000, 60_000, 1000 ether, 0), "");
    }

    // ------------------------------------------------------------------------------------------------ deployment

    function test_minedAddressCarriesExactlyTheThreeFlags() public view {
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, COVENANT_HOOK_FLAGS);
        assertEq(hook.authorized(), address(strategy));
        assertEq(hook.maxTickRate(), TICK_RATE);
    }

    function test_supportsTheInterfacesLBPStrategyChecks() public view {
        assertTrue(hook.supportsInterface(type(IInitializerHook).interfaceId), "IInitializerHook");
        assertTrue(hook.supportsInterface(type(IERC165).interfaceId), "IERC165");
        assertTrue(hook.supportsInterface(type(ICovenantHook).interfaceId), "ICovenantHook");
        assertFalse(hook.supportsInterface(0xdeadbeef));
    }

    function test_constructorRejectsAZeroTickRate() public {
        // Mine a valid address for rate 0, otherwise v4's hook-address check fails first.
        bytes memory args = abi.encode(PM, address(strategy), uint256(0));
        (, bytes32 salt) = HookMiner.find(address(this), COVENANT_HOOK_FLAGS, type(CovenantHook).creationCode, args);
        vm.expectRevert(abi.encodeWithSelector(ICovenantHook.InvalidTickRate.selector, 0));
        new CovenantHook{salt: salt}(PM, address(strategy), 0);
    }

    // ------------------------------------------------------------------------------------------------ the launch path

    /// @notice Uniswap's stock LBPStrategy accepts the hook, initializes the pool through it at the clearing price,
    ///         and the oracle starts there. No fork of Uniswap's contracts.
    function test_stockLBPStrategyLaunchesThroughTheHook() public {
        address holder = makeAddr("positionHolder");
        (ContinuousClearingAuction auction, PoolKey memory key,) = _register(_defaultSpec(holder));
        _runDefaultAuction(auction);
        (uint256 firstId,) = _closeAndMigrate(auction);

        (bool initialized, int24 initialTick, uint32 at) = hook.poolInfo(key.toId());
        assertTrue(initialized, "pool initialized under the hook");
        assertEq(initialTick, _tick(key), "oracle starts at the opening tick");
        assertEq(at, uint32(block.timestamp));
        assertEq(hook.consult(key.toId(), 1800), initialTick, "TWAP == clearing price at launch");
        assertEq(IERC721(address(POSM)).ownerOf(firstId), holder, "LP minted to the position recipient");
    }

    function test_onlyTheStrategyCanInitialize() public {
        PoolKey memory key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(token)), 3000, 60, IHooks(hook));
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(InitializerHook.InvalidInitializer.selector, attacker, address(strategy)),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        PM.initialize(key, TickMath.getSqrtPriceAtTick(0));
    }

    // ------------------------------------------------------------------------------------------------ the oracle

    function test_swapsFeedTheOracleAtTheSlewRate() public {
        PoolKey memory key = _directPool(address(localHook));
        PoolId id = key.toId();
        _swapToTick(key, trader, 3000, 10_000 ether); // token price falls: tick up
        assertEq(_tick(key), 3000);
        assertEq(localHook.recordedTick(id), 0, "same second: nothing recorded yet");
        skip(100);
        assertEq(localHook.recordedTick(id), int24(int256(TICK_RATE * 100)), "walks at the slew rate");
        skip(200);
        assertEq(localHook.recordedTick(id), 3000, "then arrives");
    }

    function test_sameBlockRoundTripLeavesTheTwapUnchanged() public {
        PoolKey memory key = _directPool(address(localHook));
        PoolId id = key.toId();
        // Park the price between two ticks. (A downward swap that stops exactly on a tick boundary reports the tick
        // below it, so a round trip to a boundary would come back one tick lower for reasons unrelated to the hook.)
        uint160 home = (TickMath.getSqrtPriceAtTick(0) + TickMath.getSqrtPriceAtTick(1)) / 2;
        _swap(key, trader, false, 1000 ether, home);
        skip(1 hours);
        int24 before = localHook.consult(id, 1800);
        assertEq(_tick(key), 0);

        _swapToTick(key, attacker, 50_000, 10_000 ether); // 50,000 ticks up...
        _swap(key, attacker, true, 10_000 ether, home); // ...and back, same block
        assertEq(_tick(key), 0, "spot is home");
        skip(10 minutes);
        assertEq(localHook.consult(id, 1800), before, "no trace");
    }

    function test_holdingAMoveForTheWindowMovesTheTwapAllTheWay() public {
        PoolKey memory key = _directPool(address(localHook));
        PoolId id = key.toId();
        _swapToTick(key, trader, 2000, 10_000 ether);
        skip(200 + 1800); // ramp (2000 / 10 s) + one window
        assertEq(localHook.consult(id, 1800), 2000);
    }

    /// @notice The hook returns no delta: a swap pays exactly what it pays in an identical hookless pool.
    function test_swapOutputIsIdenticalToAHooklessTwin() public {
        PoolKey memory hooked = _directPool(address(localHook));
        PoolKey memory plain = _directPool(address(0));
        uint256 t0 = token.balanceOf(trader);
        _swap(hooked, trader, true, 5 ether, 0);
        uint256 viaHook = token.balanceOf(trader) - t0;
        t0 = token.balanceOf(trader);
        _swap(plain, trader, true, 5 ether, 0);
        uint256 viaPlain = token.balanceOf(trader) - t0;
        assertEq(viaHook, viaPlain);
    }

    // ------------------------------------------------------------------------------------------------ gas

    /// @notice What the hook adds to a swap. Reported, and bounded so regressions fail loudly.
    function test_gas_afterSwapOverhead() public {
        PoolKey memory hooked = _directPool(address(localHook));
        PoolKey memory plain = _directPool(address(0));
        // warm both pools identically, then measure a swap that stays inside the current oracle slot
        _swap(hooked, trader, true, 1 ether, 0);
        _swap(plain, trader, true, 1 ether, 0);
        skip(10);

        uint256 g = gasleft();
        _swap(hooked, trader, true, 1 ether, 0);
        uint256 hookedGas = g - gasleft();
        g = gasleft();
        _swap(plain, trader, true, 1 ether, 0);
        uint256 plainGas = g - gasleft();
        emit log_named_uint("swap overhead, same oracle slot (gas)", hookedGas - plainGas);
        assertLt(hookedGas - plainGas, 12_000);

        skip(61); // the next swap opens a new slot (first lap: zero -> nonzero storage)
        g = gasleft();
        _swap(hooked, trader, true, 1 ether, 0);
        hookedGas = g - gasleft();
        g = gasleft();
        _swap(plain, trader, true, 1 ether, 0);
        plainGas = g - gasleft();
        emit log_named_uint("swap overhead, new oracle slot, first lap (gas)", hookedGas - plainGas);
        assertLt(hookedGas - plainGas, 35_000);
    }
}
