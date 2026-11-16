// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ContinuousClearingAuction} from "continuous-clearing-auction/ContinuousClearingAuction.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {ActionConstants} from "@uniswap/v4-periphery/src/libraries/ActionConstants.sol";
import {CovenantHook} from "../../src/CovenantHook.sol";

import {CovenantFactory} from "../../src/CovenantFactory.sol";
import {CovenantVault} from "../../src/CovenantVault.sol";
import {VaultOps} from "../../src/vault/VaultOps.sol";
import {Terms, Range, Cut, Leg, VaultConfig} from "../../src/types/CovenantTypes.sol";
import {Orient} from "../../src/libraries/Orient.sol";
import {RangeMath} from "../../src/libraries/RangeMath.sol";
import {UniswapStack} from "./UniswapStack.sol";
import {TestToken} from "./TestToken.sol";
import {Presets} from "./Presets.sol";

/// @notice A Covenant launch end to end on Uniswap's real stack: the issuer creates the vault before the auction,
///         the real CCA runs, the real LBPStrategy migrates into a pool hooked by CovenantHook and mints the LP to the
///         vault, and the vault adopts it.
abstract contract CovenantTestBase is UniswapStack {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint16 internal constant SINK = type(uint16).max;
    uint256 internal constant NEVER = type(uint256).max;

    VaultOps internal ops;
    CovenantFactory internal factory;

    CovenantVault internal vault;
    PoolKey internal key;
    TestToken internal token;
    ContinuousClearingAuction internal auction;
    Terms internal terms;
    bool internal q0;

    address internal issuer = makeAddr("issuer");
    address internal treasury = makeAddr("treasury");
    address internal curator = makeAddr("curator");
    address internal keeper = makeAddr("keeper");
    address internal attacker = makeAddr("attacker");
    address internal lp = makeAddr("outsideLP");
    address internal trader = makeAddr("trader");

    function setUp() public virtual override {
        super.setUp();
        ops = new VaultOps(PM);
        factory = new CovenantFactory(PM, POSM, hook, ops);
    }

    // ------------------------------------------------------------------------------------------------ launch

    /// @notice ETH-quoted launch with the given terms, migrated and adopted.
    function _launch(Terms memory t) internal {
        _launchUnadopted(t);
        _adoptAll();
    }

    function _launchUnadopted(Terms memory t) internal {
        _createAndRegister(t);
        _runDefaultAuction(auction);
        (firstLpId, lastLpId) = _closeAndMigrate(auction);
    }

    /// @notice Stage 0: the issuer creates the vault, then registers the CCA launch naming it as LP recipient.
    function _createAndRegister(Terms memory t) internal {
        terms = t;
        token = new TestToken("Launch", "LNCH", 18);
        key = _poolKey(address(0), address(token), 3000, 60, address(hook));
        q0 = true;
        vault = CovenantVault(
            payable(
                factory.createVault(
                    key,
                    VaultConfig({quoteIsCurrency0: true, terms: t, issuer: issuer, treasury: treasury, curator: curator}),
                    bytes32(0)
                )
            )
        );
        (auction,) = _register(_defaultSpec(address(vault)), token);
    }

    uint256 internal firstLpId;
    uint256 internal lastLpId;

    // ------------------------------------------------------------------------------------------------ direct launch

    /// @notice A launch without the auction: the pool is initialized at `priceTick` and a launcher-style full-range LP
    ///         NFT is minted to the vault, the way LBPStrategy does it. This is how the suite runs ERC20 quotes on
    ///         either side of the pool (the CCA would need Permit2, which this toolchain cannot compile).
    /// @param nativeQuote Quote is native ETH (always currency0).
    /// @param quoteIsCurrency0 For an ERC20 quote, which side of the pool it sorts to.
    function _launchDirect(Terms memory t, bool nativeQuote, bool quoteIsCurrency0, int24 priceTick) internal {
        terms = t;
        CovenantHook directHook = _deployHook(address(this));
        CovenantFactory directFactory = new CovenantFactory(PM, POSM, directHook, ops);
        hook = directHook; // views in this base read the hook of the pool under test
        factory = directFactory;

        token = new TestToken("Launch", "LNCH", 18);
        address quote;
        if (nativeQuote) {
            quote = address(0);
            q0 = true;
        } else {
            TestToken qt = new TestToken("Quote", "QUOTE", 18);
            // redeploy until the quote sorts to the requested side
            while ((address(qt) < address(token)) != quoteIsCurrency0) {
                qt = new TestToken("Quote", "QUOTE", 18);
            }
            quote = address(qt);
            q0 = quoteIsCurrency0;
        }
        key = _poolKey(quote, address(token), 3000, 60, address(directHook));
        vault = CovenantVault(
            payable(
                directFactory.createVault(
                    key,
                    VaultConfig({quoteIsCurrency0: q0, terms: t, issuer: issuer, treasury: treasury, curator: curator}),
                    bytes32(0)
                )
            )
        );
        PM.initialize(key, TickMath.getSqrtPriceAtTick(Orient.toPool(q0, priceTick)));
        firstLpId = POSM.nextTokenId();
        _mintFullRangeTo(address(vault), 113_880_000_000_000_000_000);
        lastLpId = firstLpId;
        _adoptAll();
    }

    /// @dev Mint a full-range position NFT exactly the way LBPStrategy's plan does: pay the PositionManager first,
    ///      then MINT_POSITION + SETTLE(contract balance) x2 + TAKE_PAIR for the dust.
    function _mintFullRangeTo(address owner, uint128 liquidity) internal {
        int24 lo = TickMath.minUsableTick(key.tickSpacing);
        int24 hi = TickMath.maxUsableTick(key.tickSpacing);
        (uint160 sqrtP,,,) = PM.getSlot0(key.toId());
        (uint256 a0, uint256 a1) = RangeMath.amounts(sqrtP, lo, hi, liquidity);
        a0 += 10;
        a1 += 10;
        uint256 value;
        if (key.currency0.isAddressZero()) {
            vm.deal(address(this), address(this).balance + a0);
            value = a0;
        } else {
            TestToken(Currency.unwrap(key.currency0)).mint(address(POSM), a0);
        }
        TestToken(Currency.unwrap(key.currency1)).mint(address(POSM), a1);

        bytes memory actions = abi.encodePacked(
            uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE), uint8(Actions.SETTLE), uint8(Actions.TAKE_PAIR)
        );
        bytes[] memory params = new bytes[](4);
        params[0] = abi.encode(key, lo, hi, uint256(liquidity), uint128(a0), uint128(a1), owner, bytes(""));
        params[1] = abi.encode(key.currency0, ActionConstants.CONTRACT_BALANCE, false);
        params[2] = abi.encode(key.currency1, ActionConstants.CONTRACT_BALANCE, false);
        params[3] = abi.encode(key.currency0, key.currency1, address(this));
        POSM.modifyLiquidities{value: value}(abi.encode(actions, params), block.timestamp);
    }

    function _adoptAll() internal {
        uint256[] memory ids = new uint256[](lastLpId - firstLpId + 1);
        for (uint256 i; i < ids.length; i++) {
            ids[i] = firstLpId + i;
        }
        vault.adopt(ids);
    }

    // ------------------------------------------------------------------------------------------------ prices

    function _spotPrice() internal view returns (int24) {
        return Orient.toPrice(q0, _tick(key));
    }

    function _twapPrice() internal view returns (int24) {
        return Orient.toPrice(q0, hook.consult(key.toId(), terms.twapWindow));
    }

    /// @notice Pool-tick range for a price-tick range, aligned outward to the pool's spacing.
    function _pool(int24 priceLower, int24 priceUpper) internal view returns (int24 lo, int24 hi) {
        int24 s = key.tickSpacing;
        return Orient.rangeToPool(q0, Orient.floorTo(priceLower, s), Orient.ceilTo(priceUpper, s));
    }

    // ------------------------------------------------------------------------------------------------ layouts

    function _cutAll() internal view returns (Cut[] memory cuts) {
        uint256 n = vault.rangeCount();
        cuts = new Cut[](n);
        for (uint256 i; i < n; i++) {
            cuts[i] = Cut(i, type(uint128).max);
        }
    }

    /// @dev A bid leg (quote only) between two price ticks.
    function _bid(int24 priceLower, int24 priceUpper, uint16 quoteShare) internal view returns (Leg memory) {
        (int24 lo, int24 hi) = _pool(priceLower, priceUpper);
        return q0 ? Leg(lo, hi, quoteShare, 0) : Leg(lo, hi, 0, quoteShare);
    }

    /// @dev An ask leg (tokens only) between two price ticks.
    function _ask(int24 priceLower, int24 priceUpper, uint16 tokenShare) internal view returns (Leg memory) {
        (int24 lo, int24 hi) = _pool(priceLower, priceUpper);
        return q0 ? Leg(lo, hi, 0, tokenShare) : Leg(lo, hi, tokenShare, 0);
    }

    /// @notice The honest curator's layout around price tick `p`:
    ///         - a three-spacing core straddling the price, so there is depth at the price itself and a trade landing
    ///           before the reshape cannot push the price past the sinks;
    ///         - `supportBps` of the quote as a bid band from the core down to B below the price;
    ///         - the rest of the quote further down (sink);
    ///         - every remaining token as asks from the core up (sink).
    function _honestLegs(int24 p, uint16 supportBps) internal view returns (Leg[] memory legs) {
        int24 s = key.tickSpacing;
        int24 band = terms.supportBandTicks;
        int24 coreLow = Orient.floorTo(p - 1, s) - s; // one spacing below the aligned tick under the price
        int24 coreHigh = Orient.ceilTo(p + 1, s) + s; // one spacing above the aligned tick over it
        int24 bidBottom = Orient.ceilTo(p - band, s) + s; // inside the band
        legs = new Leg[](4);
        (int24 lo, int24 hi) = _pool(coreLow, coreHigh);
        legs[0] = Leg(lo, hi, 300, 300);
        legs[1] = _bid(bidBottom, coreLow, supportBps);
        legs[2] = _bid(bidBottom - 4 * band, bidBottom, SINK);
        legs[3] = _ask(coreHigh, coreHigh + 2 * band, SINK);
    }

    function _honestSeed() internal {
        Cut[] memory cuts = _cutAll();
        Leg[] memory legs = _honestLegs(_spotPrice(), 6000);
        vm.prank(curator);
        vault.reshape(cuts, legs, NEVER);
    }

    // ------------------------------------------------------------------------------------------------ accounting

    /// @notice Principal the vault holds: every range at the spot price plus idle balances. Fees excluded.
    function _principal() internal view returns (uint256 quote, uint256 tokenAmt) {
        (uint160 sqrtP,,,) = PM.getSlot0(key.toId());
        Range[] memory rs = vault.ranges();
        uint256 a0;
        uint256 a1;
        for (uint256 i; i < rs.length; i++) {
            (uint256 x0, uint256 x1) = RangeMath.amounts(sqrtP, rs[i].tickLower, rs[i].tickUpper, rs[i].liquidity);
            a0 += x0;
            a1 += x1;
        }
        a0 += vault.idle0();
        a1 += vault.idle1();
        return Orient.split(q0, a0, a1);
    }

    /// @notice The vault's actual balances must cover everything it books outside the pool.
    function _assertSolvent() internal view {
        uint256 b0 = key.currency0.balanceOf(address(vault));
        uint256 b1 = key.currency1.balanceOf(address(vault));
        uint256 bounty = vault.bountyPool();
        assertGe(b0, vault.idle0() + vault.feePot0() + (q0 ? bounty : 0), "currency0 covers idle + fees (+ bounty)");
        assertGe(b1, vault.idle1() + vault.feePot1() + (q0 ? 0 : bounty), "currency1 covers idle + fees (+ bounty)");
    }

    /// @notice Every range the vault books exists in the PoolManager, owned by the vault, at that liquidity.
    function _assertPositionsMatchPoolManager() internal view {
        Range[] memory rs = vault.ranges();
        for (uint256 i; i < rs.length; i++) {
            uint128 inPm = PM.getPositionLiquidity(
                key.toId(), keccak256(abi.encodePacked(address(vault), rs[i].tickLower, rs[i].tickUpper, bytes32(0)))
            );
            assertEq(inPm, rs[i].liquidity, "booked liquidity == PoolManager position");
            for (uint256 j = i + 1; j < rs.length; j++) {
                assertFalse(
                    rs[i].tickLower == rs[j].tickLower && rs[i].tickUpper == rs[j].tickUpper, "no duplicate bounds"
                );
            }
        }
    }

    // ------------------------------------------------------------------------------------------------ time

    /// @notice Advance time and record a fresh observation, so the TWAP reflects the wait.
    function _wait(uint256 seconds_) internal {
        skip(seconds_);
        vm.roll(block.number + seconds_ / 2 + 1);
    }

    /// @notice Hold the current price long enough for spot and TWAP to agree (slew ramp plus a full window).
    function _settleTwap() internal {
        _wait(uint256(terms.twapWindow) + 3600);
    }

    /// @notice Keep the Anchor synced every half window for `seconds_`, the way a keeper would.
    function _keepPoked(uint256 seconds_) internal {
        uint256 step = terms.twapWindow / 2;
        for (uint256 t; t < seconds_; t += step) {
            _wait(step);
            vault.poke();
        }
    }
}
