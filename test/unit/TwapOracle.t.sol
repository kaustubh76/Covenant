// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {TwapOracle} from "../../src/libraries/TwapOracle.sol";

contract OracleHarness {
    using TwapOracle for TwapOracle.State;

    TwapOracle.State internal s;
    uint256 public immutable rate;

    constructor(uint256 rate_) {
        rate = rate_;
    }

    function initialize(uint32 time, int24 tick) external {
        s.initialize(time, tick);
    }

    function write(uint32 time, int24 spot) external {
        s.write(time, spot, rate);
    }

    function consult(uint32 time, uint32 window) external view returns (int24) {
        return s.consult(time, window, rate);
    }

    function recordedTick(uint32 time) external view returns (int24) {
        return s.recordedTick(time, rate);
    }

    function latest() external view returns (TwapOracle.Slot memory) {
        return s.slots[s.index];
    }

    function count() external view returns (uint16) {
        return s.count;
    }
}

/// @notice Checks the oracle against a model that shares none of its machinery: it steps every second one at a time,
///         keeps every second's tick in a flat array, and recomputes window starts from the list of writes.
contract TwapOracleTest is Test {
    uint32 constant T0 = 1_800_000_000;
    uint32 constant BUCKET = 60;
    uint256 constant CARDINALITY = 128;

    // ----------------------------------------------------------------- reference model
    struct Model {
        uint256 rate;
        int24 tick; // recorded tick at `cursor`
        int24 target;
        uint32 cursor; // next second to simulate
        int256[] prefix; // prefix[i] = sum of recorded ticks over seconds [T0, T0 + i)
        uint32[] groupFirst;
        uint32[] groupLast;
        uint256 groups;
    }

    function _model(uint256 rate, int24 tick0, uint256 seconds_, uint256 maxGroups)
        internal
        pure
        returns (Model memory m)
    {
        m.rate = rate;
        m.tick = tick0;
        m.target = tick0;
        m.cursor = T0;
        m.prefix = new int256[](seconds_ + 1);
        m.groupFirst = new uint32[](maxGroups);
        m.groupLast = new uint32[](maxGroups);
        m.groupFirst[0] = T0;
        m.groupLast[0] = T0;
        m.groups = 1;
    }

    function _step(Model memory m) internal pure {
        uint256 i = m.cursor - T0;
        m.prefix[i + 1] = m.prefix[i] + m.tick;
        int256 diff = int256(m.target) - int256(m.tick);
        int256 r = int256(m.rate);
        if (diff > r) diff = r;
        if (diff < -r) diff = -r;
        m.tick = int24(int256(m.tick) + diff);
        m.cursor++;
    }

    function _simulateTo(Model memory m, uint32 time) internal pure {
        while (m.cursor < time) _step(m);
    }

    function _modelWrite(Model memory m, uint32 time, int24 spot) internal pure {
        _simulateTo(m, time);
        uint256 g = m.groups - 1;
        if (time != m.groupLast[g]) {
            if (time - m.groupFirst[g] < BUCKET) {
                m.groupLast[g] = time;
            } else {
                m.groupFirst[m.groups] = time;
                m.groupLast[m.groups] = time;
                m.groups++;
            }
        }
        m.target = spot;
    }

    /// @dev The window rule, restated from the oracle's documentation rather than from its code.
    function _expectedStart(Model memory m, uint32 time, uint32 window) internal pure returns (uint32) {
        uint32 t = time > window ? time - window : 0;
        uint256 last = m.groups - 1;
        if (t >= m.groupLast[last]) return t;
        uint256 oldest = m.groups > CARDINALITY ? m.groups - CARDINALITY : 0;
        if (m.groupFirst[oldest] > t) return m.groupFirst[oldest];
        uint256 k = oldest;
        for (uint256 i = oldest; i <= last; i++) {
            if (m.groupFirst[i] <= t) k = i;
        }
        return t >= m.groupLast[k] ? t : m.groupFirst[k];
    }

    function _expectedTwap(Model memory m, uint32 time, uint32 window) internal pure returns (int24) {
        _simulateTo(m, time);
        if (window == 0) return m.tick;
        uint32 start = _expectedStart(m, time, window);
        if (start == time) return m.tick;
        int256 delta = m.prefix[time - T0] - m.prefix[start - T0];
        int256 span = int256(uint256(time - start));
        int256 avg = delta / span;
        if (delta < 0 && delta % span != 0) avg--;
        return int24(avg);
    }

    function _checkWindows(OracleHarness o, Model memory m, uint32 time, uint256 seed) internal view {
        uint32[10] memory windows = [uint32(0), 1, 59, 60, 61, 300, 900, 1800, 3600, uint32(seed % 7200)];
        for (uint256 i; i < windows.length; i++) {
            assertEq(o.consult(time, windows[i]), _expectedTwap(m, time, windows[i]), "consult != reference");
        }
        assertEq(o.recordedTick(time), m.tick, "recorded tick != reference");
    }

    // ----------------------------------------------------------------- the closed form
    function testFuzz_advanceMatchesStepping(int24 tick, int24 target, uint16 dtSeed, uint8 rateSeed) public pure {
        tick = int24(bound(tick, -887_272, 887_272));
        target = int24(bound(target, -887_272, 887_272));
        uint256 dt = bound(dtSeed, 0, 3000);
        uint256 rate = bound(rateSeed, 1, 200);

        int256 area;
        int256 r = tick;
        for (uint256 s; s < dt; s++) {
            area += r;
            int256 diff = int256(target) - r;
            if (diff > int256(rate)) diff = int256(rate);
            if (diff < -int256(rate)) diff = -int256(rate);
            r += diff;
        }
        (int256 gotArea, int24 gotNext) = TwapOracle.advance(tick, target, dt, rate);
        assertEq(gotArea, area, "area");
        assertEq(int256(gotNext), r, "next tick");
    }

    function test_advanceHandlesMultiDayGapsWithoutOverflow() public pure {
        (int256 area, int24 next) = TwapOracle.advance(-887_272, 887_272, 365 days, 1);
        assertEq(next, 887_272);
        assertGt(area, 0);
    }

    // ----------------------------------------------------------------- whole-oracle equivalence
    function testFuzz_matchesPerSecondReference(uint256 seed, uint8 rateSeed, uint8 writesSeed, int24 tick0) public {
        uint256 writes = bound(writesSeed, 1, 40);
        tick0 = int24(bound(tick0, -50_000, 50_000));
        OracleHarness o = new OracleHarness(bound(rateSeed, 1, 40));
        o.initialize(T0, tick0);
        Model memory m = _model(o.rate(), tick0, writes * 150 + 2, writes + 1);

        uint32 time = T0;
        for (uint256 i; i < writes; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            time = _randomWrite(o, m, time, seed);
            _checkWindows(o, m, time, seed >> 128);
        }
    }

    /// @dev A third of writes share the previous timestamp, some land inside the current bucket, some cross it.
    function _randomWrite(OracleHarness o, Model memory m, uint32 time, uint256 seed) internal returns (uint32) {
        uint256 kind = seed % 3;
        if (kind == 1) time += uint32((seed >> 8) % 59 + 1);
        else if (kind == 2) time += uint32((seed >> 8) % 150 + 1);
        int24 spot = int24(int256((seed >> 64) % 100_001) - 50_000);
        o.write(time, spot);
        _modelWrite(m, time, spot);
        return time;
    }

    function test_ringWrapStillCoversTheWindow() public {
        uint256 rate = 7;
        OracleHarness o = new OracleHarness(rate);
        o.initialize(T0, 0);
        uint256 writes = 320; // 2.5 laps of the ring
        Model memory m = _model(rate, 0, writes * 61 + 1, writes + 1);
        uint32 time = T0;
        for (uint256 i; i < writes; i++) {
            time += 61;
            int24 spot = int24(int256(uint256(keccak256(abi.encode(i))) % 20_001) - 10_000);
            o.write(time, spot);
            _modelWrite(m, time, spot);
        }
        assertEq(o.count(), CARDINALITY, "ring full");
        for (uint32 w = 0; w <= TwapOracle.MAX_WINDOW; w += 450) {
            assertEq(o.consult(time, w), _expectedTwap(m, time, w), "consult after wrap");
            uint32 start = _expectedStart(m, time, w);
            assertLe(start, time - w, "window never shorter than asked");
        }
    }

    // ----------------------------------------------------------------- properties, stated plainly
    /// @dev The prototype's 32-slot ring lost its window after 32 swaps in 32 blocks. Here a swap every block
    ///      (2 seconds, as on Base) for an hour still leaves the full 30-minute window covered.
    function test_swapEveryBlockCannotShortenTheWindow() public {
        OracleHarness o = new OracleHarness(10);
        o.initialize(T0, 0);
        Model memory m = _model(10, 0, 3601, 3601);
        uint32 time = T0;
        for (uint256 i; i < 1800; i++) {
            time += 2;
            int24 spot = int24(int256(uint256(keccak256(abi.encode("blk", i))) % 4001) - 2000);
            o.write(time, spot);
            _modelWrite(m, time, spot);
        }
        assertLt(o.count(), 70, "about one slot per minute, not one per swap");
        uint32 start = _expectedStart(m, time, 1800);
        assertLe(start, time - 1800, "window is at least 30 minutes");
        assertGt(start + BUCKET, time - 1800, "and starts less than one bucket early");
        assertEq(o.consult(time, 1800), _expectedTwap(m, time, 1800));
    }

    function test_sameBlockRoundTripLeavesNoTrace() public {
        OracleHarness a = new OracleHarness(10);
        OracleHarness b = new OracleHarness(10);
        a.initialize(T0, 100);
        b.initialize(T0, 100);
        a.write(T0 + 30, 100);
        b.write(T0 + 30, 100);
        // b: dump far away and come back inside one block
        b.write(T0 + 50, -400_000);
        b.write(T0 + 50, 400_000);
        b.write(T0 + 50, 100);
        a.write(T0 + 50, 100);
        assertEq(abi.encode(a.latest()), abi.encode(b.latest()), "identical state");
        assertEq(a.consult(T0 + 4000, 1800), b.consult(T0 + 4000, 1800));
    }

    function test_spikeMovesRecordedTickAtMostRateTimesDuration() public {
        uint256 rate = 10;
        OracleHarness o = new OracleHarness(rate);
        o.initialize(T0, 0);
        o.write(T0 + 3600, 500_000); // spot jumps 500k ticks
        o.write(T0 + 3604, 0); // and is pushed back two blocks later
        assertEq(o.recordedTick(T0 + 3604), 40, "moved rate * 4 seconds");
        // the 30-minute average barely notices: area of the excursion / window
        int24 twap = o.consult(T0 + 3700, 1800);
        assertLe(twap, 1, "a two-block spike of 500k ticks shifts the TWAP by under one tick");
    }

    function test_heldMoveIsAcceptedOnceTheWindowPasses() public {
        uint256 rate = 10;
        OracleHarness o = new OracleHarness(rate);
        o.initialize(T0, 0);
        o.write(T0 + 100, 3000);
        // The recorded tick ramps 0 -> 3000 at 10 ticks/s over 300 s. Right after the ramp the 30-minute window
        // still covers 100 s at 0 plus the ramp: (10 * 299 * 300 / 2) / 400 = 1121.
        assertEq(o.consult(T0 + 100 + 300, 1800), 1121, "lagging right after the ramp");
        assertEq(o.consult(T0 + 100 + 300 + 1800, 1800), 3000, "converged after ramp + window");
    }

    function test_historyShorterThanWindowAveragesWhatExists() public {
        OracleHarness o = new OracleHarness(1000);
        o.initialize(T0, 0);
        o.write(T0 + 10, 1000); // reached in one second
        // 10 s at 0, then 1 s at 0 (the step second), then 9 s at 1000 => 9000 / 20
        assertEq(o.consult(T0 + 20, 3600), 450);
    }

    function test_roundsTowardNegativeInfinity() public {
        OracleHarness o = new OracleHarness(1000);
        o.initialize(T0, -1);
        o.write(T0 + 1, 0);
        // seconds: [-1, 0) over 2 s => -1/2 => -1
        assertEq(o.consult(T0 + 2, 2), -1);
    }

    function test_revertsBeforeInitialization() public {
        OracleHarness o = new OracleHarness(10);
        vm.expectRevert(TwapOracle.OracleNotInitialized.selector);
        o.consult(T0, 60);
        vm.expectRevert(TwapOracle.OracleNotInitialized.selector);
        o.write(T0, 1);
    }

    function test_cannotInitializeTwice() public {
        OracleHarness o = new OracleHarness(10);
        o.initialize(T0, 0);
        vm.expectRevert(TwapOracle.OracleAlreadyInitialized.selector);
        o.initialize(T0 + 1, 0);
    }
}
