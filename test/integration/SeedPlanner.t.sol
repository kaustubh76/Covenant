// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SeedPlanner, IAuctionDemand} from "../../src/periphery/SeedPlanner.sol";
import {Terms, Cut, Leg} from "../../src/types/CovenantTypes.sol";
import {CovenantTestBase} from "../base/CovenantTestBase.sol";
import {Presets} from "../base/Presets.sol";

/// @notice SeedPlanner's plan must be a valid first reshape under any valid terms, not only the Standard preset the
///         demo uses. (Bands are not required to be multiples of the tick spacing.)
contract SeedPlannerTest is CovenantTestBase {
    SeedPlanner planner;

    function setUp() public override {
        super.setUp();
        planner = new SeedPlanner();
    }

    function test_seed_conservative() public {
        _seedsCleanly(Presets.conservative());
    }

    function test_seed_standard() public {
        _seedsCleanly(Presets.standard());
    }

    function test_seed_aggressive() public {
        _seedsCleanly(Presets.aggressive());
    }

    /// @notice A band that is not a multiple of the spacing still yields aligned legs.
    function test_seed_oddBand() public {
        Terms memory t = Presets.standard();
        t.supportBandTicks = 1337;
        _seedsCleanly(t);
    }

    function _seedsCleanly(Terms memory t) internal {
        _launch(t);
        // The share the web app's seedParamsFor gives the support leg: the demo's 50%, more for stricter terms.
        uint16 share = t.supportBps <= 4000 ? 5000 : uint16(t.supportBps + 1500 > 9000 ? 9000 : t.supportBps + 1500);
        (Cut[] memory cuts, Leg[] memory legs) = planner.plan(
            vault,
            IAuctionDemand(address(auction)),
            SeedPlanner.Params({supportShareBps: share, coreShareBps: 300, maxLevels: 6, levelHalfWidth: 2})
        );
        for (uint256 i; i < legs.length; i++) {
            assertEq(legs[i].tickLower % key.tickSpacing, 0, "lower bound aligned");
            assertEq(legs[i].tickUpper % key.tickSpacing, 0, "upper bound aligned");
        }
        vm.prank(curator);
        vault.reshape(cuts, legs, NEVER);
        (uint256 have, uint256 need) = vault.support();
        assertGe(have, need, "the seed meets the vault's own support minimum");
        _assertPositionsMatchPoolManager();
        _assertSolvent();
    }
}
