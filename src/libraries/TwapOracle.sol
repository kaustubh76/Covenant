// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title TwapOracle
/// @notice Time-weighted average of a slew-limited tick, with history that cannot be flushed out of the window.
/// @dev The recorded tick never jumps to the pool's spot tick. After each write it walks toward the newest spot tick
///      by at most `rate` ticks per second, one whole second at a time, and stays there once it arrives. The oracle
///      integrates that walk exactly, in closed form, so:
///      - writes sharing a timestamp only replace the target, and a same-block round trip leaves no trace;
///      - a spike held for h seconds moves the recorded tick by at most rate * h, however far spot went;
///      - a price moved through empty ticks, which costs nothing, cannot drag the average quickly.
///
///      Storage is a ring of CARDINALITY slots. A slot covers every write within BUCKET seconds of its first write;
///      the next write after that opens a new slot. Slots therefore start at least BUCKET apart, and the ring always
///      reaches back at least (CARDINALITY - 1) * BUCKET seconds however often the pool trades. (A ring with one
///      slot per write could be emptied by 32 swaps in 32 blocks.)
///
///      Each slot keeps its first write and its latest write. Between a slot's latest write and the next slot's
///      first write nothing changed, so the cumulative at any moment in that gap is exact. A window that starts
///      inside a slot's burst of writes starts at that slot's first write instead: up to BUCKET seconds early,
///      never late.
library TwapOracle {
    using SafeCast for int256;

    uint32 internal constant BUCKET = 60;
    uint256 internal constant CARDINALITY = 128;
    /// @notice Longest window guaranteed to have full history (once the pool is old enough).
    uint32 internal constant MAX_WINDOW = 2 hours;

    /// @dev One storage word: 32 + 56 + 32 + 56 + 24 + 24 = 224 bits.
    struct Slot {
        uint32 firstTs; // first write in this slot
        int56 firstCum; // cumulative tick-seconds at firstTs
        uint32 lastTs; // latest write in this slot
        int56 lastCum; // cumulative tick-seconds at lastTs
        int24 lastTick; // recorded tick at lastTs
        int24 target; // spot tick the recorded tick walks toward after lastTs
    }

    struct State {
        Slot[CARDINALITY] slots;
        uint16 index; // newest slot
        uint16 count; // slots written, at most CARDINALITY
    }

    error OracleAlreadyInitialized();
    error OracleNotInitialized();

    function initialize(State storage self, uint32 time, int24 tick) internal {
        if (self.count != 0) revert OracleAlreadyInitialized();
        self.slots[0] = Slot(time, 0, time, 0, tick, tick);
        self.count = 1;
    }

    /// @notice Record that the pool's spot tick is `spot` from `time` on.
    function write(State storage self, uint32 time, int24 spot, uint256 rate) internal {
        uint256 idx = self.index;
        Slot memory cur = self.slots[idx];
        if (self.count == 0) revert OracleNotInitialized();
        if (time == cur.lastTs) {
            if (cur.target != spot) self.slots[idx].target = spot;
            return;
        }
        (int256 area, int24 tick) = advance(cur.lastTick, cur.target, time - cur.lastTs, rate);
        int56 cum = (int256(cur.lastCum) + area).toInt56();
        if (time - cur.firstTs < BUCKET) {
            self.slots[idx] = Slot(cur.firstTs, cur.firstCum, time, cum, tick, spot);
        } else {
            uint256 next = (idx + 1) % CARDINALITY;
            self.slots[next] = Slot(time, cum, time, cum, tick, spot);
            self.index = uint16(next);
            if (self.count < CARDINALITY) self.count++;
        }
    }

    /// @notice Average recorded tick over the `window` seconds before `time`, rounded toward negative infinity.
    /// @dev A zero window returns the recorded tick at `time`. With less history than `window`, averages what exists.
    function consult(State storage self, uint32 time, uint32 window, uint256 rate) internal view returns (int24) {
        if (self.count == 0) revert OracleNotInitialized();
        Slot memory latest = self.slots[self.index];
        (int256 areaNow, int24 tickNow) = advance(latest.lastTick, latest.target, time - latest.lastTs, rate);
        if (window == 0) return tickNow;
        int256 cumNow = int256(latest.lastCum) + areaNow;

        (uint32 start, int256 cumStart) = _startOf(self, latest, time > window ? time - window : 0, rate);
        if (start == time) return tickNow;
        int256 span = int256(uint256(time - start));
        int256 delta = cumNow - cumStart;
        int256 avg = delta / span;
        if (delta < 0 && delta % span != 0) avg--;
        return int24(avg);
    }

    /// @notice The recorded (slew-limited) tick at `time`.
    function recordedTick(State storage self, uint32 time, uint256 rate) internal view returns (int24 tick) {
        if (self.count == 0) revert OracleNotInitialized();
        Slot memory latest = self.slots[self.index];
        (, tick) = advance(latest.lastTick, latest.target, time - latest.lastTs, rate);
    }

    /// @notice Integrates the recorded tick over `dt` whole seconds.
    /// @dev Second s (0-based) contributes tick + sign * min(rate * s, d), where d = |target - tick|. Summing gives
    ///      dt * tick + sign * (rate * m(m+1)/2 + d * max(0, dt - 1 - n)), with n = d / rate and m = min(dt - 1, n).
    /// @return area Tick-seconds accumulated over the `dt` seconds.
    /// @return next The recorded tick after `dt` seconds.
    function advance(int24 tick, int24 target, uint256 dt, uint256 rate)
        internal
        pure
        returns (int256 area, int24 next)
    {
        if (dt == 0) return (0, tick);
        int256 diff = int256(target) - int256(tick);
        if (diff == 0) return (int256(tick) * int256(dt), tick);
        uint256 d = diff > 0 ? uint256(diff) : uint256(-diff);
        uint256 n = d / rate;
        uint256 m = dt - 1 < n ? dt - 1 : n;
        uint256 walk = rate * (m * (m + 1) / 2);
        if (dt - 1 > n) walk += d * (dt - 1 - n);
        uint256 moved = dt >= n + 1 ? d : rate * dt;
        if (diff > 0) {
            area = int256(tick) * int256(dt) + int256(walk);
            next = int24(int256(tick) + int256(moved));
        } else {
            area = int256(tick) * int256(dt) - int256(walk);
            next = int24(int256(tick) - int256(moved));
        }
    }

    /// @dev Where the window that should start at `t` actually starts, and the cumulative there.
    function _startOf(State storage self, Slot memory latest, uint32 t, uint256 rate)
        private
        view
        returns (uint32 start, int256 cumStart)
    {
        Slot memory k = latest;
        if (t < latest.firstTs) {
            bool found;
            (found, k) = _newestStartingBy(self, t);
            // Less history than the window: average from the oldest write still held.
            if (!found) return (k.firstTs, k.firstCum);
        }
        if (t >= k.lastTs) {
            // Nothing was written between k's latest write and t, so the walk from there is known.
            (int256 area,) = advance(k.lastTick, k.target, t - k.lastTs, rate);
            return (t, int256(k.lastCum) + area);
        }
        // t falls inside k's burst of writes: start at its first write, under BUCKET seconds earlier.
        return (k.firstTs, k.firstCum);
    }

    /// @dev Newest slot whose first write is at or before `t`. Returns the oldest slot and false if there is none.
    function _newestStartingBy(State storage self, uint32 t) private view returns (bool found, Slot memory slot) {
        uint256 n = self.count;
        uint256 oldest = n == CARDINALITY ? (uint256(self.index) + 1) % CARDINALITY : 0;
        slot = self.slots[oldest];
        if (slot.firstTs > t) return (false, slot);
        // Invariant: the slot at chronological position lo starts at or before t.
        uint256 lo;
        uint256 hi = n - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) >> 1;
            if (self.slots[(oldest + mid) % CARDINALITY].firstTs <= t) lo = mid;
            else hi = mid - 1;
        }
        return (true, self.slots[(oldest + lo) % CARDINALITY]);
    }
}
