// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

import {CovenantDeployer} from "./base/CovenantDeployer.sol";

/// @notice Deploys Covenant on a chain where Uniswap's v4 and Liquidity Launcher are live.
///
///         forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL                       # simulate
///         forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast \
///             --slow --verify --etherscan-api-key $BASESCAN_API_KEY                              # deploy
///
///         `make deploy-sepolia` runs both, asking before it broadcasts. Reads script/config/<chainid>.json and, after a
///         broadcast, writes the whole manifest the web app reads to deployments/<chainid>.json, or to
///         $COVENANT_MANIFEST (a rehearsal on a local fork records under its own name so it never overwrites the real
///         chain's file). For a local chain with Uniswap's stack deployed from source, use script/LocalStack.s.sol.
contract Deploy is CovenantDeployer {
    struct Config {
        IPoolManager poolManager;
        IPositionManager positionManager;
        address lbpStrategy;
        uint256 maxTickRate;
        // Optional: recorded for the web app when the chain has them (Uniswap's own test routers on Base Sepolia).
        address ccaFactory;
        address swapRouter;
        address liquidityRouter;
    }

    function run() external returns (Deployment memory d) {
        Config memory c = config();
        uint256 fromBlock = block.number;
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        address predictedHook;
        (d, predictedHook) = _deployCovenant(c.poolManager, c.positionManager, c.lbpStrategy, c.maxTickRate);
        vm.stopBroadcast();

        _checkCovenant(d, predictedHook, c.lbpStrategy);
        _logCovenant(d);
        // Only a real broadcast records addresses; a simulation must not leave a deployments file behind.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            vm.writeJson(_manifest(c, d, deployer, fromBlock), vm.envOr("COVENANT_MANIFEST", _deploymentsPath()));
        }
    }

    /// @dev Everything the web app needs for this chain: Uniswap's addresses beside Covenant's, who deployed, and the
    ///      block the deployment started from (log scans begin there; public RPCs cap the range of a single scan).
    function _manifest(Config memory c, Deployment memory d, address deployer, uint256 fromBlock)
        internal
        returns (string memory)
    {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeUint(k, "deployedAtBlock", fromBlock);
        vm.serializeAddress(k, "poolManager", address(c.poolManager));
        vm.serializeAddress(k, "positionManager", address(c.positionManager));
        vm.serializeAddress(k, "lbpStrategy", c.lbpStrategy);
        if (c.ccaFactory != address(0)) vm.serializeAddress(k, "ccaFactory", c.ccaFactory);
        if (c.swapRouter != address(0)) vm.serializeAddress(k, "swapRouter", c.swapRouter);
        if (c.liquidityRouter != address(0)) vm.serializeAddress(k, "liquidityRouter", c.liquidityRouter);
        vm.serializeUint(k, "maxTickRate", c.maxTickRate);
        return _serializeCovenant(k, d);
    }

    function config() public view returns (Config memory c) {
        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/script/config/", vm.toString(block.chainid), ".json"));
        c.poolManager = IPoolManager(vm.parseJsonAddress(json, ".poolManager"));
        c.positionManager = IPositionManager(vm.parseJsonAddress(json, ".positionManager"));
        c.lbpStrategy = vm.parseJsonAddress(json, ".lbpStrategy");
        c.maxTickRate = vm.parseJsonUint(json, ".maxTickRate");
        c.ccaFactory = _optional(json, ".ccaFactory");
        c.swapRouter = _optional(json, ".swapRouter");
        c.liquidityRouter = _optional(json, ".liquidityRouter");
        require(address(c.poolManager).code.length > 0, "no PoolManager on this chain");
        require(c.lbpStrategy.code.length > 0, "no LBPStrategy on this chain");
        require(c.swapRouter == address(0) || c.swapRouter.code.length > 0, "no swap router at the configured address");
        require(
            c.liquidityRouter == address(0) || c.liquidityRouter.code.length > 0,
            "no liquidity router at the configured address"
        );
    }

    function _optional(string memory json, string memory key) internal view returns (address) {
        return vm.keyExistsJson(json, key) ? vm.parseJsonAddress(json, key) : address(0);
    }
}
