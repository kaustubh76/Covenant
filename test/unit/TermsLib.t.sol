// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Terms} from "../../src/types/CovenantTypes.sol";
import {TermsLib} from "../../src/libraries/TermsLib.sol";
import {TwapOracle} from "../../src/libraries/TwapOracle.sol";
import {Presets} from "../base/Presets.sol";

contract TermsHarness {
    function validate(Terms memory t, int24 spacing) external pure {
        TermsLib.validate(t, spacing, TwapOracle.MAX_WINDOW);
    }
}

contract TermsLibTest is Test {
    TermsHarness h = new TermsHarness();

    function test_specPresetsAreValid() public view {
        h.validate(Presets.conservative(), 60);
        h.validate(Presets.standard(), 60);
        h.validate(Presets.aggressive(), 60);
        h.validate(Presets.standard(), 200);
    }

    function test_rejectsEachOutOfBoundsTerm() public {
        Terms memory t = Presets.standard();
        t.supportBps = 0;
        vm.expectRevert(abi.encodeWithSelector(TermsLib.InvalidSupportBps.selector, 0));
        h.validate(t, 60);

        t = Presets.standard();
        t.supportBps = 10_001;
        vm.expectRevert(abi.encodeWithSelector(TermsLib.InvalidSupportBps.selector, 10_001));
        h.validate(t, 60);

        t = Presets.standard();
        t.guardTicks = 0;
        vm.expectRevert(abi.encodeWithSelector(TermsLib.InvalidGuardTicks.selector, 0));
        h.validate(t, 60);

        t = Presets.standard();
        t.supportBandTicks = 300 + 3 * 60 - 1; // one tick short of G + 3 spacings
        vm.expectRevert(abi.encodeWithSelector(TermsLib.InvalidSupportBand.selector, int24(479), int24(480)));
        h.validate(t, 60);

        t = Presets.standard();
        t.paceBps = 0;
        vm.expectRevert(abi.encodeWithSelector(TermsLib.InvalidPaceBps.selector, 0));
        h.validate(t, 60);

        t = Presets.standard();
        t.epochLength = 59 minutes;
        vm.expectRevert(abi.encodeWithSelector(TermsLib.InvalidEpochLength.selector, uint32(59 minutes)));
        h.validate(t, 60);

        t = Presets.standard();
        t.twapWindow = TwapOracle.MAX_WINDOW + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                TermsLib.InvalidTwapWindow.selector, TwapOracle.MAX_WINDOW + 1, TwapOracle.MAX_WINDOW
            )
        );
        h.validate(t, 60);
    }

    function test_bandMinimumScalesWithTickSpacing() public {
        Terms memory t = Presets.standard(); // B = 1500, G = 300
        h.validate(t, 400); // 300 + 1200 = 1500: exactly enough
        vm.expectRevert(abi.encodeWithSelector(TermsLib.InvalidSupportBand.selector, int24(1500), int24(1503)));
        h.validate(t, 401);
    }
}
