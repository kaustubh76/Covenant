// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PaceLib} from "../../src/libraries/PaceLib.sol";

contract PaceLibTest is Test {
    uint256 constant ONE = 1e9;

    function test_refillsLinearlyAndCapsAtM() public pure {
        // M = 50%, E = 1 day, starting empty at t = 1000
        assertEq(PaceLib.available(0, 1000, 5000, 1 days, 1000), 0);
        assertEq(PaceLib.available(0, 1000, 5000, 1 days, 1000 + 12 hours), ONE / 4, "half an epoch refills M/2");
        assertEq(PaceLib.available(0, 1000, 5000, 1 days, 1000 + 1 days), ONE / 2, "one epoch refills M");
        assertEq(PaceLib.available(0, 1000, 5000, 1 days, 1000 + 30 days), ONE / 2, "never more than M");
        assertEq(PaceLib.available(uint64(ONE / 2), 1000, 5000, 1 days, 1000 + 1 days), ONE / 2, "full stays full");
    }

    function test_noSingleBlockCanMoveMoreThanM() public pure {
        // Spend all of M, then ask again two seconds later: almost nothing is back.
        uint256 next = PaceLib.available(0, 1000, 5000, 1 days, 1002);
        assertLt(next, ONE / 40_000, "two seconds refill a negligible amount");
    }

    function testFuzz_availableNeverExceedsCap(uint64 budget, uint32 elapsed, uint16 paceBps, uint32 epoch)
        public
        pure
    {
        paceBps = uint16(bound(paceBps, 1, 1e4));
        epoch = uint32(bound(epoch, 1 hours, 30 days));
        uint256 cap = uint256(paceBps) * ONE / 1e4;
        budget = uint64(bound(budget, 0, cap));
        uint256 got = PaceLib.available(budget, 1000, paceBps, epoch, 1000 + uint256(elapsed));
        assertLe(got, cap);
        assertGe(got, budget);
    }

    function test_fractionRoundsUpAgainstTheCurator() public pure {
        assertEq(PaceLib.fraction(0, 100), 0);
        assertEq(PaceLib.fraction(1, 3), 333_333_334);
        assertEq(PaceLib.fraction(50, 100), ONE / 2);
        assertEq(PaceLib.fraction(1, 0), ONE, "moving anything of an empty vault is all of it");
        assertEq(PaceLib.fraction(200, 100), ONE);
    }
}
