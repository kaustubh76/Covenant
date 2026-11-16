// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PositionDefinition} from "liquidity-launcher/src/types/PositionPlannerTypes.sol";
import {ContinuousClearingAuction} from "continuous-clearing-auction/ContinuousClearingAuction.sol";

import {CovenantVault} from "../../src/CovenantVault.sol";
import {CovenantLens, ICommittedLaunch} from "../../src/periphery/CovenantLens.sol";
import {VaultConfig} from "../../src/types/CovenantTypes.sol";
import {CovenantTestBase} from "../base/CovenantTestBase.sol";
import {TestToken} from "../base/TestToken.sol";
import {Presets} from "../base/Presets.sol";

contract LensTest is CovenantTestBase {
    CovenantLens lens;

    function setUp() public override {
        super.setUp();
        lens = new CovenantLens();
    }

    // ------------------------------------------------------------------------------------------------ verifyLaunch

    function test_lens_aGenuineLaunchVerifies() public {
        _createAndRegister(Presets.standard());
        CovenantLens.LaunchCheck memory c = _check();
        assertTrue(c.ok, "verifies");
        assertEq(c.vault, address(vault));
        assertEq(c.terms.supportBps, 4000);
        assertEq(c.issuer, issuer);
        assertEq(c.curator, curator);
        assertEq(c.tokensReservedForLp, 100 ether);
    }

    function test_lens_flagsARecipientThatIsNotACovenantVault() public {
        _vaultFor(3000, 60);
        LaunchSpec memory s = _defaultSpec(attacker);
        (auction,) = _register(s, token);
        CovenantLens.LaunchCheck memory c = _check();
        assertFalse(c.ok);
        assertFalse(c.isCovenantVault);
    }

    function test_lens_flagsAPoolTheVaultIsNotBoundTo() public {
        _vaultFor(3000, 60);
        LaunchSpec memory s = _defaultSpec(address(vault));
        s.fee = 10_000; // a different pool than the vault was created for
        s.tickSpacing = 200;
        (auction,) = _register(s, token);
        CovenantLens.LaunchCheck memory c = _check();
        assertTrue(c.isCovenantVault);
        assertTrue(c.hookIsCovenant);
        assertFalse(c.poolMatchesVault, "pool mismatch caught");
        assertFalse(c.ok);
    }

    function test_lens_flagsLpPositionsSentElsewhere() public {
        _vaultFor(3000, 60);
        LaunchSpec memory s = _defaultSpec(address(vault));
        s.positions = new PositionDefinition[](1);
        s.positions[0] = PositionDefinition({
            offsetLower: -6000,
            offsetUpper: 6000,
            weight: 5e6,
            overridePositionRecipient: attacker
        });
        (auction,) = _register(s, token);
        CovenantLens.LaunchCheck memory c = _check();
        assertFalse(c.lpGoesToVault, "an override recipient is caught");
        assertFalse(c.ok);
    }

    function test_lens_aVaultIsNoLongerFreshOnceAdopted() public {
        _launch(Presets.standard());
        CovenantLens.LaunchCheck memory c = _check();
        assertFalse(c.vaultIsFresh);
        assertFalse(c.ok);
    }

    // ------------------------------------------------------------------------------------------------ snapshot

    /// @notice A dashboard can read a vault before its launch migrates: no prices yet, but the terms and people.
    function test_lens_snapshotWorksBeforeMigration() public {
        _createAndRegister(Presets.standard());
        CovenantLens.VaultState memory s = lens.snapshot(vault);
        assertEq(s.terms.supportBps, 4000);
        assertEq(s.issuer, issuer);
        assertEq(s.curator, curator);
        assertEq(s.adoptedAt, 0);
        assertEq(s.supportBps, 0);
        assertFalse(s.guardPasses);
        assertEq(s.ranges.length, 0);
    }

    function test_lens_snapshotMatchesTheVault() public {
        _launch(Presets.standard());
        _honestSeed();
        CovenantLens.VaultState memory s = lens.snapshot(vault);
        (uint256 have,) = vault.support();
        assertEq(s.supportBps, have);
        assertEq(s.anchor, vault.anchor());
        assertEq(s.spotPrice, _spotPrice());
        assertTrue(s.guardPasses);
        assertEq(s.ranges.length, vault.rangeCount());
        (uint256 q, uint256 t) = _principal();
        assertEq(s.principalQuote, q);
        assertEq(s.principalToken, t);
        assertEq(s.totalShares, 1e18);
        assertEq(s.setupEndsAt, s.adoptedAt + 1 days);
        assertEq(s.unlockStartsAt, s.adoptedAt + 90 days);
        assertEq(s.fullyVestedAt, s.adoptedAt + 120 days);
        uint256 sumQuote = s.idle0;
        for (uint256 i; i < s.ranges.length; i++) {
            sumQuote += s.ranges[i].quote;
            assertLt(s.ranges[i].priceLower, s.ranges[i].priceUpper);
        }
        assertEq(sumQuote, s.principalQuote, "ranges add up");
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _check() internal view returns (CovenantLens.LaunchCheck memory) {
        return lens.verifyLaunch(factory, ICommittedLaunch(address(strategy)), address(auction));
    }

    /// @dev A vault for a new token's pool with the given fee and spacing, not yet registered with any launch.
    function _vaultFor(uint24 fee, int24 spacing) internal {
        terms = Presets.standard();
        token = new TestToken("Launch", "LNCH", 18);
        key = _poolKey(address(0), address(token), fee, spacing, address(hook));
        q0 = true;
        vault = CovenantVault(
            payable(factory.createVault(key, VaultConfig(true, terms, issuer, treasury, curator), bytes32(0)))
        );
    }
}
