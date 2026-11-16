// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ILBPInitializer} from "liquidity-launcher/src/interfaces/ILBPInitializer.sol";
import {PositionDefinition} from "liquidity-launcher/src/types/PositionPlannerTypes.sol";
import {MigratorParameters} from "liquidity-launcher/src/libraries/MigratorParams.sol";

import {CovenantFactory} from "../CovenantFactory.sol";
import {CovenantVault} from "../CovenantVault.sol";
import {Terms, Range} from "../types/CovenantTypes.sol";
import {Orient} from "../libraries/Orient.sol";
import {RangeMath} from "../libraries/RangeMath.sol";

/// @notice The part of LBPStrategy the lens reads: the migration a launch committed to.
interface ICommittedLaunch {
    function initializers(ILBPInitializer initializer) external view returns (MigratorParameters memory);
}

/// @title CovenantLens
/// @notice Read-only views for bidders, dashboards and keepers.
///         - `verifyLaunch`: before bidding, check that a launch's liquidity really goes to a Covenant vault bound to
///           this pool, and read the terms that will bind it.
///         - `snapshot`: everything about a vault in one call.
contract CovenantLens {
    using StateLibrary for IPoolManager;

    struct LaunchCheck {
        /// @dev Every check below passes.
        bool ok;
        /// @dev The LP recipient is a vault this factory created.
        bool isCovenantVault;
        /// @dev The pool the launch will create is hooked by this factory's hook.
        bool hookIsCovenant;
        /// @dev The pool key the launch commits to is exactly the one the vault is bound to, quote on the right side.
        bool poolMatchesVault;
        /// @dev Every LP position the launcher will mint goes to the vault (no per-position overrides elsewhere).
        bool lpGoesToVault;
        /// @dev The vault holds nothing yet, so nothing else has been bound to it first.
        bool vaultIsFresh;
        address vault;
        Terms terms;
        address issuer;
        address treasury;
        address curator;
        uint128 tokensReservedForLp;
    }

    struct RangeView {
        int24 tickLower;
        int24 tickUpper;
        int24 priceLower; // price ticks: rise with the token's price
        int24 priceUpper;
        uint128 liquidity;
        uint256 quote; // held at the spot price
        uint256 token;
    }

    struct VaultState {
        PoolKey key;
        bool quoteIsCurrency0;
        Terms terms;
        int24 spotPrice;
        int24 twapPrice;
        int24 anchor;
        bool guardPasses;
        uint256 supportBps;
        uint256 paceAvailable;
        uint256 totalValue;
        uint256 principalQuote;
        uint256 principalToken;
        uint256 totalShares;
        uint256 principalShares;
        uint256 principalWithdrawable;
        uint256 idle0;
        uint256 idle1;
        uint256 feePot0;
        uint256 feePot1;
        uint256 bountyPool;
        address issuer;
        address curator;
        address pendingCurator;
        uint64 curatorReadyAt;
        uint64 adoptedAt;
        uint64 setupEndsAt;
        uint64 unlockStartsAt;
        uint64 fullyVestedAt;
        RangeView[] ranges;
    }

    /// @notice Check a registered launch before bidding on it.
    /// @param strategy The LBPStrategy the launch was registered with.
    /// @param auction The launch's initializer (the CCA).
    function verifyLaunch(CovenantFactory factory, ICommittedLaunch strategy, address auction)
        external
        view
        returns (LaunchCheck memory c)
    {
        MigratorParameters memory mp = strategy.initializers(ILBPInitializer(auction));
        c.vault = mp.positionRecipient;
        c.tokensReservedForLp = mp.reservedTokenAmountForLP;
        c.isCovenantVault = factory.isVault(c.vault);
        c.hookIsCovenant = mp.poolParameters.hook == address(factory.hook());
        c.lpGoesToVault = _allPositionsTo(mp.positionDefinitions, c.vault);
        if (!c.isCovenantVault) return c;

        CovenantVault vault = CovenantVault(payable(c.vault));
        c.terms = vault.terms();
        c.issuer = vault.issuer();
        c.treasury = vault.treasury();
        c.curator = vault.curator();
        c.poolMatchesVault = _poolMatches(vault, mp);
        c.vaultIsFresh = vault.adoptedAt() == 0 && vault.rangeCount() == 0;
        c.ok = c.hookIsCovenant && c.lpGoesToVault && c.poolMatchesVault && c.vaultIsFresh;
    }

    /// @notice Everything about a vault, priced at the current spot and TWAP. Before the launch migrates there is no pool
    ///         yet: prices, Support and Pace read as zero and the terms, people and ledger are still returned.
    function snapshot(CovenantVault vault) external view returns (VaultState memory s) {
        s.key = vault.poolKey();
        s.quoteIsCurrency0 = vault.quoteIsCurrency0();
        s.terms = vault.terms();
        _prices(vault, s);
        _ledger(vault, s);
        _timeline(vault, s);
        _ranges(vault, s);
    }

    // ------------------------------------------------------------------------------------------------ internals

    function _prices(CovenantVault vault, VaultState memory s) internal view {
        (uint160 sqrtP, int24 spotTick,,) = vault.poolManager().getSlot0(vault.poolId());
        // Before migration the pool does not exist yet: there is no price, and the rest of the snapshot still reads.
        if (sqrtP == 0) return;
        int24 twapTick = vault.hook().consult(vault.poolId(), s.terms.twapWindow);
        s.spotPrice = Orient.toPrice(s.quoteIsCurrency0, spotTick);
        s.twapPrice = Orient.toPrice(s.quoteIsCurrency0, twapTick);
        int256 gap = int256(spotTick) - int256(twapTick);
        s.guardPasses = gap <= s.terms.guardTicks && gap >= -int256(s.terms.guardTicks);
        if (vault.adoptedAt() == 0) return;
        s.anchor = vault.anchor();
        (s.supportBps,) = vault.support();
        s.paceAvailable = vault.paceAvailable();
        s.totalValue = vault.totalValue();
    }

    function _ledger(CovenantVault vault, VaultState memory s) internal view {
        s.totalShares = vault.totalShares();
        s.principalShares = vault.principalShares();
        s.principalWithdrawable = vault.principalWithdrawable();
        s.idle0 = vault.idle0();
        s.idle1 = vault.idle1();
        s.feePot0 = vault.feePot0();
        s.feePot1 = vault.feePot1();
        s.bountyPool = vault.bountyPool();
        s.issuer = vault.issuer();
        s.curator = vault.curator();
        s.pendingCurator = vault.pendingCurator();
        s.curatorReadyAt = vault.curatorReadyAt();
    }

    function _timeline(CovenantVault vault, VaultState memory s) internal view {
        s.adoptedAt = vault.adoptedAt();
        if (s.adoptedAt == 0) return;
        s.setupEndsAt = s.adoptedAt + s.terms.epochLength;
        s.unlockStartsAt = s.adoptedAt + s.terms.lockDuration;
        s.fullyVestedAt = s.unlockStartsAt + s.terms.vestDuration;
    }

    function _ranges(CovenantVault vault, VaultState memory s) internal view {
        (uint160 sqrtP,,,) = vault.poolManager().getSlot0(vault.poolId());
        Range[] memory rs = vault.ranges();
        s.ranges = new RangeView[](rs.length);
        uint256 a0Total = s.idle0;
        uint256 a1Total = s.idle1;
        for (uint256 i; i < rs.length; i++) {
            Range memory r = rs[i];
            (uint256 a0, uint256 a1) = RangeMath.amounts(sqrtP, r.tickLower, r.tickUpper, r.liquidity);
            (uint256 quote, uint256 tk) = Orient.split(s.quoteIsCurrency0, a0, a1);
            (int24 pl, int24 pu) = Orient.rangeToPrice(s.quoteIsCurrency0, r.tickLower, r.tickUpper);
            s.ranges[i] = RangeView(r.tickLower, r.tickUpper, pl, pu, r.liquidity, quote, tk);
            a0Total += a0;
            a1Total += a1;
        }
        (s.principalQuote, s.principalToken) = Orient.split(s.quoteIsCurrency0, a0Total, a1Total);
    }

    function _allPositionsTo(bytes memory positionDefinitions, address vault) internal pure returns (bool) {
        PositionDefinition[] memory defs = abi.decode(positionDefinitions, (PositionDefinition[]));
        for (uint256 i; i < defs.length; i++) {
            address r = defs[i].overridePositionRecipient;
            if (r != address(0) && r != vault) return false;
        }
        return true;
    }

    function _poolMatches(CovenantVault vault, MigratorParameters memory mp) internal view returns (bool) {
        PoolKey memory k = vault.poolKey();
        (address c0, address c1) = mp.currency < mp.token ? (mp.currency, mp.token) : (mp.token, mp.currency);
        bool quoteIs0 = mp.currency < mp.token;
        return Currency.unwrap(k.currency0) == c0 && Currency.unwrap(k.currency1) == c1
            && k.fee == mp.poolParameters.fee && k.tickSpacing == mp.poolParameters.tickSpacing
            && address(k.hooks) == mp.poolParameters.hook && vault.quoteIsCurrency0() == quoteIs0;
    }
}
