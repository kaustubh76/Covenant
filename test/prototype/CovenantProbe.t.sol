// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Feasibility probe for "Covenant" on top of Uniswap's Liquidity Launcher (LBPStrategy).
// Answers: can a custom hook + position recipient take control of CCA-migrated liquidity,
// reshape it without it leaving the vault, observe swaps, and stay untouchable by others?

import {LBPStrategyTestBase} from "./launcher/LBPStrategyTestBase.sol";
import {ILBPInitializer, LBPInitializationParams} from "liquidity-launcher/src/interfaces/ILBPInitializer.sol";
import {MockLBPInitializer} from "./launcher/MockLBPInitializer.sol";
import {InitializerHook} from "liquidity-launcher/src/periphery/hooks/InitializerHook.sol";
import {TimelockedPositionRecipient} from "liquidity-launcher/src/periphery/TimelockedPositionRecipient.sol";
import {PositionDefinition} from "liquidity-launcher/src/types/PositionPlannerTypes.sol";
import {MigratorParameters, PoolParameters, LiquidityAllocationBracket} from "liquidity-launcher/src/libraries/MigratorParams.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {PositionInfo} from "@uniswap/v4-periphery/src/libraries/PositionInfoLibrary.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal Covenant-style vault: pool hook (InitializerHook + afterSwap) AND LP position owner.
contract CovenantProbe is InitializerHook {
    using StateLibrary for IPoolManager;

    IPositionManager public immutable posm;
    uint256 public swapCount;
    int24 public lastObservedTick;
    uint256[] public adopted;

    error NotOwnedHere(uint256 tokenId);
    error HoldingsChanged(uint256 before0, uint256 after0, uint256 before1, uint256 after1);

    constructor(IPoolManager _pm, address _strategy, IPositionManager _posm) InitializerHook(_pm, _strategy) {
        posm = _posm;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.afterSwap = true;
    }

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        (, int24 tick,,) = poolManager.getSlot0(key.toId());
        lastObservedTick = tick;
        swapCount++;
        return (IHooks.afterSwap.selector, 0);
    }

    /// @notice Anyone can register a position this vault owns (launcher mints without a callback).
    function adopt(uint256 tokenId) external {
        if (IERC721(address(posm)).ownerOf(tokenId) != address(this)) revert NotOwnedHere(tokenId);
        adopted.push(tokenId);
    }

    /// @notice Reshape: pull one position and re-lay it in a new range inside ONE PositionManager call.
    ///         No swap, no withdrawal: vault holdings outside the pool may only grow by rounding dust.
    function reshape(uint256 tokenId, int24 newLower, int24 newUpper, uint256 maxDust)
        external
        returns (uint256 newTokenId)
    {
        (PoolKey memory key,) = posm.getPoolAndPositionInfo(tokenId);
        uint256 b0 = _bal(key.currency0);
        uint256 b1 = _bal(key.currency1);

        newTokenId = posm.nextTokenId();
        posm.modifyLiquidities(_plan(tokenId, key, newLower, newUpper), block.timestamp);

        uint256 a0After = _bal(key.currency0);
        uint256 a1After = _bal(key.currency1);
        // Conservation: nothing left the vault, and at most dust came out of the pool.
        if (a0After < b0 || a1After < b1 || a0After - b0 > maxDust || a1After - b1 > maxDust) {
            revert HoldingsChanged(b0, a0After, b1, a1After);
        }
        adopted.push(newTokenId);
    }

    function _newLiquidity(uint256 tokenId, PoolKey memory key, int24 newLower, int24 newUpper)
        internal
        view
        returns (uint128 liq, uint128 newLiq)
    {
        liq = posm.getPositionLiquidity(tokenId);
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        (,,, int24 oldLower, int24 oldUpper) = _range(tokenId);
        (uint256 a0, uint256 a1) =
            _amounts(sqrtP, TickMath.getSqrtPriceAtTick(oldLower), TickMath.getSqrtPriceAtTick(oldUpper), liq);
        newLiq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP,
            TickMath.getSqrtPriceAtTick(newLower),
            TickMath.getSqrtPriceAtTick(newUpper),
            a0 > 0 ? a0 - 1 : 0,
            a1 > 0 ? a1 - 1 : 0
        );
    }

    function _plan(uint256 tokenId, PoolKey memory key, int24 newLower, int24 newUpper)
        internal
        view
        returns (bytes memory)
    {
        (uint128 liq, uint128 newLiq) = _newLiquidity(tokenId, key, newLower, newUpper);
        bytes memory actions = abi.encodePacked(
            uint8(Actions.DECREASE_LIQUIDITY),
            uint8(Actions.MINT_POSITION),
            uint8(Actions.CLOSE_CURRENCY),
            uint8(Actions.CLOSE_CURRENCY)
        );
        bytes[] memory params = new bytes[](4);
        params[0] = abi.encode(tokenId, uint256(liq), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(
            key, newLower, newUpper, uint256(newLiq), type(uint128).max, type(uint128).max, address(this), bytes("")
        );
        params[2] = abi.encode(key.currency0);
        params[3] = abi.encode(key.currency1);
        return abi.encode(actions, params);
    }

    function _range(uint256 tokenId) internal view returns (uint8, uint8, uint8, int24 lower, int24 upper) {
        (, PositionInfo info) = posm.getPoolAndPositionInfo(tokenId);
        return (0, 0, 0, info.tickLower(), info.tickUpper());
    }

    function _amounts(uint160 p, uint160 a, uint160 b, uint128 l) internal pure returns (uint256 x, uint256 y) {
        if (p <= a) x = SqrtPriceMath.getAmount0Delta(a, b, l, false);
        else if (p < b) {
            x = SqrtPriceMath.getAmount0Delta(p, b, l, false);
            y = SqrtPriceMath.getAmount1Delta(a, p, l, false);
        } else {
            y = SqrtPriceMath.getAmount1Delta(a, b, l, false);
        }
    }

    function _bal(Currency c) internal view returns (uint256) {
        return c.isAddressZero() ? address(this).balance : IERC20(Currency.unwrap(c)).balanceOf(address(this));
    }

    function adoptedCount() external view returns (uint256) {
        return adopted.length;
    }

    receive() external payable {}
}

/// @notice Recipient-only vault for the web-app path (hookless pool): same reshape, no hook.
contract RecipientOnlyVault {
    IPositionManager public immutable posm;

    constructor(IPositionManager _posm) {
        posm = _posm;
    }

    receive() external payable {}
}

contract CovenantProbeTest is LBPStrategyTestBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    CovenantProbe covenant;
    PoolSwapTest swapRouter;
    address token;

    function setUp() public override {
        super.setUp();
        uint160 flags = uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG);
        bytes memory args = abi.encode(POOL_MANAGER, address(strategy), POSITION_MANAGER);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), flags, type(CovenantProbe).creationCode, args);
        covenant = new CovenantProbe{salt: salt}(POOL_MANAGER, address(strategy), POSITION_MANAGER);
        assertEq(address(covenant), hookAddr);
        swapRouter = new PoolSwapTest(POOL_MANAGER);
    }

    function _launch(address hook, address posRecipient) internal returns (PoolKey memory key, uint256 firstId) {
        LiquidityAllocationBracket[] memory bp = new LiquidityAllocationBracket[](1);
        bp[0] = LiquidityAllocationBracket({lowerThreshold: 0, rate: 1e7}); // 100% of raise to LP

        PositionDefinition[] memory defs = new PositionDefinition[](1);
        defs[0] = PositionDefinition({
            offsetLower: TickMath.MIN_TICK, offsetUpper: TickMath.MAX_TICK, weight: 1e7, overridePositionRecipient: address(0)
        });

        MigratorParameters memory mp = MigratorParameters({
            token: address(0),
            currency: address(0),
            migrationBlock: uint64(block.number + 1),
            reservedTokenAmountForLP: 100 ether,
            recipient: recipient,
            positionRecipient: posRecipient,
            poolParameters: PoolParameters({fee: 3000, tickSpacing: 60, hook: hook}),
            positionDefinitions: abi.encode(defs),
            lpAllocationSchedule: new bytes(0)
        });
        LBPInitializationParams memory lbp =
            LBPInitializationParams({initialPriceX96: uint160(1 << 96), tokensSold: 1 ether, currencyRaised: 100 ether});

        (MockLBPInitializer initializer,) = _initializeWith(mp, 110 ether, uint64(block.number), bp, address(0), lbp);
        token = initializer.token();
        vm.deal(address(initializer), 100 ether);
        vm.roll(mp.migrationBlock);

        firstId = POSITION_MANAGER.nextTokenId();
        strategy.migrate(ILBPInitializer(address(initializer)));

        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(hook)
        });
    }

    // 1) Stock LBPStrategy accepts Covenant as pool hook (beforeInitialize + afterSwap) AND position recipient.
    function test_1_migrationAcceptsCovenantAsHookAndRecipient() public {
        (PoolKey memory key, uint256 id) = _launch(address(covenant), address(covenant));
        (uint160 sqrtP,,,) = POOL_MANAGER.getSlot0(key.toId());
        assertGt(sqrtP, 0, "pool initialized with Covenant hook");
        assertEq(IERC721(address(POSITION_MANAGER)).ownerOf(id), address(covenant), "LP NFT owned by Covenant");
        assertGt(POSITION_MANAGER.getPositionLiquidity(id), 0, "liquidity live");
        covenant.adopt(id);
        assertEq(covenant.adoptedCount(), 1);
    }

    // 2) afterSwap fires on the migrated pool (basis for the in-hook TWAP).
    function test_2_afterSwapFires() public {
        (PoolKey memory key,) = _launch(address(covenant), address(covenant));
        vm.deal(address(this), 10 ether);
        swapRouter.swap{value: 1 ether}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        assertEq(covenant.swapCount(), 1, "afterSwap callback ran");
        assertLt(covenant.lastObservedTick(), 0, "hook observed the new price");
    }

    // 3) Reshape full-range -> concentrated, in one call, with holdings conserved (only dust).
    function test_3_reshapeConservesHoldings() public {
        (PoolKey memory key, uint256 id) = _launch(address(covenant), address(covenant));
        uint128 activeBefore = POOL_MANAGER.getLiquidity(key.toId());
        uint256 eth0 = address(covenant).balance;
        uint256 tok0 = IERC20(token).balanceOf(address(covenant));

        uint256 newId = covenant.reshape(id, -600, 600, 1e6);

        assertEq(POSITION_MANAGER.getPositionLiquidity(id), 0, "old range emptied");
        assertEq(IERC721(address(POSITION_MANAGER)).ownerOf(newId), address(covenant), "new range owned by Covenant");
        assertGt(POOL_MANAGER.getLiquidity(key.toId()), activeBefore * 5, "depth at price multiplied");
        assertLe(address(covenant).balance - eth0, 1e6, "ETH outside pool: dust only");
        assertLe(IERC20(token).balanceOf(address(covenant)) - tok0, 1e6, "token outside pool: dust only");
        emit log_named_uint("active liquidity before", activeBefore);
        emit log_named_uint("active liquidity after ", POOL_MANAGER.getLiquidity(key.toId()));
    }

    // 4) Nobody else (team, curator EOA, attacker) can pull Covenant-owned liquidity.
    function test_4_outsiderCannotWithdraw() public {
        (, uint256 id) = _launch(address(covenant), address(covenant));
        uint128 liq = POSITION_MANAGER.getPositionLiquidity(id);
        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(id, uint256(liq), uint128(0), uint128(0), bytes(""));
        (PoolKey memory key,) = POSITION_MANAGER.getPoolAndPositionInfo(id);
        params[1] = abi.encode(key.currency0, key.currency1, address(0xBAD));
        vm.prank(address(0xBAD));
        vm.expectRevert();
        POSITION_MANAGER.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        assertEq(POSITION_MANAGER.getPositionLiquidity(id), liq, "liquidity untouched");
    }

    // 5) Web-app path: hookless pool, Covenant as liquidity recipient only.
    function test_5_recipientModeHookless() public {
        RecipientOnlyVault vault = new RecipientOnlyVault(POSITION_MANAGER);
        (PoolKey memory key, uint256 id) = _launch(address(0), address(vault));
        assertEq(address(key.hooks), address(0));
        assertEq(IERC721(address(POSITION_MANAGER)).ownerOf(id), address(vault), "hookless LP NFT owned by vault");
    }

    // 6) Already-timelocked liquidity is out of reach until its timelock ends.
    function test_6_timelockedPositionsAreNotAccessible() public {
        // Uniswap's TimelockedPositionRecipient only approves its operator after the timelock block.
        address operator = makeAddr("operator");
        bytes memory code = vm.getCode("lib/liquidity-launcher/src/periphery/TimelockedPositionRecipient.sol:TimelockedPositionRecipient");
        address tl;
        bytes memory init = abi.encodePacked(code, abi.encode(POSITION_MANAGER, operator, block.number + 1000));
        assembly {
            tl := create(0, add(init, 0x20), mload(init))
        }
        (, uint256 id) = _launch(address(0), tl);
        assertEq(IERC721(address(POSITION_MANAGER)).ownerOf(id), tl);
        // Operator (or Covenant) cannot move it before the timelock.
        vm.prank(operator);
        vm.expectRevert();
        IERC721(address(POSITION_MANAGER)).transferFrom(tl, address(covenant), id);
        (bool ok,) = tl.call(abi.encodeWithSignature("approveOperator()"));
        assertFalse(ok, "approveOperator reverts before timelock");
    }
}
