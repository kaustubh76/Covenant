// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ICovenantVault} from "../interfaces/ICovenantVault.sol";
import {Range, Cut, Leg} from "../types/CovenantTypes.sol";
import {Orient} from "../libraries/Orient.sol";
import {CovenantLogic} from "../libraries/CovenantLogic.sol";
import {VaultStorage} from "./VaultStorage.sol";

/// @title VaultOps
/// @notice Everything a vault does inside a PoolManager unlock: remove and add liquidity, size new ranges from what
///         was freed, book fees apart from principal, and settle the net with the PoolManager.
/// @dev Runs only by DELEGATECALL from a CovenantVault's unlockCallback, on that vault's storage. Called any other way
///      it reverts. The vault checks the rules (Guard, Pace, Support) around the unlock; this contract enforces the
///      parts that can only be checked while liquidity moves: the bid ceiling, sinks staying single-sided, and the
///      idle cap.
contract VaultOps is VaultStorage {
    using StateLibrary for IPoolManager;
    using CurrencyLibrary for Currency;

    /// @dev A reshape may leave at most 0.1% of what it handled idle, plus a few wei of rounding.
    uint256 internal constant IDLE_BPS = 10;
    uint256 internal constant IDLE_FLOOR = 1000;
    uint256 internal constant Q128 = 1 << 128;

    IPoolManager internal immutable poolManager;
    address internal immutable self;

    error NotDelegated();

    /// @dev Running totals inside one unlock.
    struct Flow {
        PoolKey key;
        bool q0;
        uint160 sqrtSpot;
        int24 spotTick;
        int256 net0; // the PoolManager owes the vault when positive
        int256 net1;
        uint256 fee0;
        uint256 fee1;
        uint256 avail0; // principal freed and available to place
        uint256 avail1;
        uint256 used0; // principal placed
        uint256 used1;
    }

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
        self = address(this);
    }

    /// @notice Execute one vault operation. `data` is what the vault passed to PoolManager.unlock.
    function execute(bytes calldata data) external returns (bytes memory result) {
        if (address(this) == self) revert NotDelegated();
        (Op op, bytes memory payload) = abi.decode(data, (Op, bytes));
        Flow memory f;
        f.key = _key;
        f.q0 = quoteIsCurrency0;
        (f.sqrtSpot, f.spotTick,,) = poolManager.getSlot0(poolId);

        if (op == Op.Reshape) {
            (Cut[] memory cuts, Leg[] memory legs, int24 ceiling, uint256 sink0, uint256 sink1) =
                abi.decode(payload, (Cut[], Leg[], int24, uint256, uint256));
            _reshape(f, cuts, legs, ceiling, sink0, sink1);
        } else if (op == Op.Restore) {
            (uint256[] memory indices, int24 bandLower, int24 bandUpper, int24 askFloor) =
                abi.decode(payload, (uint256[], int24, int24, int24));
            result = abi.encode(_restore(f, indices, bandLower, bandUpper, askFloor));
        } else if (op == Op.Deposit) {
            (uint256 shares, address payer, uint256 paid) = abi.decode(payload, (uint256, address, uint256));
            result = _deposit(f, shares, payer, paid);
        } else if (op == Op.Withdraw) {
            result = _withdraw(f, abi.decode(payload, (uint256)));
        } else if (op == Op.Adopt) {
            (Range[] memory adds, uint256 principal0, uint256 principal1) =
                abi.decode(payload, (Range[], uint256, uint256));
            _adopt(f, adds, principal0, principal1);
        } else {
            _harvest(f);
        }
        _settle(f);
        _compact();
    }

    // =========================================================================================== operations

    /// @dev Re-add the burned launcher positions as vault-owned ranges at the same bounds.
    function _adopt(Flow memory f, Range[] memory adds, uint256 principal0, uint256 principal1) internal {
        f.avail0 = principal0;
        f.avail1 = principal1;
        for (uint256 i; i < adds.length; i++) {
            Range memory r = adds[i];
            if (r.liquidity == 0) continue;
            (uint256 a0, uint256 a1) = CovenantLogic.amounts(f.sqrtSpot, r.tickLower, r.tickUpper, r.liquidity);
            _place(f, r.tickLower, r.tickUpper, _less1(a0), _less1(a1));
        }
        idle0 += f.avail0 - f.used0;
        idle1 += f.avail1 - f.used1;
    }

    /// @dev Cuts free principal; legs place it by share, then sinks take whatever is left of their currency.
    function _reshape(Flow memory f, Cut[] memory cuts, Leg[] memory legs, int24 ceiling, uint256 sink0, uint256 sink1)
        internal
    {
        for (uint256 i; i < cuts.length; i++) {
            Range storage r = _ranges[cuts[i].index]; // validated by CovenantLogic.cutFraction
            _take(f, r, cuts[i].liquidity < r.liquidity ? cuts[i].liquidity : r.liquidity);
        }
        f.avail0 += idle0;
        f.avail1 += idle1;

        for (uint256 i; i < legs.length; i++) {
            Leg memory leg = legs[i];
            if (leg.share0 == SINK || leg.share1 == SINK) continue;
            _placeLeg(f, leg, _less1(f.avail0 * leg.share0 / 1e4), _less1(f.avail1 * leg.share1 / 1e4), ceiling);
        }
        if (sink0 < legs.length) {
            Leg memory leg = legs[sink0];
            if (f.spotTick >= leg.tickLower) revert ICovenantVault.SinkStraddlesPrice(sink0);
            _placeLeg(f, leg, _less1(f.avail0 - f.used0), 0, ceiling);
        }
        if (sink1 < legs.length) {
            Leg memory leg = legs[sink1];
            if (f.spotTick < leg.tickUpper) revert ICovenantVault.SinkStraddlesPrice(sink1);
            _placeLeg(f, leg, 0, _less1(f.avail1 - f.used1), ceiling);
        }

        uint256 left0 = f.avail0 - f.used0;
        uint256 left1 = f.avail1 - f.used1;
        if (left0 > _idleCap(f.avail0) || left1 > _idleCap(f.avail1)) {
            revert ICovenantVault.IdleTooLarge(left0, left1);
        }
        idle0 = left0;
        idle1 = left1;
    }

    /// @return quoteMoved Quote taken out of the restored ranges (idle swept along is not counted).
    function _restore(Flow memory f, uint256[] memory indices, int24 bandLower, int24 bandUpper, int24 askFloor)
        internal
        returns (uint256 quoteMoved)
    {
        uint256 len = _ranges.length;
        for (uint256 i; i < indices.length; i++) {
            uint256 idx = indices[i];
            if (idx >= len || (i > 0 && idx <= indices[i - 1])) revert ICovenantVault.InvalidCut(idx);
            quoteMoved += _restoreOne(f, idx, askFloor);
        }
        f.avail0 += idle0;
        f.avail1 += idle1;
        // All the quote goes into the band; token rounding leftovers stay idle.
        (uint256 q,) = Orient.split(f.q0, f.avail0 - f.used0, f.avail1 - f.used1);
        (uint256 b0, uint256 b1) = Orient.join(f.q0, _less1(q), 0);
        _place(f, bandLower, bandUpper, b0, b1);
        idle0 = f.avail0 - f.used0;
        idle1 = f.avail1 - f.used1;
    }

    /// @dev Empty one range. Its quote waits for the band; its tokens go back at the same prices or higher: same top,
    ///      bottom raised to the first aligned tick above the spot price. A restore can never sell tokens cheaper.
    function _restoreOne(Flow memory f, uint256 idx, int24 askFloor) internal returns (uint256 quote) {
        Range storage r = _ranges[idx];
        if (r.liquidity == 0) revert ICovenantVault.InvalidCut(idx);
        (int24 pl, int24 pu) = Orient.rangeToPrice(f.q0, r.tickLower, r.tickUpper);
        uint256 avail0Before = f.avail0;
        uint256 avail1Before = f.avail1;
        _take(f, r, r.liquidity);
        uint256 token;
        (quote, token) = Orient.split(f.q0, f.avail0 - avail0Before, f.avail1 - avail1Before);
        if (quote == 0) revert ICovenantVault.NoQuoteToRestore(idx);
        if (token > 1) _replaceAsk(f, pl, pu, askFloor, token - 1);
    }

    function _replaceAsk(Flow memory f, int24 priceLower, int24 priceUpper, int24 askFloor, uint256 token) internal {
        int24 askLower = priceLower > askFloor ? priceLower : askFloor;
        int24 askUpper = priceUpper > askLower ? priceUpper : askLower + f.key.tickSpacing;
        (int24 lo, int24 hi) = Orient.rangeToPool(f.q0, askLower, askUpper);
        (uint256 a0, uint256 a1) = Orient.join(f.q0, 0, token);
        _place(f, lo, hi, a0, a1);
    }

    /// @dev Add `shares / totalShares` of every range and of idle, rounded up, and collect it from `payer`.
    function _deposit(Flow memory f, uint256 shares, address payer, uint256 paid) internal returns (bytes memory) {
        uint256 supply = totalShares;
        uint256 n = _ranges.length;
        for (uint256 i; i < n; i++) {
            Range storage r = _ranges[i];
            uint128 add = SafeCast.toUint128(FullMath.mulDivRoundingUp(r.liquidity, shares, supply));
            (BalanceDelta delta, BalanceDelta fees) = _modify(f.key, r.tickLower, r.tickUpper, int256(uint256(add)));
            _book(f, delta, fees);
            BalanceDelta principal = delta - fees;
            f.used0 += uint256(-int256(principal.amount0()));
            f.used1 += uint256(-int256(principal.amount1()));
            r.liquidity += add;
        }
        uint256 i0 = FullMath.mulDivRoundingUp(idle0, shares, supply);
        uint256 i1 = FullMath.mulDivRoundingUp(idle1, shares, supply);
        idle0 += i0;
        idle1 += i1;
        uint256 owed0 = f.used0 + i0;
        uint256 owed1 = f.used1 + i1;
        _collect(f.key.currency0, payer, owed0, paid);
        _collect(f.key.currency1, payer, owed1, paid);
        return abi.encode(owed0, owed1);
    }

    /// @dev Remove `shares / totalShares` of every range and of idle, rounded down. Paid out by the vault afterwards.
    function _withdraw(Flow memory f, uint256 shares) internal returns (bytes memory) {
        uint256 supply = totalShares;
        uint256 n = _ranges.length;
        for (uint256 i; i < n; i++) {
            Range storage r = _ranges[i];
            uint128 cut = uint128(FullMath.mulDiv(r.liquidity, shares, supply));
            if (cut > 0) _take(f, r, cut);
        }
        uint256 i0 = FullMath.mulDiv(idle0, shares, supply);
        uint256 i1 = FullMath.mulDiv(idle1, shares, supply);
        idle0 -= i0;
        idle1 -= i1;
        return abi.encode(f.avail0 + i0, f.avail1 + i1);
    }

    /// @dev Touch every range so the PoolManager credits its fees.
    function _harvest(Flow memory f) internal {
        uint256 n = _ranges.length;
        for (uint256 i; i < n; i++) {
            Range storage r = _ranges[i];
            if (r.liquidity == 0) continue;
            (BalanceDelta delta, BalanceDelta fees) = _modify(f.key, r.tickLower, r.tickUpper, 0);
            _book(f, delta, fees);
        }
    }

    // =========================================================================================== mechanics

    /// @dev Remove `liquidity` from `r`. Principal becomes available to place; fees go to the pot.
    function _take(Flow memory f, Range storage r, uint128 liquidity) internal {
        (BalanceDelta delta, BalanceDelta fees) = _modify(f.key, r.tickLower, r.tickUpper, -int256(uint256(liquidity)));
        _book(f, delta, fees);
        BalanceDelta principal = delta - fees;
        f.avail0 += uint256(int256(principal.amount0()));
        f.avail1 += uint256(int256(principal.amount1()));
        r.liquidity -= liquidity;
    }

    /// @dev Place a curator leg and enforce the bid ceiling on it.
    function _placeLeg(Flow memory f, Leg memory leg, uint256 a0, uint256 a1, int24 ceiling) internal {
        if (_place(f, leg.tickLower, leg.tickUpper, a0, a1) == 0) return;
        // The quote a range holds sits at or below the lower of its top and the spot price.
        bool holdsQuote = f.q0 ? f.spotTick < leg.tickUpper : f.spotTick >= leg.tickLower;
        if (holdsQuote) {
            (, int24 pu) = Orient.rangeToPrice(f.q0, leg.tickLower, leg.tickUpper);
            int24 spotPrice = Orient.toPrice(f.q0, f.spotTick);
            int24 bidTop = pu < spotPrice ? pu : spotPrice;
            if (bidTop > ceiling) revert ICovenantVault.BidAboveCeiling(bidTop, ceiling);
        }
    }

    /// @dev Add as much liquidity to [lower, upper] as `a0`/`a1` allow at the spot price.
    function _place(Flow memory f, int24 lower, int24 upper, uint256 a0, uint256 a1)
        internal
        returns (uint128 liquidity)
    {
        liquidity = CovenantLogic.liquidityFor(f.sqrtSpot, lower, upper, a0, a1);
        if (liquidity == 0) return 0;
        (BalanceDelta delta, BalanceDelta fees) = _modify(f.key, lower, upper, int256(uint256(liquidity)));
        _book(f, delta, fees);
        BalanceDelta principal = delta - fees;
        f.used0 += uint256(-int256(principal.amount0()));
        f.used1 += uint256(-int256(principal.amount1()));
        _upsert(lower, upper, liquidity);
    }

    function _modify(PoolKey memory key, int24 lower, int24 upper, int256 liquidityDelta)
        internal
        returns (BalanceDelta delta, BalanceDelta fees)
    {
        return poolManager.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, liquidityDelta, bytes32(0)), "");
    }

    function _book(Flow memory f, BalanceDelta delta, BalanceDelta fees) internal pure {
        f.net0 += delta.amount0();
        f.net1 += delta.amount1();
        f.fee0 += uint256(int256(fees.amount0()));
        f.fee1 += uint256(int256(fees.amount1()));
    }

    /// @dev Book fees, then take what the PoolManager owes or pay what the vault owes.
    function _settle(Flow memory f) internal {
        _bookFees(f.fee0, f.fee1);
        _settleCurrency(f.key.currency0, f.net0);
        _settleCurrency(f.key.currency1, f.net1);
    }

    /// @dev Fees realized now were earned by the shares outstanding now: the curator's share first, the rest per share.
    ///      Callers that change shares do so only after the unlock, so this always sees the shares that earned them.
    function _bookFees(uint256 fee0, uint256 fee1) internal {
        if (fee0 == 0 && fee1 == 0) return;
        feePot0 += fee0;
        feePot1 += fee1;
        address c = curator;
        if (c != address(0)) {
            uint256 bps = _terms.curatorFeeBps;
            uint256 c0 = fee0 * bps / 1e4;
            uint256 c1 = fee1 * bps / 1e4;
            curatorFees0[c] += c0;
            curatorFees1[c] += c1;
            fee0 -= c0;
            fee1 -= c1;
        }
        uint256 supply = totalShares;
        if (supply == 0) return; // nothing to accrue to; stays in the pot
        feeGrowth0 += FullMath.mulDiv(fee0, Q128, supply);
        feeGrowth1 += FullMath.mulDiv(fee1, Q128, supply);
    }

    function _settleCurrency(Currency currency, int256 net) internal {
        if (net > 0) {
            poolManager.take(currency, address(this), uint256(net));
        } else if (net < 0) {
            uint256 owed = uint256(-net);
            if (currency.isAddressZero()) {
                poolManager.settle{value: owed}();
            } else {
                poolManager.sync(currency);
                currency.transfer(address(poolManager), owed);
                poolManager.settle();
            }
        }
    }

    /// @dev A depositor's payment must be in the vault before the unlock settles. Native ETH came with the call.
    function _collect(Currency currency, address payer, uint256 owed, uint256 paid) internal {
        if (currency.isAddressZero()) {
            if (paid < owed) revert ICovenantVault.InsufficientPayment(owed, paid);
        } else if (owed > 0) {
            SafeTransferLib.safeTransferFrom(Currency.unwrap(currency), payer, address(this), owed);
        }
    }

    /// @dev Keep at most one entry per (lower, upper): the PoolManager keys positions by owner and bounds, so a second
    ///      entry with the same bounds would count the same liquidity twice.
    function _upsert(int24 lower, int24 upper, uint128 liquidity) internal {
        uint256 n = _ranges.length;
        for (uint256 i; i < n; i++) {
            Range storage r = _ranges[i];
            if (r.tickLower == lower && r.tickUpper == upper) {
                r.liquidity += liquidity;
                return;
            }
        }
        _ranges.push(Range(lower, upper, liquidity));
    }

    function _compact() internal {
        uint256 i = _ranges.length;
        while (i > 0) {
            i--;
            if (_ranges[i].liquidity == 0) {
                _ranges[i] = _ranges[_ranges.length - 1];
                _ranges.pop();
            }
        }
    }

    function _idleCap(uint256 handled) internal pure returns (uint256) {
        uint256 cap = handled * IDLE_BPS / 1e4;
        return cap > IDLE_FLOOR ? cap : IDLE_FLOOR;
    }

    /// @dev Sizing from one wei less than available guarantees the rounded-up cost of the rounded-down liquidity
    ///      never exceeds what was freed.
    function _less1(uint256 x) internal pure returns (uint256) {
        return x > 0 ? x - 1 : 0;
    }
}
