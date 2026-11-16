// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTestNoChecks} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTestNoChecks.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {LBPStrategy} from "liquidity-launcher/src/strategies/lbp/LBPStrategy.sol";
import {IDistributorFactory} from "liquidity-launcher/src/interfaces/IDistributorFactory.sol";
import {ContinuousClearingAuctionFactory} from "continuous-clearing-auction/ContinuousClearingAuctionFactory.sol";

import {CovenantDeployer} from "./base/CovenantDeployer.sol";

/// @notice Stands up Uniswap's launch stack and Covenant on a local Anvil chain, for the web app and its tests:
///         v4 PoolManager and PositionManager, the CCA factory, an LBPStrategy at an address mined for
///         `beforeInitialize` (it is the launcher's pool hook), PoolSwapTest for market swaps and
///         PoolModifyLiquidityTestNoChecks for the outsider attack in the attack lab, then Covenant
///         with its hook authorized to that strategy. Everything is compiled from the same pinned sources the test
///         suite uses (the same `UniswapStack.setUp` recipe), and Permit2 is not needed for native-ETH launches.
///
///         forge script script/LocalStack.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
///             --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # Anvil account 0
///
///         Writes deployments/31337.json (or $COVENANT_LOCAL_MANIFEST). `make chain` runs this as part of the full
///         local bring-up.
contract LocalStack is CovenantDeployer {
    uint256 internal constant TICK_RATE = 10;

    struct Stack {
        PoolManager poolManager;
        PositionManager positionManager;
        ContinuousClearingAuctionFactory ccaFactory;
        LBPStrategy strategy;
        PoolSwapTest swapRouter;
        PoolModifyLiquidityTestNoChecks liquidityRouter;
    }

    function run() external returns (Stack memory s, Deployment memory d) {
        require(block.chainid == 31_337, "LocalStack: local Anvil (chain 31337) only");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        s.poolManager = new PoolManager(deployer);
        s.positionManager = new PositionManager(
            s.poolManager, IAllowanceTransfer(address(0)), 0, IPositionDescriptor(address(0)), IWETH9(address(0))
        );
        s.ccaFactory = new ContinuousClearingAuctionFactory(address(0));
        (address predictedStrategy, bytes32 strategySalt) = HookMiner.find(
            CREATE2_DEPLOYER,
            Hooks.BEFORE_INITIALIZE_FLAG,
            type(LBPStrategy).creationCode,
            abi.encode(s.positionManager, s.poolManager, s.ccaFactory)
        );
        s.strategy = new LBPStrategy{salt: strategySalt}(
            s.positionManager, s.poolManager, IDistributorFactory(address(s.ccaFactory))
        );
        s.swapRouter = new PoolSwapTest(s.poolManager);
        s.liquidityRouter = new PoolModifyLiquidityTestNoChecks(s.poolManager);
        address predictedHook;
        (d, predictedHook) = _deployCovenant(s.poolManager, s.positionManager, address(s.strategy), TICK_RATE);
        vm.stopBroadcast();

        require(address(s.strategy) == predictedStrategy, "LBPStrategy not at the mined address");
        _checkCovenant(d, predictedHook, address(s.strategy));

        console.log("PoolManager      ", address(s.poolManager));
        console.log("PositionManager  ", address(s.positionManager));
        console.log("CCA factory      ", address(s.ccaFactory));
        console.log("LBPStrategy      ", address(s.strategy));
        console.log("PoolSwapTest     ", address(s.swapRouter));
        console.log("LiquidityRouter  ", address(s.liquidityRouter));
        _logCovenant(d);

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) _record(s, d, deployer);
    }

    function _record(Stack memory s, Deployment memory d, address deployer) internal {
        string memory k = "local";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "poolManager", address(s.poolManager));
        vm.serializeAddress(k, "positionManager", address(s.positionManager));
        vm.serializeAddress(k, "ccaFactory", address(s.ccaFactory));
        vm.serializeAddress(k, "lbpStrategy", address(s.strategy));
        vm.serializeAddress(k, "swapRouter", address(s.swapRouter));
        vm.serializeAddress(k, "liquidityRouter", address(s.liquidityRouter));
        vm.serializeUint(k, "maxTickRate", TICK_RATE);
        // The chain tests stand up their own chain and record it under another name in deployments/.
        vm.writeJson(_serializeCovenant(k, d), vm.envOr("COVENANT_LOCAL_MANIFEST", _deploymentsPath()));
    }
}
