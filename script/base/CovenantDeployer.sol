// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";

import {CovenantHook} from "../../src/CovenantHook.sol";
import {CovenantFactory} from "../../src/CovenantFactory.sol";
import {VaultOps} from "../../src/vault/VaultOps.sol";
import {SeedPlanner} from "../../src/periphery/SeedPlanner.sol";
import {CovenantLens} from "../../src/periphery/CovenantLens.sol";

/// @notice Deploys Covenant next to an existing PoolManager, PositionManager and LBPStrategy. Shared by `Deploy`
///         (Base Sepolia) and `LocalStack` (a local Anvil chain).
///         The hook goes through the deterministic CREATE2 deployer at an address mined for its three permission
///         flags, and names the LBPStrategy as its only initializer. CovenantLogic is an external library: forge
///         deploys and links it first.
abstract contract CovenantDeployer is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant FLAGS =
        uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG);

    struct Deployment {
        CovenantHook hook;
        VaultOps ops;
        CovenantFactory factory;
        SeedPlanner planner;
        CovenantLens lens;
    }

    /// @dev Call between `vm.startBroadcast()` and `vm.stopBroadcast()`, then `_checkCovenant` after it.
    function _deployCovenant(IPoolManager pm, IPositionManager posm, address lbpStrategy, uint256 maxTickRate)
        internal
        returns (Deployment memory d, address predictedHook)
    {
        bytes memory args = abi.encode(pm, lbpStrategy, maxTickRate);
        bytes32 salt;
        (predictedHook, salt) = HookMiner.find(CREATE2_DEPLOYER, FLAGS, type(CovenantHook).creationCode, args);
        d.hook = new CovenantHook{salt: salt}(pm, lbpStrategy, maxTickRate);
        d.ops = new VaultOps(pm);
        d.factory = new CovenantFactory(pm, posm, d.hook, d.ops);
        d.planner = new SeedPlanner();
        d.lens = new CovenantLens();
    }

    function _checkCovenant(Deployment memory d, address predictedHook, address lbpStrategy) internal view {
        require(address(d.hook) == predictedHook, "hook not at the mined address");
        require(uint160(address(d.hook)) & Hooks.ALL_HOOK_MASK == FLAGS, "hook flags");
        require(d.hook.authorized() == lbpStrategy, "hook gates to the LBPStrategy");
        require(d.factory.hook() == d.hook, "factory wired to the hook");
    }

    function _logCovenant(Deployment memory d) internal view {
        console.log("CovenantHook     ", address(d.hook));
        console.log("VaultOps         ", address(d.ops));
        console.log("CovenantFactory  ", address(d.factory));
        console.log("vault impl       ", d.factory.implementation());
        console.log("SeedPlanner      ", address(d.planner));
        console.log("CovenantLens     ", address(d.lens));
    }

    /// @dev Adds the Covenant addresses to the JSON object `key` and returns the serialized object.
    function _serializeCovenant(string memory key, Deployment memory d) internal returns (string memory) {
        vm.serializeAddress(key, "hook", address(d.hook));
        vm.serializeAddress(key, "vaultOps", address(d.ops));
        vm.serializeAddress(key, "factory", address(d.factory));
        vm.serializeAddress(key, "vaultImplementation", d.factory.implementation());
        vm.serializeAddress(key, "seedPlanner", address(d.planner));
        return vm.serializeAddress(key, "lens", address(d.lens));
    }

    function _deploymentsPath() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
    }
}
