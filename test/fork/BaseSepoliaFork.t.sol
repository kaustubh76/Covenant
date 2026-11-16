// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {LBPStrategy} from "liquidity-launcher/src/strategies/lbp/LBPStrategy.sol";
import {ILBPInitializer} from "liquidity-launcher/src/interfaces/ILBPInitializer.sol";
import {PositionDefinition} from "liquidity-launcher/src/types/PositionPlannerTypes.sol";
import {
    MigratorParameters,
    PoolParameters,
    LiquidityAllocationBracket
} from "liquidity-launcher/src/libraries/MigratorParams.sol";
import {ContinuousClearingAuction} from "continuous-clearing-auction/ContinuousClearingAuction.sol";
import {AuctionParameters} from "continuous-clearing-auction/interfaces/IContinuousClearingAuction.sol";

import {CovenantHook} from "../../src/CovenantHook.sol";
import {CovenantFactory} from "../../src/CovenantFactory.sol";
import {CovenantVault} from "../../src/CovenantVault.sol";
import {ICovenantVault} from "../../src/interfaces/ICovenantVault.sol";
import {VaultOps} from "../../src/vault/VaultOps.sol";
import {SeedPlanner, IAuctionDemand} from "../../src/periphery/SeedPlanner.sol";
import {CovenantLens, ICommittedLaunch} from "../../src/periphery/CovenantLens.sol";
import {Cut, Leg, VaultConfig} from "../../src/types/CovenantTypes.sol";
import {Orient} from "../../src/libraries/Orient.sol";
import {TestToken} from "../base/TestToken.sol";
import {Presets} from "../base/Presets.sol";

/// @notice Covenant against Uniswap's contracts as deployed on Base Sepolia: the live PoolManager, PositionManager,
///         LBPStrategy (v3.3.0) and CCA factory (v2.1.0). Nothing here is compiled from Uniswap's source.
///         Skipped unless BASE_SEPOLIA_RPC_URL is set:
///           BASE_SEPOLIA_RPC_URL=https://sepolia.base.org forge test --match-path "test/fork/*" -vv
contract BaseSepoliaForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 constant Q96 = 2 ** 96;
    uint256 constant NEVER = type(uint256).max;

    IPoolManager pm;
    IPositionManager posm;
    LBPStrategy strategy;
    CovenantHook hook;
    CovenantFactory factory;
    SeedPlanner planner;

    address issuer = makeAddr("issuer");
    address curator = makeAddr("curator");
    address keeper = makeAddr("keeper");

    receive() external payable {}

    function test_fork_launchThroughUniswapsDeployedStack() public {
        string memory rpc = vm.envOr("BASE_SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        _deployCovenant();

        // Stage 0: token, vault, launch registered with the live strategy, naming the vault as LP recipient.
        TestToken token = new TestToken("Fork Launch", "FORK", 18);
        token.mint(address(this), 1100 ether);
        PoolKey memory key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(token)), 3000, 60, IHooks(hook));
        CovenantVault vault = CovenantVault(
            payable(
                factory.createVault(key, VaultConfig(true, Presets.standard(), issuer, issuer, curator), bytes32(0))
            )
        );
        ContinuousClearingAuction auction = _register(token, key, address(vault));

        // A bidder can verify the covenant on-chain before bidding, against the deployed strategy.
        CovenantLens.LaunchCheck memory check =
            new CovenantLens().verifyLaunch(factory, ICommittedLaunch(address(strategy)), address(auction));
        assertTrue(check.ok, "launch verifies against the live LBPStrategy");

        _auctionAndMigrate(auction, key, vault);
        _seed(auction, vault);
        _pumpFindsNothingToRestore(key, vault);
    }

    /// @dev Two outbid levels and a winner, then migration through the deployed strategy and adoption.
    function _auctionAndMigrate(ContinuousClearingAuction auction, PoolKey memory key, CovenantVault vault) internal {
        vm.roll(auction.startBlock());
        _bid(auction, makeAddr("loser"), 1, 300 ether);
        _bid(auction, makeAddr("loser"), 3, 300 ether);
        _bid(auction, makeAddr("winner"), 19, 1400 ether);
        vm.roll(auction.endBlock());
        auction.checkpoint();
        vm.roll(auction.endBlock() + 1);

        uint256 lpId = posm.nextTokenId();
        strategy.migrate(ILBPInitializer(address(auction)));
        assertEq(IERC721(address(posm)).ownerOf(lpId), address(vault), "live strategy minted the LP to the vault");
        (bool live,,) = hook.poolInfo(key.toId());
        assertTrue(live, "pool initialized through the hook");

        uint256[] memory ids = new uint256[](1);
        ids[0] = lpId;
        vault.adopt(ids);
    }

    function _seed(ContinuousClearingAuction auction, CovenantVault vault) internal {
        (uint256 before,) = vault.support();
        (Cut[] memory cuts, Leg[] memory legs) = planner.plan(
            vault,
            IAuctionDemand(address(auction)),
            SeedPlanner.Params({supportShareBps: 5000, coreShareBps: 300, maxLevels: 6, levelHalfWidth: 2})
        );
        vm.prank(curator);
        vault.reshape(cuts, legs, NEVER);
        (uint256 have, uint256 need) = vault.support();
        emit log_named_uint("support on Base Sepolia, before seed (bps)", before);
        emit log_named_uint("support on Base Sepolia, after seed (bps) ", have);
        assertGe(have, need);
    }

    /// @dev The live PoolManager calls the hook on every swap, and the pump-ratchet still has nothing to work with.
    function _pumpFindsNothingToRestore(PoolKey memory key, CovenantVault vault) internal {
        PoolSwapTest router = new PoolSwapTest(pm);
        vm.deal(address(this), 100_000 ether);
        int24 target = Orient.toPool(true, Orient.toPrice(true, _tick(key)) + 30_000);
        router.swap{value: 10_000 ether}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -10_000 ether,
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(target)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        skip(2 hours);
        uint256[] memory idx = new uint256[](1);
        vm.prank(keeper);
        vm.expectPartialRevert(ICovenantVault.NothingToRestore.selector);
        vault.restore(idx, NEVER);
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _deployCovenant() internal {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/script/config/84532.json"));
        pm = IPoolManager(vm.parseJsonAddress(json, ".poolManager"));
        posm = IPositionManager(vm.parseJsonAddress(json, ".positionManager"));
        strategy = LBPStrategy(payable(vm.parseJsonAddress(json, ".lbpStrategy")));
        assertGt(address(strategy).code.length, 0, "LBPStrategy deployed on this fork");

        uint160 flags = uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG);
        bytes memory args = abi.encode(pm, address(strategy), uint256(10));
        (, bytes32 salt) = HookMiner.find(address(this), flags, type(CovenantHook).creationCode, args);
        hook = new CovenantHook{salt: salt}(pm, address(strategy), 10);
        factory = new CovenantFactory(pm, posm, hook, new VaultOps(pm));
        planner = new SeedPlanner();
    }

    function _register(TestToken token, PoolKey memory key, address vault)
        internal
        returns (ContinuousClearingAuction auction)
    {
        uint64 start = uint64(block.number + 1);
        uint64 end = start + 100;
        AuctionParameters memory ap = AuctionParameters({
            currency: address(0),
            tokensRecipient: makeAddr("unsold"),
            fundsRecipient: address(strategy),
            startBlock: start,
            endBlock: end,
            claimBlock: end + 10,
            tickSpacing: 2 ** 90,
            validationHook: address(0),
            floorPrice: Q96,
            requiredCurrencyRaised: 0,
            auctionStepsData: abi.encodePacked(uint24(100_000), uint40(50), uint24(100_000), uint40(50))
        });
        LiquidityAllocationBracket[] memory brackets = new LiquidityAllocationBracket[](1);
        brackets[0] = LiquidityAllocationBracket({lowerThreshold: 0, rate: 1e6});
        MigratorParameters memory mp = MigratorParameters({
            token: address(token),
            currency: address(0),
            migrationBlock: end + 1,
            reservedTokenAmountForLP: 100 ether,
            recipient: issuer,
            positionRecipient: vault,
            poolParameters: PoolParameters({fee: 3000, tickSpacing: 60, hook: address(hook)}),
            positionDefinitions: abi.encode(new PositionDefinition[](0)),
            lpAllocationSchedule: abi.encode(brackets)
        });
        token.approve(address(strategy), 1100 ether);
        strategy.initializeDistribution(address(token), 1100 ether, abi.encode(mp, abi.encode(ap)), bytes32(0));
        auction = ContinuousClearingAuction(payable(strategy.registeredPoolIds(key.toId())));
        assertTrue(address(auction) != address(0), "live strategy created the auction via the live CCA factory");
    }

    function _bid(ContinuousClearingAuction auction, address bidder, uint256 steps, uint128 amount) internal {
        vm.deal(bidder, amount);
        vm.prank(bidder);
        auction.submitBid{value: amount}(Q96 + steps * 2 ** 90, amount, bidder, "");
    }

    function _tick(PoolKey memory key) internal view returns (int24 t) {
        (, t,,) = pm.getSlot0(key.toId());
    }
}
