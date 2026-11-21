import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { FakeAnvil as Anvil, H } from "./fakeanvil.testkit";
import { type BlockRef, type SnapRecord, acceptRecord, afterRevert, judge, listedBelow, parseMetadata, sanitizeStored, sendBatch, snapshotId, stillListed, withChainLock } from "./snapguard";

// anvil_metadata as Anvil 1.1.0 answered it on the local chain (2026-11-21), the seeded baseline and one save point
const REAL = {
  clientVersion: "anvil/v1.1.0",
  chainId: 31337,
  instanceId: "0xe335281a0d504244d38f88ac38bd5c491e04c9acf33e5ba8d0359bb7d268194c",
  latestBlockNumber: 138,
  latestBlockHash: "0x20dec157bac02af5bd9ac566f33a25e002885f9f88b586623c430095005e9c26",
  forkedNetwork: null,
  snapshots: {
    "0x0": [138, "0x20dec157bac02af5bd9ac566f33a25e002885f9f88b586623c430095005e9c26"],
    "0x1": [138, "0x20dec157bac02af5bd9ac566f33a25e002885f9f88b586623c430095005e9c26"],
  },
};

describe("parseMetadata", () => {
  it("reads Anvil's own answer", () => {
    const m = parseMetadata(REAL)!;
    expect(m.instance).toBe(REAL.instanceId);
    expect(m.head).toEqual({ number: 138, hash: REAL.latestBlockHash });
    expect([...m.listed.keys()]).toEqual([0n, 1n]);
    expect(m.listed.get(1n)).toEqual({ number: 138, hash: REAL.latestBlockHash });
  });
  it("takes decimal ids and hex block numbers too (1.7.1 adds fields it ignores)", () => {
    const m = parseMetadata({ ...REAL, clientSemver: "1.7.1", latestBlockNumber: "0x8a", snapshots: { "12": ["0x8a", REAL.latestBlockHash] } })!;
    expect(m.head.number).toBe(138);
    expect(m.listed.get(12n)?.number).toBe(138);
  });
  it("trusts nothing it cannot read whole", () => {
    expect(parseMetadata(null)).toBeNull();
    expect(parseMetadata({ ...REAL, instanceId: "0x1" })).toBeNull();
    expect(parseMetadata({ ...REAL, snapshots: [] })).toBeNull();
    expect(parseMetadata({ ...REAL, snapshots: { nope: [1, REAL.latestBlockHash] } })).toBeNull();
    expect(parseMetadata({ ...REAL, snapshots: { "0x2": [1] } })).toBeNull();
    expect(parseMetadata({ ...REAL, latestBlockNumber: -1 })).toBeNull();
  });
});

describe("snapshotId", () => {
  it("reads the forms Anvil writes, and nothing else", () => {
    expect(snapshotId("0x1f")).toBe(31n);
    expect(snapshotId("31")).toBe(31n);
    for (const bad of ["", "0x", "-1", "1e3", 31, null, "0xzz"]) expect(snapshotId(bad)).toBeNull();
  });
});

/** Take a snapshot the way the app does: the chain read just before and just after. */
function record(chain: Anvil): SnapRecord {
  const pre = chain.metadata();
  const id = chain.snapshot();
  const rec = acceptRecord(pre, id, chain.metadata());
  expect(rec).not.toBeNull();
  return rec!;
}

/** Go back the way the app does: judged first, sent only when it may be. */
function guardedRevert(chain: Anvil, rec: SnapRecord): "refused" | ReturnType<Anvil["revert"]> {
  const now = chain.metadata();
  const at = now.listed.get(BigInt(rec.id));
  if (!judge(rec.id, rec, now, at ? chain.hashAt(at.number) : null).ok) return "refused";
  return chain.revert(rec.id);
}

describe("the model follows Anvil", () => {
  it("a revert to a snapshot made stale half-reverts, or wedges the head, exactly as uhi-11-08 reproduced on 1.1.0", () => {
    const a = new Anvil();
    const s1 = a.snapshot();
    const s2 = a.snapshot();
    expect(a.revert(s1)).toBe("full");
    a.mine(3);
    expect(a.revert(s2)).toBe("half");
    expect(a.head.number).toBe(0);
    expect(a.state).toBe(3); // blocks and clock went back, the state did not

    const b = new Anvil();
    const t1 = b.snapshot();
    b.mine(2);
    const t2 = b.snapshot();
    expect(b.revert(t1)).toBe("full");
    expect(b.revert(t2)).toBe("wedged");
    expect(b.wedged).toBe(true);
  });
  it("a revert to an id already used answers false and silently drops every later snapshot", () => {
    const a = new Anvil();
    const u = a.snapshot();
    expect(a.revert(u)).toBe("full");
    a.mine();
    const later = a.snapshot();
    expect(a.revert(u)).toBe("used");
    expect(a.list.has(BigInt(later))).toBe(true); // still listed...
    expect(a.saved.has(BigInt(later))).toBe(false); // ...but gone
  });
});

describe("judge: the check before any revert", () => {
  it("lets a live snapshot through, clock and all", () => {
    const a = new Anvil();
    const s = record(a);
    a.mine(5);
    expect(guardedRevert(a, s)).toBe("full");
    expect(a.state).toBe(0);
  });

  it("Save, then the demo's Start over, then Back to save: refused, nothing sent, the chain whole", () => {
    const a = new Anvil();
    const base = record(a);
    a.mine(3);
    const demo = record(a); // the demo, just before step 1
    a.mine(5);
    const save = record(a); // the Dock's Save
    expect(guardedRevert(a, demo)).toBe("full"); // Start over
    expect(guardedRevert(a, save)).toBe("refused");
    expect(a.wedged).toBe(false);
    expect(guardedRevert(a, base)).toBe("full"); // and Reset still works
  });

  it("a stale point at the same block as the one gone back to: the count below it shows it", () => {
    const a = new Anvil();
    const s1 = record(a);
    const s2 = record(a); // no block between them
    expect(guardedRevert(a, s1)).toBe("full");
    a.mine(3);
    // s2's block is still on the chain, so its hash alone would pass
    expect(a.hashAt(s2.block.number)).toBe(s2.block.hash);
    expect(guardedRevert(a, s2)).toBe("refused");
    expect(a.state).toBe(3);
  });

  it("two tabs: one goes back and takes the point again; the other's old copy is refused, and the new one works", () => {
    const a = new Anvil();
    a.mine();
    const p = record(a);
    a.mine(2);
    expect(guardedRevert(a, p)).toBe("full"); // tab A
    const p2 = record(a);
    a.mine();
    expect(guardedRevert(a, p)).toBe("refused"); // tab B, still holding p
    expect(guardedRevert(a, p2)).toBe("full"); // tab A's p2 was not dropped
  });

  it("Reset in another tab, then an old point: refused (the baseline it counted is off the list)", () => {
    const a = new Anvil();
    const base = record(a);
    a.mine(2);
    const s = record(a);
    a.mine();
    expect(a.revert(base.id)).toBe("full"); // the reset route, server-side
    const fresh = record(a);
    a.mine(4);
    expect(guardedRevert(a, s)).toBe("refused");
    expect(guardedRevert(a, fresh)).toBe("full");
  });

  it("nested sandboxes go back in turn", () => {
    const a = new Anvil();
    const outer = record(a);
    a.mine(2);
    const inner = record(a);
    a.mine(3);
    expect(guardedRevert(a, inner)).toBe("full");
    expect(a.state).toBe(2);
    expect(guardedRevert(a, outer)).toBe("full");
    expect(a.state).toBe(0);
  });

  it("the same revert sent twice (a retried request) is refused the second time, so nothing later is dropped", () => {
    const a = new Anvil();
    const s = record(a);
    a.mine();
    expect(guardedRevert(a, s)).toBe("full");
    const next = record(a);
    expect(guardedRevert(a, s)).toBe("refused");
    expect(a.saved.has(BigInt(next.id))).toBe(true);
  });

  it("a restarted chain gives out the same ids: refused as another chain's", () => {
    const old = new Anvil(1);
    old.snapshot();
    const s = record(old);
    const fresh = new Anvil(2);
    fresh.snapshot();
    fresh.snapshot(); // the same id as s, a different snapshot
    const now = fresh.metadata();
    expect(judge(s.id, s, now, fresh.hashAt(s.block.number))).toEqual({ ok: false, why: "restarted" });
  });

  it("names what it cannot see: a tool outside the app reverting to an id already used", () => {
    const a = new Anvil();
    const u = a.snapshot();
    a.revert(u);
    const s = record(a);
    a.mine();
    a.revert(u); // nothing visible on the list, yet s is gone
    const now = a.metadata();
    expect(judge(s.id, s, now, a.hashAt(s.block.number)).ok).toBe(true);
    // the Playground's proxy refuses such a revert before Anvil sees it; a local chain has no proxy
  });

  it("without a record, only what the list shows: listed, at a block still on the chain", () => {
    const a = new Anvil();
    a.mine();
    const id = a.snapshot();
    a.mine(2);
    const now = a.metadata();
    const at = now.listed.get(BigInt(id))!;
    expect(judge(id, null, now, a.hashAt(at.number)).ok).toBe(true);
    expect(judge(id, null, now, H(999)).ok).toBe(false);
    expect(judge("0x99", null, now, null).ok).toBe(false);
  });
});

describe("stillListed: what the list alone says, at a reload", () => {
  it("keeps a point the chain still holds, and drops one a revert went past or another chain's", () => {
    const a = new Anvil();
    const s1 = record(a);
    a.mine();
    const s2 = record(a);
    expect(stillListed(s2, a.metadata())).toEqual({ ok: true });
    a.revert(s1.id);
    expect(stillListed(s2, a.metadata())).toEqual({ ok: false, why: "gone" });
    expect(stillListed(s2, new Anvil(9).metadata())).toEqual({ ok: false, why: "restarted" });
  });
});

describe("acceptRecord: what vouches for a new snapshot", () => {
  const chain = () => {
    const a = new Anvil();
    a.snapshot();
    a.mine();
    return a;
  };
  it("records its block and how many were listed below it", () => {
    const a = chain();
    const pre = a.metadata();
    const id = a.snapshot();
    expect(acceptRecord(pre, id, a.metadata())).toEqual({ id, instance: a.instance, block: a.head, below: 1 });
  });
  it("refuses one it cannot vouch for: reads out of order, a block mined across it, a snapshot taken back meanwhile", () => {
    const a = chain();
    const id = a.snapshot();
    expect(acceptRecord(a.metadata(), id, a.metadata())).toBeNull(); // "before" already lists it
    const b = chain();
    const pre = b.metadata();
    const s = b.snapshot();
    b.mine();
    expect(acceptRecord(pre, s, b.metadata())).toBeNull();
    const c = chain();
    const pre2 = c.metadata();
    const s2 = c.snapshot();
    c.list.delete(0n); // another tab went back to the first one
    expect(acceptRecord(pre2, s2, c.metadata())).toBeNull();
    const d = chain();
    const pre3 = d.metadata();
    const s3 = d.snapshot();
    expect(acceptRecord(pre3, s3, { ...d.metadata(), instance: H(7) })).toBeNull();
  });
});

describe("afterRevert and listedBelow", () => {
  it("drops the points at and above the id gone back to, whatever Anvil answered", () => {
    const pts = ["0x1", "0x3", "0x4", "0x9"].map((id) => ({ id: id as Hex }));
    expect(afterRevert(pts, "0x4").map((p) => p.id)).toEqual(["0x1", "0x3"]);
    expect(afterRevert(pts, "0x0")).toEqual([]);
    expect(afterRevert(pts, "nope" as Hex)).toEqual(pts);
  });
  it("counts the ids listed below one", () => {
    const listed = new Map<bigint, BlockRef>([[0n, { number: 1, hash: H(1) }], [2n, { number: 1, hash: H(1) }], [5n, { number: 1, hash: H(1) }]]);
    expect(listedBelow(listed, 5n)).toBe(2);
    expect(listedBelow(listed, 0n)).toBe(0);
  });
});

describe("sanitizeStored", () => {
  const point = { id: "0x3", instance: REAL.instanceId, block: { number: 140, hash: REAL.latestBlockHash }, below: 2, at: 1_800_000_000 };
  it("keeps what still looks like save points, oldest first", () => {
    const s = sanitizeStored({ instance: REAL.instanceId, points: [{ ...point, id: "0x9" }, point] })!;
    expect(s.points.map((p) => p.id)).toEqual(["0x3", "0x9"]);
  });
  it("drops what does not, and a record that is not one at all", () => {
    expect(sanitizeStored(null)).toBeNull();
    expect(sanitizeStored({ instance: "0x1", points: [] })).toBeNull();
    expect(sanitizeStored({ instance: REAL.instanceId, points: "x" })).toBeNull();
    const s = sanitizeStored({
      instance: REAL.instanceId,
      points: [point, { ...point, id: "nope" }, { ...point, instance: H(5) }, { ...point, below: -1 }, { ...point, at: "now" }, { ...point, block: { number: 1 } }, 7],
    })!;
    expect(s.points).toHaveLength(1);
  });
});

describe("sendBatch", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("sends one batch and answers in the order asked, whatever order the chain answered in", async () => {
    const seen: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        seen.push(JSON.parse(init.body));
        return new Response(JSON.stringify([{ jsonrpc: "2.0", id: 2, result: "0x5" }, { jsonrpc: "2.0", id: 1, result: "a" }]), { status: 200 });
      }),
    );
    const out = await sendBatch("http://x", [{ method: "anvil_metadata", params: [] }, { method: "evm_snapshot", params: [] }, { method: "anvil_metadata", params: [] }]);
    expect(out[0].result).toBe("a");
    expect(out[1].result).toBe("0x5");
    expect(out[2].error?.code).toBe(-32603);
    expect((seen[0] as { method: string }[]).map((c) => c.method)).toEqual(["anvil_metadata", "evm_snapshot", "anvil_metadata"]);
  });
  it("says what the backend said when it refuses the request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "This Playground chain has stopped. Open a new one." }), { status: 410 })));
    await expect(sendBatch("http://x", [{ method: "anvil_metadata", params: [] }])).rejects.toThrow(/has stopped.*410/);
  });
});

describe("withChainLock", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("runs under the browser's lock for that chain, and without one where there is none", async () => {
    const names: string[] = [];
    vi.stubGlobal("navigator", { locks: { request: async (name: string, cb: () => Promise<unknown>) => (names.push(name), cb()) } });
    await expect(withChainLock("http://127.0.0.1:8545", async () => 7)).resolves.toBe(7);
    expect(names).toEqual(["covenant.snapshots http://127.0.0.1:8545"]);
    vi.stubGlobal("navigator", {});
    await expect(withChainLock("http://127.0.0.1:8545", async () => 8)).resolves.toBe(8);
  });
});
