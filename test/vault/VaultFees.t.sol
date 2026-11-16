// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ICovenantVault} from "../../src/interfaces/ICovenantVault.sol";
import {TermsLib} from "../../src/libraries/TermsLib.sol";
import {Terms, VaultConfig} from "../../src/types/CovenantTypes.sol";
import {CovenantTestBase} from "../base/CovenantTestBase.sol";
import {Presets} from "../base/Presets.sol";

/// @notice Fees accrue pro rata to every share after the curator's cut. The issuer's principal earns for the
///         treasury, outside LPs earn for themselves, and the curator earns its share while in office.
contract VaultFeesTest is CovenantTestBase {
    address lp2 = makeAddr("lp2");

    function setUp() public override {
        super.setUp();
        _launch(Presets.standard()); // curatorFeeBps = 10%
        _honestSeed();
        _wait(1 days + 1); // past the setup epoch
        _fund(lp);
        _fund(lp2);
    }

    function test_fees_lpsEarnTheirShareAndTheCuratorItsCut() public {
        // the LP owns 1/11 of the vault after this deposit
        _deposit(lp, 1e17);
        _trade(10);

        (uint256 lpOwed0,) = _claimable(lp);
        vm.prank(lp);
        (uint256 lpGot0, uint256 lpGot1) = vault.claimFees();
        uint256 treasuryBefore = treasury.balance;
        vault.collectFees();
        uint256 treasuryGot = treasury.balance - treasuryBefore;
        vm.prank(curator);
        (uint256 curatorGot0,) = vault.claimCuratorFees();

        uint256 total0 = lpGot0 + treasuryGot + curatorGot0 + vault.bountyPool();
        emit log_named_decimal_uint("fees realized, quote (ETH)", total0, 18);
        assertApproxEqRel(curatorGot0, total0 / 10, 0.01e18, "curator: 10%");
        assertApproxEqRel(lpGot0, total0 * 9 / 10 / 11, 0.01e18, "LP: 1/11 of the other 90%");
        assertGt(lpGot1, 0, "token fees too");
        assertGe(lpGot0, lpOwed0, "claim includes what the claim itself realized");
        _assertSolvent();
    }

    /// @notice Joining after fees accrued earns none of them: the deposit's own touch credits them to the shares
    ///         that were there.
    function test_fees_aNewcomerEarnsNothingFromBeforeTheyJoined() public {
        _trade(10); // fees sit unrealized in the positions
        _deposit(lp, 1e17);
        (uint256 owed0, uint256 owed1) = vault.feesOwed(lp);
        assertEq(owed0, 0);
        assertEq(owed1, 0);
        vm.prank(lp);
        (uint256 got0, uint256 got1) = vault.claimFees();
        assertEq(got0 + got1, 0, "nothing from before");
    }

    /// @notice Leaving keeps everything the burned shares earned, including fees the exit itself realized.
    function test_fees_anExitKeepsWhatItsSharesEarned() public {
        _deposit(lp, 1e17);
        _trade(10); // unrealized until something touches the ranges
        vm.prank(lp);
        vault.withdraw(1e17, 0, 0, NEVER);
        assertEq(vault.sharesOf(lp), 0);
        (uint256 owed0,) = vault.feesOwed(lp);
        assertGt(owed0, 0, "earned while holding");
        vm.prank(lp);
        (uint256 got0,) = vault.claimFees();
        assertEq(got0, owed0);
    }

    function test_fees_twoLpsSplitInProportionToTheirShares() public {
        _deposit(lp, 1e17);
        _deposit(lp2, 3e17);
        _trade(10);
        vm.prank(lp);
        (uint256 a,) = vault.claimFees();
        vm.prank(lp2);
        (uint256 b,) = vault.claimFees();
        assertApproxEqRel(b, a * 3, 1e14, "three times the shares, three times the fees");
    }

    /// @notice The curator's cut goes to whoever was curator when the fees were realized.
    function test_fees_curatorCutFollowsTheCuratorInOffice() public {
        _trade(5);
        vault.collectFees(); // realizes the first batch under the original curator
        address next = makeAddr("nextCurator");
        vm.prank(issuer);
        vault.proposeCurator(next);
        _wait(2 days);
        vault.acceptCurator();
        _trade(5);
        vault.collectFees();

        vm.prank(curator);
        (uint256 first,) = vault.claimCuratorFees();
        vm.prank(next);
        (uint256 second,) = vault.claimCuratorFees();
        assertGt(first, 0, "the old curator keeps what it earned");
        assertGt(second, 0, "the new curator earns from its start");
    }

    /// @notice After everyone claims, only rounding dust is left in the fee pot.
    function test_fees_nothingIsStuck() public {
        _deposit(lp, 1e17);
        _deposit(lp2, 2e17);
        _trade(10);
        vm.prank(lp);
        vault.claimFees();
        vm.prank(lp2);
        vault.claimFees();
        vault.collectFees();
        vm.prank(curator);
        vault.claimCuratorFees();
        assertLe(vault.feePot0(), 10, "dust only");
        assertLe(vault.feePot1(), 10);
    }

    function test_fees_curatorShareIsBounded() public {
        Terms memory t = Presets.standard();
        t.curatorFeeBps = 3001;
        vm.expectRevert(abi.encodeWithSelector(TermsLib.InvalidCuratorFeeBps.selector, 3001));
        factory.createVault(key, VaultConfig(true, t, issuer, treasury, curator), bytes32("x"));
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _fund(address who) internal {
        vm.deal(who, 100_000 ether);
        token.mint(who, 100_000 ether);
        vm.prank(who);
        token.approve(address(vault), type(uint256).max);
    }

    function _deposit(address who, uint256 shares) internal {
        vm.prank(who);
        vault.deposit{value: 5000 ether}(shares, type(uint256).max, type(uint256).max, NEVER);
    }

    /// @dev Round trips through the core and support, generating fees in both currencies.
    function _trade(uint256 roundTrips) internal {
        for (uint256 i; i < roundTrips; i++) {
            _swap(key, trader, !q0, 3 ether, 0);
            _swap(key, trader, q0, 3 ether, 0);
        }
    }

    function _claimable(address who) internal view returns (uint256, uint256) {
        return vault.feesOwed(who);
    }
}

/// @notice Separate fixture: the launch must not be adopted in setUp.
contract VaultFeesBeforeAdoptionTest is CovenantTestBase {
    /// @notice Fees the launcher's position earned between migration and adoption go to the issuer, not limbo.
    function test_fees_earnedBeforeAdoptionGoToTheIssuer() public {
        _launchUnadopted(Presets.standard());
        for (uint256 i; i < 5; i++) {
            _swap(key, trader, !q0, 3 ether, 0);
            _swap(key, trader, q0, 3 ether, 0);
        }
        _adoptAll();
        (uint256 owed0, uint256 owed1) = vault.feesOwed(address(0));
        assertGt(owed0, 0, "issuer owed the pre-adoption quote fees");
        assertGt(owed1, 0, "and token fees");
        assertEq(owed0, vault.feePot0(), "nothing unattributed");
        uint256 before = treasury.balance;
        vault.collectFees();
        assertGt(treasury.balance - before + vault.bountyPool(), 0);
    }
}
