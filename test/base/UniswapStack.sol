// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
// Imported only so they are compiled: setUp deploys them by artifact path at their canonical addresses.
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LBPStrategy} from "liquidity-launcher/src/strategies/lbp/LBPStrategy.sol";
import {IDistributorFactory} from "liquidity-launcher/src/interfaces/IDistributorFactory.sol";
import {ILBPInitializer} from "liquidity-launcher/src/interfaces/ILBPInitializer.sol";
import {PositionDefinition} from "liquidity-launcher/src/types/PositionPlannerTypes.sol";
import {
    MigratorParameters,
    PoolParameters,
    LiquidityAllocationBracket
} from "liquidity-launcher/src/libraries/MigratorParams.sol";
import {ContinuousClearingAuctionFactory} from "continuous-clearing-auction/ContinuousClearingAuctionFactory.sol";
import {ContinuousClearingAuction} from "continuous-clearing-auction/ContinuousClearingAuction.sol";
import {AuctionParameters} from "continuous-clearing-auction/interfaces/IContinuousClearingAuction.sol";

import {CovenantHook} from "../../src/CovenantHook.sol";
import {TestToken} from "./TestToken.sol";

/// @notice Uniswap's real launch stack, deployed locally: v4 PoolManager and PositionManager at their canonical
///         addresses, the CCA factory, a mined LBPStrategy, and a mined CovenantHook authorized to that strategy.
abstract contract UniswapStack is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager internal constant PM = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
    IPositionManager internal constant POSM = IPositionManager(0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e);

    uint160 internal constant COVENANT_HOOK_FLAGS =
        uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG);
    uint256 internal constant TICK_RATE = 10;

    // CCA prices are quote per token in Q96. Floor 1.0, steps of 1/64.
    uint256 internal constant Q96 = 2 ** 96;
    uint256 internal constant AUCTION_FLOOR = Q96;
    uint256 internal constant AUCTION_TICK = 2 ** 90;

    LBPStrategy internal strategy;
    ContinuousClearingAuctionFactory internal ccaFactory;
    CovenantHook internal hook;
    PoolSwapTest internal swapRouter;

    address internal launchRecipient = makeAddr("launchRecipient");
    address internal unsoldRecipient = makeAddr("unsoldRecipient");

    struct LaunchSpec {
        address quote; // address(0) = native ETH
        uint128 auctionSupply;
        uint128 lpReserve; // tokens reserved for the LP
        uint24 lpRateMps; // share of the raise that goes to the LP, 1e7 = 100%
        address positionRecipient;
        address poolHook;
        uint24 fee;
        int24 tickSpacing;
        PositionDefinition[] positions; // empty = the launcher's default full range
    }

    struct Launched {
        PoolKey key;
        ContinuousClearingAuction auction;
        TestToken token;
        uint256 firstTokenId;
        uint256 lastTokenId; // inclusive
    }

    /// @dev Routers refund unused native ETH to the caller.
    receive() external payable {}

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        vm.roll(1000);
        deployCodeTo("lib/v4-core/src/PoolManager.sol:PoolManager", abi.encode(address(this)), address(PM));
        deployCodeTo(
            "lib/v4-periphery/src/PositionManager.sol:PositionManager",
            abi.encode(PM, address(0), uint256(0), address(0), address(0)),
            address(POSM)
        );
        ccaFactory = new ContinuousClearingAuctionFactory(address(0));

        bytes memory strategyArgs = abi.encode(POSM, PM, IDistributorFactory(address(ccaFactory)));
        (, bytes32 strategySalt) =
            HookMiner.find(address(this), Hooks.BEFORE_INITIALIZE_FLAG, type(LBPStrategy).creationCode, strategyArgs);
        strategy = new LBPStrategy{salt: strategySalt}(POSM, PM, IDistributorFactory(address(ccaFactory)));

        hook = _deployHook(address(strategy));
        swapRouter = new PoolSwapTest(PM);
    }

    /// @dev A CovenantHook at a mined address, gating initialization to `authorized`.
    function _deployHook(address authorized) internal returns (CovenantHook h) {
        bytes memory args = abi.encode(PM, authorized, TICK_RATE);
        (address expected, bytes32 salt) =
            HookMiner.find(address(this), COVENANT_HOOK_FLAGS, type(CovenantHook).creationCode, args);
        h = new CovenantHook{salt: salt}(PM, authorized, TICK_RATE);
        assertEq(address(h), expected, "hook mined");
    }

    // ------------------------------------------------------------------------------------------------ launches

    function _defaultSpec(address positionRecipient) internal view returns (LaunchSpec memory s) {
        s.quote = address(0);
        s.auctionSupply = 1000 ether;
        s.lpReserve = 100 ether;
        s.lpRateMps = 1e6; // 10% of the raise
        s.positionRecipient = positionRecipient;
        s.poolHook = address(hook);
        s.fee = 3000;
        s.tickSpacing = 60;
    }

    /// @notice Register a CCA launch through the real LBPStrategy. Returns the auction and the pool key it commits.
    function _register(LaunchSpec memory s)
        internal
        returns (ContinuousClearingAuction auction, PoolKey memory key, TestToken token)
    {
        token = new TestToken("Launch", "LNCH", 18);
        (auction, key) = _register(s, token);
    }

    /// @notice Register a launch of an existing token, e.g. one whose pool key a vault was already created for.
    function _register(LaunchSpec memory s, TestToken token)
        internal
        returns (ContinuousClearingAuction auction, PoolKey memory key)
    {
        uint256 total = uint256(s.auctionSupply) + s.lpReserve;
        token.mint(address(this), total);

        uint64 start = uint64(block.number + 1);
        uint64 end = start + 100;
        AuctionParameters memory ap = AuctionParameters({
            currency: s.quote,
            tokensRecipient: unsoldRecipient,
            fundsRecipient: address(strategy),
            startBlock: start,
            endBlock: end,
            claimBlock: end + 10,
            tickSpacing: AUCTION_TICK,
            validationHook: address(0),
            floorPrice: AUCTION_FLOOR,
            requiredCurrencyRaised: 0,
            auctionStepsData: abi.encodePacked(uint24(100_000), uint40(50), uint24(100_000), uint40(50))
        });
        LiquidityAllocationBracket[] memory brackets = new LiquidityAllocationBracket[](1);
        brackets[0] = LiquidityAllocationBracket({lowerThreshold: 0, rate: s.lpRateMps});
        MigratorParameters memory mp = MigratorParameters({
            token: address(token),
            currency: s.quote,
            migrationBlock: end + 1,
            reservedTokenAmountForLP: s.lpReserve,
            recipient: launchRecipient,
            positionRecipient: s.positionRecipient,
            poolParameters: PoolParameters({fee: s.fee, tickSpacing: s.tickSpacing, hook: s.poolHook}),
            positionDefinitions: abi.encode(s.positions),
            lpAllocationSchedule: abi.encode(brackets)
        });
        token.approve(address(strategy), total);
        strategy.initializeDistribution(address(token), total, abi.encode(mp, abi.encode(ap)), bytes32(0));

        key = _poolKey(s.quote, address(token), s.fee, s.tickSpacing, s.poolHook);
        auction = ContinuousClearingAuction(payable(strategy.registeredPoolIds(key.toId())));
        assertTrue(address(auction) != address(0), "auction registered");
    }

    /// @notice Price level `steps` above the auction floor: 1 + steps/64 quote per token.
    function _price(uint256 steps) internal pure returns (uint256) {
        return AUCTION_FLOOR + steps * AUCTION_TICK;
    }

    function _bid(ContinuousClearingAuction auction, address bidder, uint256 steps, uint128 amount) internal {
        vm.deal(bidder, bidder.balance + amount);
        vm.prank(bidder);
        auction.submitBid{value: amount}(_price(steps), amount, bidder, "");
    }

    /// @notice Close the auction and migrate. Returns the LP NFT id range the launcher minted.
    function _closeAndMigrate(ContinuousClearingAuction auction) internal returns (uint256 firstId, uint256 lastId) {
        vm.roll(auction.endBlock());
        auction.checkpoint();
        vm.roll(auction.endBlock() + 1);
        firstId = POSM.nextTokenId();
        strategy.migrate(ILBPInitializer(address(auction)));
        lastId = POSM.nextTokenId() - 1;
        assertGe(lastId, firstId, "migration minted LP positions");
    }

    /// @notice The default auction: two losing bids at 1.016 and 1.047, a winner that clears at 1.297.
    function _runDefaultAuction(ContinuousClearingAuction auction) internal {
        vm.roll(auction.startBlock());
        _bid(auction, makeAddr("loser"), 1, 300 ether);
        _bid(auction, makeAddr("loser"), 3, 300 ether);
        _bid(auction, makeAddr("winner"), 19, 1400 ether);
    }

    // ------------------------------------------------------------------------------------------------ pool helpers

    function _poolKey(address quote, address token, uint24 fee, int24 spacing, address poolHook)
        internal
        pure
        returns (PoolKey memory)
    {
        (address c0, address c1) = quote < token ? (quote, token) : (token, quote);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, spacing, IHooks(poolHook));
    }

    function _tick(PoolKey memory key) internal view returns (int24 t) {
        (, t,,) = PM.getSlot0(key.toId());
    }

    /// @notice Exact-input swap by `who`, funding them as needed. Native ETH is always currency0.
    function _swap(PoolKey memory key, address who, bool zeroForOne, uint256 amountIn, uint160 limit) internal {
        Currency input = zeroForOne ? key.currency0 : key.currency1;
        vm.startPrank(who);
        uint256 value;
        if (input.isAddressZero()) {
            vm.deal(who, who.balance + amountIn);
            value = amountIn;
        } else {
            TestToken(Currency.unwrap(input)).mint(who, amountIn);
            IERC20(Currency.unwrap(input)).approve(address(swapRouter), amountIn);
        }
        if (limit == 0) limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        swapRouter.swap{value: value}(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    /// @notice Push the pool to `target` with an oversized exact-input swap capped by the price limit.
    function _swapToTick(PoolKey memory key, address who, int24 target, uint256 budget) internal {
        bool zeroForOne = target < _tick(key);
        _swap(key, who, zeroForOne, budget, TickMath.getSqrtPriceAtTick(target));
    }
}
