// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {TokenPricing} from "liquidity-launcher/src/libraries/TokenPricing.sol";
import {ITickStorage, Tick} from "continuous-clearing-auction/interfaces/ITickStorage.sol";

import {CovenantVault} from "../CovenantVault.sol";
import {Terms, Cut, Leg} from "../types/CovenantTypes.sol";
import {Orient} from "../libraries/Orient.sol";

/// @notice The CCA surface the planner reads.
interface IAuctionDemand is ITickStorage {
    function clearingPrice() external view returns (uint256);
}

/// @title SeedPlanner
/// @notice Builds a vault's first reshape from the auction's own demand curve.
/// @dev A CCA keeps every bid's demand at its price level, including bids that were outbid. After the auction those
///      levels below the clearing price say where real buyers were waiting. The planner turns them into bids:
///      - a core straddling the price, so the pool has depth at the price itself;
///      - `supportShareBps` of the quote as the covenant's support band, just under the price;
///      - the rest of the quote at the outbid levels, in proportion to their demand (the largest takes the remainder);
///      - every token as asks just above the price.
///      Pure view: anyone can recompute and check the plan before the curator submits it.
contract SeedPlanner {
    using StateLibrary for IPoolManager;

    uint16 internal constant SINK = type(uint16).max;
    /// @dev Bounds the walk. About 1,700 gas per level on mainnet pricing.
    uint256 public constant MAX_LEVELS_SCANNED = 1000;

    struct Level {
        int24 priceTick; // rises with the token's price
        uint256 demand; // the CCA's currencyDemandQ96 at that level
    }

    struct Params {
        uint16 supportShareBps; // quote into the support band; at least the vault's S
        uint16 coreShareBps; // of each currency into the core
        uint8 maxLevels; // outbid levels to place, largest demand first
        uint8 levelHalfWidth; // tick spacings on each side of a level
    }

    error NotEnoughRoom(uint256 legs);

    /// @notice Every price level below the clearing price that still holds demand, lowest first.
    function outbidDemand(IAuctionDemand auction, bool quoteIsCurrency0) public view returns (Level[] memory levels) {
        uint256 clearing = auction.clearingPrice();
        uint256 price = auction.floorPrice();
        levels = new Level[](MAX_LEVELS_SCANNED);
        uint256 n;
        for (uint256 i; i < MAX_LEVELS_SCANNED && price < clearing; i++) {
            Tick memory t = auction.ticks(price);
            if (t.currencyDemandQ96 > 0) levels[n++] = Level(priceTickOf(price, quoteIsCurrency0), t.currencyDemandQ96);
            if (t.next == type(uint256).max) break;
            price = t.next;
        }
        assembly ("memory-safe") {
            mstore(levels, n)
        }
    }

    /// @notice The price tick of a CCA price (quote per token, Q96), via the same conversion LBPStrategy uses to
    ///         initialize the pool.
    function priceTickOf(uint256 priceQ96, bool quoteIsCurrency0) public pure returns (int24) {
        uint160 sqrtPrice =
            TokenPricing.convertToSqrtPriceX96(TokenPricing.convertToPriceX192(priceQ96, quoteIsCurrency0));
        return Orient.toPrice(quoteIsCurrency0, TickMath.getTickAtSqrtPrice(sqrtPrice));
    }

    /// @dev Where the layout sits, read once.
    struct Frame {
        bool q0;
        int24 spacing;
        int24 coreLow; // price tick: one spacing below the aligned tick under the price
        int24 coreHigh; // price tick: one spacing above the aligned tick over the price
        int24 bandBottom; // price tick: bottom of the support leg, inside the covenant's band
        int24 band;
    }

    /// @notice A complete first reshape for `vault`: cut everything, lay it out by the auction's demand.
    function plan(CovenantVault vault, IAuctionDemand auction, Params calldata p)
        external
        view
        returns (Cut[] memory cuts, Leg[] memory legs)
    {
        Frame memory f = _frame(vault);
        uint256 n = vault.rangeCount();
        cuts = new Cut[](n);
        for (uint256 i; i < n; i++) {
            cuts[i] = Cut(i, type(uint128).max);
        }

        Level[] memory chosen = _largest(outbidDemand(auction, f.q0), p.maxLevels);
        if (chosen.length + 3 > 14) revert NotEnoughRoom(chosen.length + 3);
        legs = new Leg[](chosen.length + 3);
        legs[0] = _leg(f.q0, f.coreLow, f.coreHigh, p.coreShareBps, p.coreShareBps);
        // With no outbid demand the support leg takes all the quote.
        legs[1] = _leg(f.q0, f.bandBottom, f.coreLow, chosen.length == 0 ? SINK : p.supportShareBps, 0);
        // Bands need not be multiples of the spacing, so the asks' top is aligned up (every bound must be).
        legs[2] = _leg(f.q0, f.coreHigh, Orient.ceilTo(f.coreHigh + 2 * f.band, f.spacing), 0, SINK);
        if (chosen.length > 0) _demandLegs(legs, chosen, f, 1e4 - p.supportShareBps - p.coreShareBps, p.levelHalfWidth);
    }

    function _frame(CovenantVault vault) internal view returns (Frame memory f) {
        f.q0 = vault.quoteIsCurrency0();
        f.spacing = vault.poolKey().tickSpacing;
        f.band = vault.terms().supportBandTicks;
        (, int24 spotTick,,) = vault.poolManager().getSlot0(vault.poolId());
        int24 price = Orient.toPrice(f.q0, spotTick);
        f.coreLow = Orient.floorTo(price - 1, f.spacing) - f.spacing;
        f.coreHigh = Orient.ceilTo(price + 1, f.spacing) + f.spacing;
        f.bandBottom = Orient.ceilTo(price - f.band, f.spacing) + f.spacing;
    }

    /// @dev Demand legs from index 3. Shares follow demand; the largest level is the quote sink, so rounding and core
    ///      leftovers land where demand was strongest.
    function _demandLegs(Leg[] memory legs, Level[] memory chosen, Frame memory f, uint256 remaining, uint8 halfWidth)
        internal
        pure
    {
        uint256 total;
        uint256 largest;
        for (uint256 i; i < chosen.length; i++) {
            total += chosen[i].demand;
            if (chosen[i].demand > chosen[largest].demand) largest = i;
        }
        int24 half = int24(uint24(halfWidth)) * f.spacing;
        for (uint256 i; i < chosen.length; i++) {
            int24 top = Orient.floorTo(chosen[i].priceTick, f.spacing) + half;
            if (top > f.coreLow) top = f.coreLow; // strictly under the price
            uint16 share = i == largest ? SINK : uint16(remaining * chosen[i].demand / total);
            legs[3 + i] = _leg(f.q0, top - 2 * half, top, share, 0);
        }
    }

    /// @dev Up to `k` levels with the most demand.
    function _largest(Level[] memory levels, uint256 k) internal pure returns (Level[] memory out) {
        if (levels.length <= k) return levels;
        out = new Level[](k);
        bool[] memory taken = new bool[](levels.length);
        for (uint256 j; j < k; j++) {
            uint256 best;
            uint256 bestDemand;
            for (uint256 i; i < levels.length; i++) {
                if (!taken[i] && levels[i].demand > bestDemand) (best, bestDemand) = (i, levels[i].demand);
            }
            taken[best] = true;
            out[j] = levels[best];
        }
    }

    /// @dev A leg between two price ticks with a quote share and a token share.
    function _leg(bool q0, int24 priceLower, int24 priceUpper, uint16 quoteShare, uint16 tokenShare)
        internal
        pure
        returns (Leg memory)
    {
        (int24 lo, int24 hi) = Orient.rangeToPool(q0, priceLower, priceUpper);
        return q0 ? Leg(lo, hi, quoteShare, tokenShare) : Leg(lo, hi, tokenShare, quoteShare);
    }
}
