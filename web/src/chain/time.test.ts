import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type { ChainCtx } from "./client";
import { FakeAnvil, notOfferedSend } from "./fakeanvil.testkit";
import type { Send } from "./snapguard";
import { type Gone, MAX_MINE, SnapshotGone, TooManyBlocks, mineTo, onReverted, revertTo, sandbox, setSnapshotSender, snapshot, takeSnapshot } from "./time";

const URL = "http://127.0.0.1:8545";

/** A dev chain at block `head` whose Anvil answers evm_revert with `reverts`, and records what it was asked to mine. */
function devChain(head: bigint, reverts: boolean, mined: number[]) {
  const test = {
    mine: async ({ blocks }: { blocks: number }) => void mined.push(blocks),
    request: async ({ method }: { method: string }) => (method === "evm_revert" ? reverts : null),
    snapshot: async () => "0x5" as Hex,
  };
  return { net: { rpcUrl: URL, caps: { devChain: true } }, test, pub: { getBlock: async () => ({ number: head, timestamp: 1_000n }) } } as unknown as ChainCtx;
}

/** A dev chain whose snapshot calls go to `chain` (the plain test client is never used then). */
const onFake = () => devChain(1n, true, []);

describe("mineTo", () => {
  it("mines up to the block asked for", async () => {
    const mined: number[] = [];
    await mineTo(devChain(100n, true, mined), 300n);
    expect(mined).toEqual([200]);
  });

  it("mines nothing for a block already behind", async () => {
    const mined: number[] = [];
    await mineTo(devChain(100n, true, mined), 50n);
    expect(mined).toEqual([]);
  });

  it("refuses a target past the cap (another chain's block height), and mines nothing", async () => {
    const mined: number[] = [];
    const far = 100n + BigInt(MAX_MINE) + 1n;
    await expect(mineTo(devChain(100n, true, mined), far)).rejects.toBeInstanceOf(TooManyBlocks);
    await expect(mineTo(devChain(100n, true, mined), 61_262_454n)).rejects.toThrow(/Nothing was mined/);
    expect(mined).toEqual([]);
    // the cap itself is fine: a dev launch's auction is about 200 blocks
    await mineTo(devChain(100n, true, mined), 100n + BigInt(MAX_MINE));
    expect(mined).toEqual([MAX_MINE]);
  });
});

describe("on a chain that does not say what it holds (a Playground backend before anvil_metadata)", () => {
  beforeEach(() => setSnapshotSender(notOfferedSend));
  afterEach(() => setSnapshotSender(null));

  it("snapshots and reverts as before", async () => {
    await expect(snapshot(devChain(1n, true, []))).resolves.toBe("0x5");
    await expect(revertTo(devChain(1n, true, []), "0x1")).resolves.toBeUndefined();
  });

  it("throws SnapshotGone when Anvil had no such snapshot, rather than report a revert that did not happen", async () => {
    const e = await revertTo(devChain(1n, false, []), "0x7").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SnapshotGone);
    expect((e as SnapshotGone).name).toBe("SnapshotGone");
    expect((e as SnapshotGone).why).toBe("gone");
    expect((e as SnapshotGone).message).toMatch(/^That save point is gone: the chain was reset, or taken back past it/);
  });
});

describe("on a chain that says what it holds: every revert checked first", () => {
  let chain: FakeAnvil;
  let heard: [Hex, Gone][];
  let stop: () => void;
  const use = (c: FakeAnvil, wrap?: (inner: Send) => Send) => {
    chain = c;
    setSnapshotSender(wrap ? wrap(c.send) : c.send);
  };
  beforeEach(() => {
    use(new FakeAnvil());
    heard = [];
    stop = onReverted((_url, id, gone) => void heard.push([id, gone]));
  });
  afterEach(() => {
    stop();
    setSnapshotSender(null);
  });
  /** The methods asked for from the `from`th call on. */
  const since = (from: number) => chain.calls.slice(from);

  it("takes a snapshot between two reads of the chain, in one request, and goes back to it", async () => {
    const ctx = onFake();
    chain.mine(2);
    const { id, record } = await takeSnapshot(ctx);
    expect(chain.calls).toEqual(["anvil_metadata", "anvil_metadata", "evm_snapshot", "anvil_metadata"]); // the first is the probe
    expect(record).toMatchObject({ id, instance: chain.instance, block: chain.head, below: 0 });
    chain.mine(5);
    await revertTo(ctx, id);
    expect(chain.state).toBe(2);
    expect(heard).toEqual([[id, "from"]]);
  });

  it("Save, then the demo's Start over, then Back to save: SnapshotGone, and no revert sent", async () => {
    const ctx = onFake();
    const demo = await snapshot(ctx);
    chain.mine(8);
    const save = await snapshot(ctx);
    await revertTo(ctx, demo); // Start over
    const from = chain.calls.length;
    const e = await revertTo(ctx, save).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SnapshotGone);
    expect((e as SnapshotGone).why).toBe("gone");
    expect(since(from)).not.toContain("evm_revert");
    expect(chain.wedged).toBe(false);
  });

  it("a point kept across a reload is checked by the record it carries", async () => {
    const ctx = onFake();
    const s1 = await takeSnapshot(ctx);
    const s2 = await takeSnapshot(ctx); // at the same block
    setSnapshotSender(chain.send); // a new page: no records kept in memory
    await revertTo(ctx, s1.id, s1.record);
    chain.mine(3);
    const from = chain.calls.length;
    await expect(revertTo(ctx, s2.id, s2.record)).rejects.toMatchObject({ name: "SnapshotGone", why: "gone" });
    expect(since(from)).not.toContain("evm_revert");
    expect(chain.state).toBe(3);
  });

  it("a point from a chain that has since restarted: SnapshotGone 'restarted', nothing sent", async () => {
    const ctx = onFake();
    const old = await takeSnapshot(ctx);
    const fresh = new FakeAnvil(2);
    fresh.snapshot(); // the same id, a different snapshot
    use(fresh);
    await expect(revertTo(ctx, old.id, old.record)).rejects.toMatchObject({ name: "SnapshotGone", why: "restarted" });
    expect(fresh.calls).not.toContain("evm_revert");
  });

  it("the same revert asked twice (a retried request): refused the second time, so nothing later is dropped", async () => {
    const ctx = onFake();
    const s = await snapshot(ctx);
    await revertTo(ctx, s);
    const later = await snapshot(ctx);
    const from = chain.calls.length;
    await expect(revertTo(ctx, s)).rejects.toMatchObject({ why: "gone" });
    expect(since(from)).not.toContain("evm_revert");
    expect(chain.saved.has(BigInt(later))).toBe(true);
  });

  it("nested sandboxes go back in turn, and a sandbox whose snapshot went from under it throws SnapshotGone", async () => {
    const ctx = onFake();
    const got = await sandbox(ctx, async () => {
      chain.mine(2);
      await sandbox(ctx, async () => void chain.mine(3));
      return chain.state;
    });
    expect(got).toBe(2);
    expect(chain.state).toBe(0);
    const base = await snapshot(ctx);
    chain.mine();
    const e = await sandbox(ctx, async () => {
      chain.mine();
      chain.revert(base); // another tab's Reset, mid-run
    }).catch((x: unknown) => x);
    expect(e).toMatchObject({ name: "SnapshotGone" });
    expect(chain.wedged).toBe(false);
  });

  it("torn: another tab goes back past it between the check and the revert; said, and every point dropped", async () => {
    const ctx = onFake();
    const base = await snapshot(ctx);
    chain.mine(3);
    const s = await snapshot(ctx);
    use(chain, (inner) => async (url, calls) => {
      if (calls[0]?.method === "evm_revert") chain.revert(base); // the other tab, a moment earlier
      return inner(url, calls);
    });
    const e = await revertTo(ctx, s).catch((x: unknown) => x);
    expect(e).toMatchObject({ name: "SnapshotGone", why: "torn" });
    expect((e as Error).message).toMatch(/did not finish cleanly.*Reset it/);
    expect(heard.at(-1)).toEqual([s, "all"]);
  });

  it("refused by the Playground's proxy after the check passed: gone, nothing moved, only that point dropped", async () => {
    const proxied = new FakeAnvil(3, { proxied: true });
    use(proxied);
    const ctx = onFake();
    const s = await snapshot(ctx);
    proxied.mine(2);
    proxied.held!.delete(BigInt(s)); // the proxy no longer holds it
    await expect(revertTo(ctx, s)).rejects.toMatchObject({ why: "gone" });
    expect(proxied.state).toBe(2);
    expect(heard.at(-1)).toEqual([s, "one"]);
  });

  it("no answer to the revert: done if the chain shows it done, otherwise nothing dropped", async () => {
    const ctx = onFake();
    const s = await snapshot(ctx);
    chain.mine(2);
    use(chain, (inner) => async (url, calls) => {
      if (calls[0]?.method !== "evm_revert") return inner(url, calls);
      await inner(url, calls); // it ran, and the answer was lost
      throw new TypeError("fetch failed");
    });
    await revertTo(ctx, s);
    expect(chain.state).toBe(0);
    expect(heard.at(-1)).toEqual([s, "from"]);

    const t = await snapshot(ctx);
    use(chain, (inner) => async (url, calls) => {
      if (calls[0]?.method === "evm_revert") throw new TypeError("fetch failed"); // never arrived
      return inner(url, calls);
    });
    const count = heard.length;
    await expect(revertTo(ctx, t)).rejects.toThrow(/did not answer the revert.*nothing moved/);
    expect(heard).toHaveLength(count);
    expect(chain.list.has(BigInt(t))).toBe(true);
  });

  it("a snapshot the reads cannot vouch for is taken again; if it keeps happening, refused before anything runs", async () => {
    const ctx = onFake();
    let moved = 0;
    use(chain, (inner) => async (url, calls) => {
      const out = await inner(url, calls);
      // a block mined by someone else just after the snapshot, the first time only
      if (calls[1]?.method === "evm_snapshot" && moved++ === 0) {
        chain.mine();
        return [out[0], out[1], chain.answer("anvil_metadata", [])];
      }
      return out;
    });
    const { record } = await takeSnapshot(ctx);
    expect(moved).toBe(2);
    expect(record?.block).toEqual(chain.head);

    use(chain, (inner) => async (url, calls) => {
      const out = await inner(url, calls);
      if (calls[1]?.method !== "evm_snapshot") return out;
      chain.mine();
      return [out[0], out[1], chain.answer("anvil_metadata", [])];
    });
    let ran = false;
    await expect(sandbox(ctx, async () => void (ran = true))).rejects.toThrow(/kept changing/);
    expect(ran).toBe(false);
  });
});
