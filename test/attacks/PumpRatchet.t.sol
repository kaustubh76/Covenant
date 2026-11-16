// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ICovenantVault} from "../../src/interfaces/ICovenantVault.sol";
import {Range} from "../../src/types/CovenantTypes.sol";
import {Orient} from "../../src/libraries/Orient.sol";
import {CovenantTestBase} from "../base/CovenantTestBase.sol";
import {Presets} from "../base/Presets.sol";

/// @notice The pump-ratchet, run against the production vault with the same script that drained 82% of the
///         prototype's quote (test/prototype/PumpRatchetPoC.t.sol):
///           1. buy every ask, 2. push the price through the empty ticks above them, 3. hold it,
///           4. call restore to drag the vault's quote up under the price, 5. sell back.
///         Here step 4 has nothing to work with, both for a quick pump and for a patient one held for days while
///         the Anchor is kept synced. The attacker pays the swap fees and the vault keeps them.
contract PumpRatchetTest is CovenantTestBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    int24 constant PUMP = 30_000; // token price x20, as in the prototype proof of concept
    uint256 constant ATTACKER_ETH = 100_000 ether;

    int24 seedPrice;
    uint256 quoteBefore;
    uint256 tokensBefore;

    function setUp() public override {
        super.setUp();
        _launch(Presets.standard());
        seedPrice = _spotPrice();
        _honestSeed();
        vm.deal(address(this), 1 ether);
        vault.fundBounty{value: 0.1 ether}(0.1 ether);
        _wait(1 hours);

        vm.deal(attacker, ATTACKER_ETH);
        vm.prank(attacker);
        IERC20(address(token)).approve(address(swapRouter), type(uint256).max);
        (quoteBefore, tokensBefore) = _principal();
    }

    function test_pumpRatchet_quickPumpFindsNothingToRestore() public {
        uint256 bought = _pumpThroughTheAsks();
        _wait(2 hours);
        assertApproxEqAbs(int256(_twapPrice()), int256(seedPrice + PUMP), 1, "TWAP has followed the pump");

        // The filled asks are quote just under the old price, and the band reaches down to them.
        (uint256 have, uint256 need) = vault.support();
        emit log_named_uint("support at the pumped TWAP (bps)", have);
        assertGe(have, need, "support has not lapsed");

        uint256[] memory idx = _quoteRanges();
        vm.prank(attacker);
        vm.expectPartialRevert(ICovenantVault.NothingToRestore.selector);
        vault.restore(idx, NEVER);

        _sellBack(bought);
        _report();
    }

    function test_pumpRatchet_patientPumpCannotPullRestoreAboveWhereTheVaultSold() public {
        uint256 bought = _pumpThroughTheAsks();
        // Hold the pump for four days while a keeper (or the attacker) syncs the Anchor every 15 minutes. The Anchor
        // climbs one band a day; after four the band has floated above the filled asks and Support reads as lapsed.
        _keepPoked(4 days);
        int24 a = vault.anchor();
        emit log_named_int("anchor climb over four days (ticks)", int256(a) - seedPrice);
        (uint256 have, uint256 need) = vault.support();
        emit log_named_uint("support after four days (bps)", have);
        assertLt(have, need, "support lapsed");

        // Restore would now bid where the vault never offered anything. It refuses.
        uint256[] memory idx = _quoteRanges();
        vm.prank(attacker);
        vm.expectPartialRevert(ICovenantVault.RestoreBandEmpty.selector);
        vault.restore(idx, NEVER);

        _sellBack(bought);
        _report();
    }

    // =========================================================================================== helpers

    /// @return bought Tokens the attacker bought, all of them from the vault's asks.
    function _pumpThroughTheAsks() internal returns (uint256 bought) {
        vm.startPrank(attacker);
        swapRouter.swap{value: ATTACKER_ETH}(
            key,
            SwapParams({
                zeroForOne: q0,
                amountSpecified: -int256(ATTACKER_ETH),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(Orient.toPool(q0, seedPrice + PUMP))
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        bought = token.balanceOf(attacker);
        assertEq(_spotPrice(), seedPrice + PUMP, "price sits wherever the attacker put it");
    }

    function _sellBack(uint256 amount) internal {
        vm.startPrank(attacker);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: !q0,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: q0 ? TickMath.MAX_SQRT_PRICE - 1 : TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        assertEq(token.balanceOf(attacker), 0, "attacker is flat in tokens again");
    }

    function _report() internal {
        (uint256 quoteAfter, uint256 tokensAfter) = _principal();
        int256 pnl = int256(attacker.balance) - int256(ATTACKER_ETH);
        emit log_named_decimal_int("attacker profit (ETH)          ", pnl, 18);
        emit log_named_decimal_uint("vault principal quote before   ", quoteBefore, 18);
        emit log_named_decimal_uint("vault principal quote after    ", quoteAfter, 18);
        emit log_named_decimal_uint("vault principal tokens before  ", tokensBefore, 18);
        emit log_named_decimal_uint("vault principal tokens after   ", tokensAfter, 18);
        assertLt(pnl, 0, "the attack costs the attacker");
        assertGe(quoteAfter + 1e9, quoteBefore, "the vault keeps its quote");
        assertApproxEqRel(tokensAfter, tokensBefore, 0.004e18, "and gets its tokens back (less the fee, kept as fees)");
        _assertSolvent();
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
}
