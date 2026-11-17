import { describe, expect, it } from "vitest";
import type { ChainCtx } from "./client";
import { forgetScans, mergeSpans, scanLogs, scanOnce, scanRange } from "./logs";

const ctxWith = (logRange?: number) => ({ net: { key: "base-sepolia", caps: { devChain: false, logRange, pollMs: 2000, blockTimeMs: 2000 } } }) as unknown as ChainCtx;

describe("scanRange", () => {
  it("splits a range into spans the RPC accepts, in order, covering every block once", async () => {
    const spans: [bigint, bigint][] = [];
    const out = await scanRange(ctxWith(200), 1000n, 1650n, async (a, b) => {
      spans.push([a, b]);
      return [a];
    });
    expect(spans).toEqual([
      [1000n, 1199n],
      [1200n, 1399n],
      [1400n, 1599n],
      [1600n, 1650n],
    ]);
    expect(out).toEqual([1000n, 1200n, 1400n, 1600n]);
    for (const [a, b] of spans) expect(b - a + 1n <= 200n).toBe(true);
  });

  it("reads in one call when the chain has no cap or the range fits", async () => {
    let calls = 0;
    const read = async () => {
      calls++;
      return [];
    };
    await scanRange(ctxWith(undefined), 0n, 1_000_000n, read);
    await scanRange(ctxWith(200), 10n, 209n, read);
    expect(calls).toBe(2);
    expect(await scanRange(ctxWith(200), 5n, 4n, read)).toEqual([]);
  });
});

const ctxAt = (latest: bigint, devChain = false) =>
  ({
    net: { key: "base-sepolia", caps: { devChain, logRange: 200, pollMs: 2000, blockTimeMs: 2000 } },
    pub: { getBlockNumber: async () => latest },
  }) as unknown as ChainCtx;

describe("scanOnce", () => {
  it("reads a past span once, in spans the RPC accepts, and keeps it", async () => {
    forgetScans();
    const spans: [bigint, bigint][] = [];
    const read = async (a: bigint, b: bigint) => {
      spans.push([a, b]);
      return [a];
    };
    const ctx = ctxAt(10_000n);
    expect(await scanOnce(ctx, "launch:0xa", 1000n, 1600n, read)).toEqual([1000n, 1200n, 1400n, 1600n]);
    expect(await scanOnce(ctx, "launch:0xa", 1000n, 1600n, read)).toEqual([1000n, 1200n, 1400n, 1600n]);
    expect(spans).toHaveLength(4);
  });

  it("reads nothing while the recent window still covers the span, or on the dev chain", async () => {
    forgetScans();
    let calls = 0;
    const read = async () => {
      calls++;
      return [];
    };
    expect(await scanOnce(ctxAt(2000n), "launch:0xb", 1000n, 1600n, read, 1800n)).toEqual([]);
    expect(await scanOnce(ctxAt(10_000n, true), "launch:0xb", 1000n, 1600n, read)).toEqual([]);
    expect(calls).toBe(0);
  });

  it("reads a span that reaches past the head up to the head, and does not keep it", async () => {
    forgetScans();
    const ends: bigint[] = [];
    const read = async (_a: bigint, b: bigint) => {
      ends.push(b);
      return [b];
    };
    const ctx = ctxAt(1400n);
    expect(await scanOnce(ctx, "launch:0xc", 1000n, 1600n, read, 300n)).toEqual([1199n, 1399n, 1400n]);
    await scanOnce(ctx, "launch:0xc", 1000n, 1600n, read, 300n);
    expect(ends).toHaveLength(6);
  });
});

describe("mergeSpans", () => {
  it("keeps each block once, merging blocks one log call can read together", () => {
    expect(mergeSpans([], [100, 150, 290, 5000, 5100])).toEqual([
      [100, 290],
      [5000, 5100],
    ]);
    expect(mergeSpans([], [100, 300])).toEqual([
      [100, 100],
      [300, 300],
    ]);
  });

  it("folds new blocks into the spans already kept, in block order", () => {
    expect(mergeSpans([[1000, 1100]], [1050, 950, 20_000])).toEqual([
      [950, 1100],
      [20_000, 20_000],
    ]);
    // 900 to 1100 is 201 blocks: one more than a call reads.
    expect(mergeSpans([[1000, 1100]], [900])).toEqual([
      [900, 900],
      [1000, 1100],
    ]);
    expect(mergeSpans([[1000, 1100]], [])).toEqual([[1000, 1100]]);
  });
});

describe("scanLogs on a public chain", () => {
  const ctxFrom = (latest: { at: bigint }) =>
    ({
      net: { key: "base-sepolia", caps: { devChain: false, logRange: 200, pollMs: 2000, blockTimeMs: 200 } },
      pub: { getBlockNumber: async () => latest.at },
    }) as unknown as ChainCtx;

  it("reads exactly the window on first load, the latest block included, then only new blocks", async () => {
    forgetScans();
    const latest = { at: 10_000n };
    const spans: [bigint, bigint][] = [];
    const read = async (a: bigint, b: bigint) => {
      spans.push([a, b]);
      return [];
    };
    await scanLogs(ctxFrom(latest), "w", 0n, read, 1800n);
    expect(spans[0][0]).toBe(10_000n - 1800n + 1n);
    expect(spans.at(-1)![1]).toBe(10_000n);
    expect(spans).toHaveLength(9);
    spans.length = 0;
    latest.at = 10_050n;
    await scanLogs(ctxFrom(latest), "w", 0n, read, 1800n);
    expect(spans).toEqual([[10_001n, 10_050n]]);
  });

  it("starts over from the window after a gap longer than it, instead of catching up block by block", async () => {
    forgetScans();
    const latest = { at: 10_000n };
    let calls = 0;
    const read = async () => {
      calls++;
      return [];
    };
    await scanLogs(ctxFrom(latest), "gap", 0n, read, 1800n);
    calls = 0;
    latest.at = 30_000n; // an hour and more of 200 ms blocks
    await scanLogs(ctxFrom(latest), "gap", 0n, read, 1800n);
    expect(calls).toBe(9);
  });
});
