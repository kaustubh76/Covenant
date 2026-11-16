// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// END-TO-END: real ContinuousClearingAuction -> real LBPStrategy -> Covenant hook/vault -> demand-shaped Seed.

import "forge-std/Test.sol";
import {LBPStrategy} from "liquidity-launcher/src/strategies/lbp/LBPStrategy.sol";
import {ILBPInitializer} from "liquidity-launcher/src/interfaces/ILBPInitializer.sol";
import {IDistributorFactory} from "liquidity-launcher/src/interfaces/IDistributorFactory.sol";
import {PositionDefinition} from "liquidity-launcher/src/types/PositionPlannerTypes.sol";
import {MigratorParameters, PoolParameters, LiquidityAllocationBracket} from "liquidity-launcher/src/libraries/MigratorParams.sol";
import {MockERC20} from "./launcher/MockERC20.sol";
import {Covenant} from "./Covenant.sol";

import {ContinuousClearingAuctionFactory} from "continuous-clearing-auction/ContinuousClearingAuctionFactory.sol";
import {ContinuousClearingAuction} from "continuous-clearing-auction/ContinuousClearingAuction.sol";
import {AuctionParameters} from "continuous-clearing-auction/interfaces/IContinuousClearingAuction.sol";
import {Tick} from "continuous-clearing-auction/interfaces/ITickStorage.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract CovenantChainedTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager constant PM = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
    IPositionManager constant POSM = IPositionManager(0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e);
    uint256 constant Q96 = 2 ** 96;

    LBPStrategy strategy;
    ContinuousClearingAuctionFactory ccaFactory;
    Covenant cov;
    MockERC20 token;
    ContinuousClearingAuction auction;
    PoolKey key;

    address issuer_ = makeAddr("issuer");
    address curator_ = makeAddr("curator");
    address tokensRecipient = makeAddr("tokensRecipient");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant FLOOR = Q96; // 1 ETH per token
    uint256 constant TICK = 2 ** 90; // 1/64 ETH auction price steps (floor must be a multiple)

    function setUp() public {
        vm.warp(1_800_000_000);
        deployCodeTo("lib/v4-core/src/PoolManager.sol:PoolManager", abi.encode(address(this)), address(PM));
        deployCodeTo(
            "lib/v4-periphery/src/PositionManager.sol:PositionManager",
            abi.encode(PM, address(0), uint256(0), address(0), address(0)),
            address(POSM)
        );
        ccaFactory = new ContinuousClearingAuctionFactory(address(0));

        bytes memory args = abi.encode(POSM, PM, IDistributorFactory(address(ccaFactory)));
        (address sAddr, bytes32 salt) =
            HookMiner.find(address(this), Hooks.BEFORE_INITIALIZE_FLAG, type(LBPStrategy).creationCode, args);
        strategy = new LBPStrategy{salt: salt}(POSM, PM, IDistributorFactory(address(ccaFactory)));
        assertEq(address(strategy), sAddr);

        uint160 flags = uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG);
        bytes memory cargs = abi.encode(PM, address(strategy), POSM);
        (address cAddr, bytes32 csalt) = HookMiner.find(address(this), flags, type(Covenant).creationCode, cargs);
        cov = new Covenant{salt: csalt}(PM, address(strategy), POSM);
        assertEq(address(cov), cAddr);

        token = new MockERC20("Launch", "LNCH", 1100 ether, address(this));
        vm.deal(alice, 10_000 ether);
        vm.deal(bob, 10_000 ether);
    }

    function _p(uint256 pct) internal pure returns (uint256) {
        return FLOOR + (pct * TICK); // price = 1 + pct/64 ETH per token
    }

    /// @dev pool tick for a CCA price (ETH per token): pool price is token per ETH = 1/p
    function _poolTick(uint256 priceQ96) internal pure returns (int24) {
        // sqrt(1/p) in Q96: sqrt(Q96*Q96/p) * ... use sqrtPrice = Q96 * sqrt(Q96/p) / sqrt(Q96) => compute via uint math
        uint256 inv = (Q96 * Q96) / priceQ96; // token per ETH, Q96
        uint160 sqrtP = uint160(_sqrt(inv) * _sqrt(Q96));
        return TickMath.getTickAtSqrtPrice(sqrtP);
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    function _floor60(int24 t) internal pure returns (int24) {
        int24 f = (t / 60) * 60;
        if (t < 0 && f != t) f -= 60;
        return f;
    }

    function test_realCCA_to_realStrategy_to_Covenant_demandShapedSeed() public {
        // ---------------------------------------------------------------- 1. launch config
        uint64 start = uint64(block.number + 1);
        uint64 end = start + 100;
        AuctionParameters memory ap = AuctionParameters({
            currency: address(0),
            tokensRecipient: tokensRecipient,
            fundsRecipient: address(strategy),
            startBlock: start,
            endBlock: end,
            claimBlock: end + 10,
            tickSpacing: TICK,
            validationHook: address(0),
            floorPrice: FLOOR,
            requiredCurrencyRaised: 0,
            auctionStepsData: abi.encodePacked(abi.encodePacked(uint24(100_000), uint40(50)), abi.encodePacked(uint24(100_000), uint40(50)))
        });
        LiquidityAllocationBracket[] memory bp = new LiquidityAllocationBracket[](1);
        bp[0] = LiquidityAllocationBracket({lowerThreshold: 0, rate: 1e6}); // 10% of raise to LP
        PositionDefinition[] memory defs = new PositionDefinition[](1);
        defs[0] = PositionDefinition({
            offsetLower: TickMath.MIN_TICK, offsetUpper: TickMath.MAX_TICK, weight: 1e7, overridePositionRecipient: address(0)
        });
        MigratorParameters memory mp = MigratorParameters({
            token: address(token),
            currency: address(0),
            migrationBlock: end + 1,
            reservedTokenAmountForLP: 100 ether,
            recipient: issuer_,
            positionRecipient: address(cov),
            poolParameters: PoolParameters({fee: 3000, tickSpacing: 60, hook: address(cov)}),
            positionDefinitions: abi.encode(defs),
            lpAllocationSchedule: abi.encode(bp)
        });
        token.approve(address(strategy), 1100 ether);
        strategy.initializeDistribution(address(token), 1100 ether, abi.encode(mp, abi.encode(ap)), bytes32(0));

        key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(token)), 3000, 60, IHooks(address(cov)));
        auction = ContinuousClearingAuction(payable(strategy.registeredPoolIds(key.toId())));
        assertTrue(address(auction) != address(0), "real CCA created by the strategy through the CCA factory");
        assertEq(token.balanceOf(address(auction)), 1000 ether, "auction supply");

        // ---------------------------------------------------------------- 2. the auction
        vm.roll(start);
        // losers: real demand below the eventual clearing price
        vm.prank(bob);
        auction.submitBid{value: 300 ether}(_p(1), 300 ether, bob, FLOOR, "");
        vm.prank(bob);
        auction.submitBid{value: 300 ether}(_p(3), 300 ether, bob, _p(1), "");
        // winner: enough to clear the whole supply at 1.30
        vm.prank(alice);
        auction.submitBid{value: 1400 ether}(_p(19), 1400 ether, alice, _p(3), "");
        vm.roll(end);
        auction.checkpoint();
        uint256 clearing = auction.clearingPrice();
        emit log_named_uint("clearing price (ETH per token, 1e18)", clearing * 1e18 / Q96);
        assertEq(clearing, _p(19));

        // ---------------------------------------------------------------- 3. migration into Covenant
        vm.roll(end + 1);
        uint256 lpId = POSM.nextTokenId();
        strategy.migrate(ILBPInitializer(address(auction)));
        (uint160 sqrtP, int24 tick,,) = PM.getSlot0(key.toId());
        assertGt(sqrtP, 0, "pool live");
        assertEq(IERC721(address(POSM)).ownerOf(lpId), address(cov), "LP owned by Covenant");
        emit log_named_int("pool tick at clearing", tick);
        assertApproxEqAbs(int256(tick), int256(_poolTick(clearing)), 2, "pool price == clearing price");

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
        _seedFromDemand(tick);
    }

    // ---------------------------------------------------------------- 4. demand-shaped Seed
    function _seedFromDemand(int24 tick) internal {
        (uint256 a0, uint256 a1) = cov.amountsOf(0);
        emit log_named_uint("LP ETH (wei)", a0);
        emit log_named_uint("LP TOKEN (wei)", a1);
        assertApproxEqRel(a0, 1000 ether * _p(19) / Q96 / 10, 1e16, "10% of the raise went to LP");

        // Read the auction's own demand curve: losing demand at 1.02 and 1.05 is still on-chain.
        Tick memory t2 = auction.ticks(_p(1));
        Tick memory t5 = auction.ticks(_p(3));
        assertGt(t2.currencyDemandQ96, 0);
        assertGt(t5.currencyDemandQ96, 0);
        uint256 wsum = t2.currencyDemandQ96 + t5.currencyDemandQ96;

        int24 cur = _floor60(tick);
        Covenant.Range[] memory adds = new Covenant.Range[](4);
        adds[0] = _r0(cur + 60, cur + 1500, a0 * 40 / 100);
        int24 t5tick = _floor60(_poolTick(_p(3)));
        int24 t2tick = _floor60(_poolTick(_p(1)));
        adds[1] = _r0(t5tick - 300, t5tick + 300, (a0 * 60 / 100) * t5.currencyDemandQ96 / wsum);
        adds[2] = _r0(t2tick - 300, t2tick + 300, (a0 * 60 / 100) * t2.currencyDemandQ96 / wsum - 1e6);
        adds[3] = Covenant.Range(cur - 1500, cur, LiquidityAmounts.getLiquidityForAmount1(_sq(cur - 1500), _sq(cur), a1 - 1e6));

        uint256[] memory rm = new uint256[](1);
        vm.prank(curator_);
        cov.reshape(rm, adds);
        (uint256 have, uint256 need) = cov.supportBps();
        emit log_named_uint("support bps after demand-shaped seed", have);
        assertGe(have, need);
        assertEq(cov.rangeCount(), 4);
        assertLe(address(cov).balance, cov.DUST());
        assertLe(token.balanceOf(address(cov)), cov.DUST());
        emit log_named_int("demand range @1.047 tick", t5tick);
        emit log_named_int("demand range @1.016 tick", t2tick);
    }

    function _r0(int24 lo, int24 hi, uint256 amt0) internal pure returns (Covenant.Range memory) {
        return Covenant.Range(lo, hi, LiquidityAmounts.getLiquidityForAmount0(_sq(lo), _sq(hi), amt0));
    }

    /// @notice Gas of walking a realistic demand curve (300 initialized price levels).
    function test_gas_walkDemandCurve300Levels() public {
        uint64 start = uint64(block.number + 1);
        uint64 end = start + 100;
        AuctionParameters memory ap = AuctionParameters({
            currency: address(0),
            tokensRecipient: tokensRecipient,
            fundsRecipient: address(this),
            startBlock: start,
            endBlock: end,
            claimBlock: end + 10,
            tickSpacing: TICK,
            validationHook: address(0),
            floorPrice: FLOOR,
            requiredCurrencyRaised: 0,
            auctionStepsData: abi.encodePacked(abi.encodePacked(uint24(100_000), uint40(50)), abi.encodePacked(uint24(100_000), uint40(50)))
        });
        MockERC20 tk = new MockERC20("X", "X", 1000 ether, address(this));
        ContinuousClearingAuction a = ContinuousClearingAuction(payable(address(ccaFactory.create(address(tk), 1000 ether, abi.encode(ap), bytes32(0)))));
        tk.transfer(address(a), 1000 ether);
        a.onTokensReceived();
        vm.roll(start);
        vm.deal(alice, 1_000_000 ether);
        uint256 prev = FLOOR;
        for (uint256 i = 1; i <= 300; i++) {
            vm.prank(alice);
            a.submitBid{value: 2 ether}(_p(i), 2 ether, alice, prev, "");
            prev = _p(i);
        }
        vm.roll(end);
        a.checkpoint();

        uint256 g0 = gasleft();
        uint256 price = a.floorPrice();
        uint256 levels;
        uint256 sum;
        while (price != type(uint256).max && levels < 1000) {
            Tick memory tk_ = a.ticks(price);
            sum += tk_.currencyDemandQ96;
            price = tk_.next;
            levels++;
        }
        uint256 used = g0 - gasleft();
        emit log_named_uint("levels walked", levels);
        emit log_named_uint("gas for full walk", used);
        emit log_named_uint("gas per level", used / levels);
        assertGt(sum, 0);
        assertLt(used, 3_000_000, "walk fits comfortably in one tx");
    }

    function _sq(int24 t_) internal pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(t_);
    }
}
