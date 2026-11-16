// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Covenant prototype for adversarial testing. Not production code.
// Pool convention in this prototype: currency0 = quote (native ETH), currency1 = launched token.
// Pool price = token per ETH, so a HIGHER tick means a CHEAPER token. Buy support for the token is
// quote (currency0) sitting in ranges just ABOVE the current tick.

import {InitializerHook} from "liquidity-launcher/src/periphery/hooks/InitializerHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {CurrencySettler} from "@uniswap/v4-core/test/utils/CurrencySettler.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {PositionInfo} from "@uniswap/v4-periphery/src/libraries/PositionInfoLibrary.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Covenant is InitializerHook, IUnlockCallback {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using CurrencySettler for Currency;

    // ---------------------------------------------------------------- types
    struct Range {
        int24 lower;
        int24 upper;
        uint128 liquidity;
    }

    struct Terms {
        uint24 supportBps; // min share of quote that must sit as buy support (1e4 = 100%)
        int24 supportBandTicks; // band above TWAP tick that counts as support
        uint24 paceBps; // max share of vault value a curator may move per epoch
        uint32 epochLen; // seconds
        int24 guardTicks; // max |spot - twap| for any state change
        uint32 twapWindow; // seconds
        uint64 unlockStart; // timestamp when issuer principal starts vesting
        uint64 unlockDuration; // linear vesting length
        uint32 curatorTimelock; // seconds before a curator change applies
        uint256 bounty0; // restore bounty in quote
    }

    struct Obs {
        uint32 ts;
        int56 cum; // tick-seconds accumulated up to ts
        int24 tick; // tick in force from ts onward
    }

    enum Op {
        Add,
        Reshape,
        Scale
    }

    // --------------------------------------------------------------- errors
    error NotIssuer();
    error NotCurator();
    error NotConfigured();
    error PriceGuard(int24 spot, int24 twap);
    error ConservationBroken(int256 principal0, int256 principal1);
    error SupportBroken(uint256 haveBps, uint256 needBps);
    error PaceExceeded(uint256 moved, uint256 cap);
    error Locked(uint256 vested, uint256 requested);
    error NothingToRestore();
    error RestoreDidNotHelp();
    error TimelockActive();
    error NotOwnedHere();
    error TooMuchDust();
    error TooManyRanges();

    event Reshaped(address curator, uint256 movedValue0);
    event Restored(address caller, uint256 bounty);

    // -------------------------------------------------------------- storage
    IPositionManager public immutable posm;
    PoolKey public key;
    bool public configured;
    Terms public terms;
    address public issuer;
    address public curator;
    address public pendingCurator;
    uint64 public curatorChangeAt;

    Range[] public ranges;

    uint256 public totalShares;
    mapping(address => uint256) public shares;
    uint256 public issuerWithdrawnShares;
    uint256 public issuerInitialShares;

    uint256 public fees0;
    uint256 public fees1;
    uint256 public bountyPool0;

    uint64 public epochStart;
    uint256 public movedThisEpoch;
    uint64 public graceUntil; // first epoch after adoption: pace not enforced (initial concentration)

    Obs[32] public obs;
    uint8 public obsIdx;
    uint8 public obsCount;
    int24 public lastTick;
    uint32 public lastTs;
    int56 public lastCum;

    uint256 public constant DUST = 1e9;
    uint256 public constant MAX_RANGES = 16; // bounds the support/pace loops so a curator cannot grief gas
    uint256 internal constant Q96 = 2 ** 96;

    constructor(IPoolManager _pm, address _strategy, IPositionManager _posm) InitializerHook(_pm, _strategy) {
        posm = _posm;
    }

    receive() external payable {}

    // --------------------------------------------------------------- hooks
    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.afterSwap = true;
    }

    function _afterSwap(address, PoolKey calldata k, SwapParams calldata, BalanceDelta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        (, int24 tick,,) = poolManager.getSlot0(k.toId());
        _record(tick);
        return (IHooks.afterSwap.selector, 0);
    }

    // ---------------------------------------------------------------- setup
    function configure(PoolKey calldata k, Terms calldata t, address _issuer, address _curator) external {
        require(!configured, "configured");
        key = k;
        terms = t;
        issuer = _issuer;
        curator = _curator;
        configured = true;
        epochStart = uint64(block.timestamp);
        (, int24 tick,,) = poolManager.getSlot0(k.toId());
        lastTick = tick;
        lastTs = uint32(block.timestamp);
        obs[0] = Obs(uint32(block.timestamp), 0, tick);
        obsCount = 1;
    }

    /// @notice Take over a launcher-minted LP NFT this contract owns: pull it out of PositionManager and
    ///         re-add it as a Covenant-owned position in the same range. Issuer receives principal shares.
    function adopt(uint256 tokenId) external {
        if (!configured) revert NotConfigured();
        if (IERC721(address(posm)).ownerOf(tokenId) != address(this)) revert NotOwnedHere();
        (PoolKey memory k, PositionInfo info) = posm.getPoolAndPositionInfo(tokenId);
        require(Currency.unwrap(k.currency1) == Currency.unwrap(key.currency1), "wrong pool");
        uint128 liq = posm.getPositionLiquidity(tokenId);

        uint256 b0 = _bal0();
        uint256 b1 = _bal1();
        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, uint256(liq), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, address(this));
        posm.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        uint256 got0 = _bal0() - b0;
        uint256 got1 = _bal1() - b1;

        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        uint128 newLiq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(info.tickLower()), TickMath.getSqrtPriceAtTick(info.tickUpper()), got0, got1
        );
        Range[] memory adds = new Range[](1);
        adds[0] = Range(info.tickLower(), info.tickUpper(), newLiq);
        poolManager.unlock(abi.encode(Op.Add, abi.encode(adds)));

        graceUntil = uint64(block.timestamp) + terms.epochLen;
        uint256 minted = totalShares == 0 ? 1e18 : 0;
        require(minted > 0, "single adopt in prototype");
        shares[issuer] += minted;
        issuerInitialShares += minted;
        totalShares += minted;
    }

    // ------------------------------------------------------------- curator
    function reshape(uint256[] calldata removeIdx, Range[] calldata adds) external {
        if (msg.sender != curator) revert NotCurator();
        _guard();
        _rollEpoch();
        uint256 movedValue = _valueOf(removeIdx);
        if (block.timestamp >= graceUntil) {
            uint256 cap = FullMath.mulDiv(_totalValue(), terms.paceBps, 1e4);
            if (movedThisEpoch + movedValue > cap) revert PaceExceeded(movedThisEpoch + movedValue, cap);
        }
        movedThisEpoch += movedValue;

        poolManager.unlock(abi.encode(Op.Reshape, abi.encode(removeIdx, adds)));
        _requireSupport();
        emit Reshaped(msg.sender, movedValue);
    }

    /// @notice Permissionless: if price drift broke the support rule, move one range's quote back into the band.
    function restore(uint256 idx) external {
        _guard();
        (uint256 have, uint256 need) = _support();
        if (have >= need) revert NothingToRestore();
        int24 tw = _twapTick();
        Range memory r = ranges[idx];
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        (uint256 a0, uint256 a1) = _amounts(sqrtP, r);

        Range[] memory adds = new Range[](2);
        int24 lo = _floor(tw + key.tickSpacing);
        int24 hi = _floor(tw + terms.supportBandTicks);
        if (hi <= lo) hi = lo + key.tickSpacing;
        adds[0] = Range(
            lo, hi, LiquidityAmounts.getLiquidityForAmount0(TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), a0)
        );
        int24 lo1 = _floor(tw - terms.supportBandTicks);
        int24 hi1 = _floor(tw);
        if (hi1 <= lo1) lo1 = hi1 - key.tickSpacing;
        adds[1] = Range(
            lo1,
            hi1,
            LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(lo1), TickMath.getSqrtPriceAtTick(hi1), a1)
        );
        uint256[] memory rm = new uint256[](1);
        rm[0] = idx;
        poolManager.unlock(abi.encode(Op.Reshape, abi.encode(rm, adds)));

        (uint256 after_,) = _support();
        if (after_ <= have) revert RestoreDidNotHelp();
        uint256 b = bountyPool0 < terms.bounty0 ? bountyPool0 : terms.bounty0;
        bountyPool0 -= b;
        (bool ok,) = msg.sender.call{value: b}("");
        require(ok);
        emit Restored(msg.sender, b);
    }

    function fundBounty() external payable {
        bountyPool0 += msg.value;
    }

    function proposeCurator(address c) external {
        if (msg.sender != issuer) revert NotIssuer();
        pendingCurator = c;
        curatorChangeAt = uint64(block.timestamp) + terms.curatorTimelock;
    }

    function acceptCurator() external {
        if (block.timestamp < curatorChangeAt || pendingCurator == address(0)) revert TimelockActive();
        curator = pendingCurator;
        pendingCurator = address(0);
    }

    // ---------------------------------------------------------- outside LPs
    /// @notice In-kind deposit: mint `newShares`, adding proportional liquidity to every range.
    function deposit(uint256 newShares) external payable {
        _guard();
        require(totalShares > 0 && newShares > 0);
        uint256 b0 = _bal0() - msg.value;
        uint256 b1 = _bal1();
        _msgValue = msg.value;
        poolManager.unlock(abi.encode(Op.Scale, abi.encode(int256(newShares), msg.sender)));
        _msgValue = 0;
        // the vault itself never pays for a depositor
        require(_bal0() + DUST >= b0 && _bal1() + DUST >= b1, "vault paid");
        shares[msg.sender] += newShares;
        totalShares += newShares;
    }

    function withdraw(uint256 burnShares) external {
        _guard();
        require(burnShares > 0 && shares[msg.sender] >= burnShares);
        if (msg.sender == issuer) {
            uint256 vested = _vestedIssuerShares();
            if (issuerWithdrawnShares + burnShares > vested) revert Locked(vested, issuerWithdrawnShares + burnShares);
            issuerWithdrawnShares += burnShares;
        }
        poolManager.unlock(abi.encode(Op.Scale, abi.encode(-int256(burnShares), msg.sender)));
        shares[msg.sender] -= burnShares;
        totalShares -= burnShares;
        // issuer principal remains protected: support is measured on remaining positions
        if (msg.sender != issuer) _requireSupport();
    }

    function collectFees(address to) external {
        if (msg.sender != issuer) revert NotIssuer();
        // keep the bounty pool topped up first
        uint256 top = terms.bounty0 * 3;
        if (bountyPool0 < top) {
            uint256 move = top - bountyPool0;
            if (move > fees0) move = fees0;
            bountyPool0 += move;
            fees0 -= move;
        }
        uint256 f0 = fees0;
        uint256 f1 = fees1;
        fees0 = 0;
        fees1 = 0;
        if (f0 > 0) {
            (bool ok,) = to.call{value: f0}("");
            require(ok);
        }
        if (f1 > 0) IERC20(Currency.unwrap(key.currency1)).transfer(to, f1);
    }

    // --------------------------------------------------------- unlock logic
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager));
        (Op op, bytes memory payload) = abi.decode(data, (Op, bytes));
        if (op == Op.Add) _doAdd(abi.decode(payload, (Range[])));
        else if (op == Op.Reshape) {
            (uint256[] memory rm, Range[] memory adds) = abi.decode(payload, (uint256[], Range[]));
            _doReshape(rm, adds);
        } else {
            (int256 dShares, address who) = abi.decode(payload, (int256, address));
            _doScale(dShares, who);
        }
        return "";
    }

    function _doAdd(Range[] memory adds) internal {
        int256 d0;
        int256 d1;
        for (uint256 i; i < adds.length; i++) {
            (BalanceDelta cd,) = _mod(adds[i].lower, adds[i].upper, int256(uint256(adds[i].liquidity)));
            d0 += cd.amount0();
            d1 += cd.amount1();
            ranges.push(adds[i]);
        }
        _settle(d0, d1);
    }

    function _doReshape(uint256[] memory rm, Range[] memory adds) internal {
        int256 p0;
        int256 p1;
        uint256 f0;
        uint256 f1;
        for (uint256 i; i < rm.length; i++) {
            Range memory r = ranges[rm[i]];
            (BalanceDelta cd, BalanceDelta fa) = _mod(r.lower, r.upper, -int256(uint256(r.liquidity)));
            p0 += cd.amount0() - fa.amount0();
            p1 += cd.amount1() - fa.amount1();
            f0 += uint128(fa.amount0());
            f1 += uint128(fa.amount1());
            ranges[rm[i]].liquidity = 0;
        }
        for (uint256 i; i < adds.length; i++) {
            if (adds[i].liquidity == 0) continue;
            (BalanceDelta cd,) = _mod(adds[i].lower, adds[i].upper, int256(uint256(adds[i].liquidity)));
            p0 += cd.amount0();
            p1 += cd.amount1();
            ranges.push(adds[i]);
        }
        // Conservation: principal may not leave the pool beyond dust, and the vault tops up at most dust.
        if (p0 > int256(DUST) || p1 > int256(DUST) || p0 < -int256(DUST) || p1 < -int256(DUST)) {
            revert ConservationBroken(p0, p1);
        }
        fees0 += f0;
        fees1 += f1;
        _settle(p0 + int256(f0), p1 + int256(f1));
        _compact();
        if (ranges.length > MAX_RANGES) revert TooManyRanges();
    }

    function _doScale(int256 dShares, address who) internal {
        int256 d0;
        int256 d1;
        uint256 f0;
        uint256 f1;
        uint256 ts = totalShares;
        for (uint256 i; i < ranges.length; i++) {
            Range storage r = ranges[i];
            int256 dL = int256(FullMath.mulDiv(r.liquidity, uint256(dShares < 0 ? -dShares : dShares), ts));
            if (dShares < 0) dL = -dL;
            (BalanceDelta cd, BalanceDelta fa) = _mod(r.lower, r.upper, dL);
            d0 += cd.amount0() - fa.amount0();
            d1 += cd.amount1() - fa.amount1();
            f0 += uint128(fa.amount0());
            f1 += uint128(fa.amount1());
            r.liquidity = uint128(uint256(int256(uint256(r.liquidity)) + dL));
        }
        fees0 += f0;
        fees1 += f1;
        if (dShares > 0) {
            require(d0 <= 0 && d1 <= 0);
            uint256 need0 = uint256(-d0);
            uint256 need1 = uint256(-d1);
            require(_msgValue >= need0, "insufficient eth");
            key.currency0.settle(poolManager, address(this), need0, false);
            IERC20(Currency.unwrap(key.currency1)).transferFrom(who, address(this), need1);
            key.currency1.settle(poolManager, address(this), need1, false);
            if (_msgValue > need0) {
                (bool ok,) = who.call{value: _msgValue - need0}("");
                require(ok);
            }
        } else {
            require(d0 >= 0 && d1 >= 0);
            if (d0 > 0) poolManager.take(key.currency0, who, uint256(d0));
            if (d1 > 0) poolManager.take(key.currency1, who, uint256(d1));
        }
        _settle(int256(f0), int256(f1));
    }

    uint256 private _msgValue;

    function _mod(int24 lo, int24 hi, int256 dL) internal returns (BalanceDelta, BalanceDelta) {
        return poolManager.modifyLiquidity(key, ModifyLiquidityParams(lo, hi, dL, bytes32(0)), "");
    }

    /// @dev settle a net delta: positive = pool owes vault (take), negative = vault pays (settle).
    function _settle(int256 d0, int256 d1) internal {
        if (d0 > 0) poolManager.take(key.currency0, address(this), uint256(d0));
        else if (d0 < 0) key.currency0.settle(poolManager, address(this), uint256(-d0), false);
        if (d1 > 0) poolManager.take(key.currency1, address(this), uint256(d1));
        else if (d1 < 0) key.currency1.settle(poolManager, address(this), uint256(-d1), false);
    }

    function _compact() internal {
        for (uint256 i = ranges.length; i > 0; i--) {
            if (ranges[i - 1].liquidity == 0) {
                ranges[i - 1] = ranges[ranges.length - 1];
                ranges.pop();
            }
        }
    }

    // ---------------------------------------------------------------- rules
    function _guard() internal view {
        if (!configured) revert NotConfigured();
        (, int24 spot,,) = poolManager.getSlot0(key.toId());
        int24 tw = _twapTick();
        int24 diff = spot > tw ? spot - tw : tw - spot;
        if (diff > terms.guardTicks) revert PriceGuard(spot, tw);
    }

    function _requireSupport() internal view {
        (uint256 have, uint256 need) = _support();
        if (have < need) revert SupportBroken(have, need);
    }

    /// @return haveBps share of quote (valued at TWAP) that sits in the support band
    /// @return needBps the covenant minimum
    function _support() internal view returns (uint256 haveBps, uint256 needBps) {
        int24 tw = _twapTick();
        uint160 sqrtTw = TickMath.getSqrtPriceAtTick(tw);
        int24 bandHi = tw + terms.supportBandTicks;
        uint256 total;
        uint256 inBand;
        for (uint256 i; i < ranges.length; i++) {
            Range memory r = ranges[i];
            (uint256 a0,) = _amounts(sqrtTw, r);
            total += a0;
            int24 lo = r.lower > tw ? r.lower : tw;
            int24 hi = r.upper < bandHi ? r.upper : bandHi;
            if (hi > lo) {
                inBand += SqrtPriceMath.getAmount0Delta(
                    TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), r.liquidity, false
                );
            }
        }
        haveBps = total == 0 ? 1e4 : inBand * 1e4 / total;
        needBps = terms.supportBps;
    }

    function supportBps() external view returns (uint256 have, uint256 need) {
        return _support();
    }

    function _rollEpoch() internal {
        if (block.timestamp >= epochStart + terms.epochLen) {
            epochStart = uint64(block.timestamp);
            movedThisEpoch = 0;
        }
    }

    function _vestedIssuerShares() internal view returns (uint256) {
        if (block.timestamp < terms.unlockStart) return 0;
        uint256 el = block.timestamp - terms.unlockStart;
        if (el >= terms.unlockDuration) return issuerInitialShares;
        return issuerInitialShares * el / terms.unlockDuration;
    }

    // ---------------------------------------------------------------- value
    function _amounts(uint160 sqrtP, Range memory r) internal pure returns (uint256 a0, uint256 a1) {
        uint160 a = TickMath.getSqrtPriceAtTick(r.lower);
        uint160 b = TickMath.getSqrtPriceAtTick(r.upper);
        if (sqrtP <= a) a0 = SqrtPriceMath.getAmount0Delta(a, b, r.liquidity, false);
        else if (sqrtP < b) {
            a0 = SqrtPriceMath.getAmount0Delta(sqrtP, b, r.liquidity, false);
            a1 = SqrtPriceMath.getAmount1Delta(a, sqrtP, r.liquidity, false);
        } else {
            a1 = SqrtPriceMath.getAmount1Delta(a, b, r.liquidity, false);
        }
    }

    /// @dev value in quote units at TWAP: a0 + a1 / price, price = (sqrtP/2^96)^2 (token per quote)
    function _value0(uint160 sqrtP, Range memory r) internal pure returns (uint256) {
        (uint256 a0, uint256 a1) = _amounts(sqrtP, r);
        uint256 a1InQuote = FullMath.mulDiv(FullMath.mulDiv(a1, Q96, sqrtP), Q96, sqrtP);
        return a0 + a1InQuote;
    }

    function _valueOf(uint256[] calldata idx) internal view returns (uint256 v) {
        uint160 sqrtTw = TickMath.getSqrtPriceAtTick(_twapTick());
        for (uint256 i; i < idx.length; i++) {
            v += _value0(sqrtTw, ranges[idx[i]]);
        }
    }

    function _totalValue() internal view returns (uint256 v) {
        uint160 sqrtTw = TickMath.getSqrtPriceAtTick(_twapTick());
        for (uint256 i; i < ranges.length; i++) {
            v += _value0(sqrtTw, ranges[i]);
        }
    }

    function totalValue0() external view returns (uint256) {
        return _totalValue();
    }

    function rangeCount() external view returns (uint256) {
        return ranges.length;
    }

    // ----------------------------------------------------------------- twap
    function _record(int24 tick) internal {
        uint32 now_ = uint32(block.timestamp);
        if (now_ > lastTs) {
            lastCum += int56(lastTick) * int56(uint56(now_ - lastTs));
            lastTs = now_;
            obsIdx = uint8((obsIdx + 1) % 32);
            obs[obsIdx] = Obs(now_, lastCum, tick);
            if (obsCount < 32) obsCount++;
        } else {
            obs[obsIdx].tick = tick;
        }
        lastTick = tick;
    }

    /// @dev Time-weighted average tick over `twapWindow`, from the ring of observations. The current
    ///      block's spot only enters through time elapsed since it was recorded, so a swap and a state
    ///      change in the same block see the pre-swap TWAP.
    function _twapTick() internal view returns (int24) {
        uint32 now_ = uint32(block.timestamp);
        int56 cumNow = lastCum + int56(lastTick) * int56(uint56(now_ - lastTs));
        uint32 target = now_ > terms.twapWindow ? now_ - terms.twapWindow : 0;
        // newest observation at or before target
        Obs memory oldest = obs[obsIdx];
        for (uint8 i; i < obsCount; i++) {
            Obs memory o = obs[uint8((obsIdx + 32 - i) % 32)];
            oldest = o;
            if (o.ts <= target) {
                int56 cumAt = o.cum + int56(o.tick) * int56(uint56(target - o.ts));
                return int24((cumNow - cumAt) / int56(uint56(now_ - target)));
            }
        }
        // history shorter than the window: average over what we have
        if (oldest.ts >= now_) return oldest.tick;
        return int24((cumNow - oldest.cum) / int56(uint56(now_ - oldest.ts)));
    }

    function twapTick() external view returns (int24) {
        return _twapTick();
    }

    // ---------------------------------------------------------------- misc
    function _floor(int24 t) internal view returns (int24) {
        int24 s = key.tickSpacing;
        int24 f = (t / s) * s;
        if (t < 0 && f != t) f -= s;
        return f;
    }

    function _bal0() internal view returns (uint256) {
        return address(this).balance;
    }

    function _bal1() internal view returns (uint256) {
        return IERC20(Currency.unwrap(key.currency1)).balanceOf(address(this));
    }

    function rangeAt(uint256 i) external view returns (Range memory) {
        return ranges[i];
    }

    function amountsOf(uint256 i) external view returns (uint256 a0, uint256 a1) {
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        return _amounts(sqrtP, ranges[i]);
    }
}
