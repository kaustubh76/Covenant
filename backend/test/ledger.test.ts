// The live ledger feed, with a stand-in for Blockscout: nothing here touches a network.

import { describe, expect, it } from "vitest";
import { LedgerFeed } from "../src/ledger";

const RELAYER = "0x00000000000000000000000000000000000000a1";
const VAULT = "0x00000000000000000000000000000000000000b1";
const tx = (hash: string, block: number, from: string, to: string, status: "ok" | "error", method = "poke", revert?: string) => ({
  hash,
  block_number: block,
  timestamp: "2026-11-19T00:00:00Z",
  from: { hash: from },
  to: { hash: to },
  status,
  method,
  revert_reason: revert ? { method_call: `${revert}(uint256 a)` } : null,
});

function blockscout(pages: Record<string, unknown[]>) {
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(url);
    const key = Object.keys(pages).find((k) => url.includes(k));
    if (!key) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify({ items: pages[key] }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("the ledger feed", () => {
  it("merges the relayer's and the vaults' transactions, newest first, without duplicates", async () => {
    const b = blockscout({
      [`${RELAYER}/transactions?filter=from`]: [tx("0x01", 10, RELAYER, VAULT, "ok"), tx("0x02", 12, RELAYER, "0x00000000000000000000000000000000000000c1", "ok", "transfer")],
      [`${VAULT}/transactions?filter=to`]: [tx("0x01", 10, RELAYER, VAULT, "ok"), tx("0x03", 11, "0x00000000000000000000000000000000000000d1", VAULT, "error", "restore", "NothingToRestore")],
    });
    const feed = new LedgerFeed({ relayer: RELAYER, vaults: [{ vault: VAULT, symbol: "CVNT" }], fetch: b.fetch });
    const { txs } = await feed.latest();
    expect(txs.map((t) => t.hash)).toEqual(["0x02", "0x03", "0x01"]);
    expect(txs.find((t) => t.hash === "0x01")).toMatchObject({ relayed: true, vault: VAULT, symbol: "CVNT", status: "success" });
    expect(txs.find((t) => t.hash === "0x03")).toMatchObject({ relayed: false, status: "reverted", error: "NothingToRestore" });
  });

  it("caches for everyone, and keeps the last good answer when the explorer stops answering", async () => {
    let t = 0;
    let up = true;
    const good = blockscout({ [`${VAULT}/transactions?filter=to`]: [tx("0x01", 10, RELAYER, VAULT, "ok")] });
    const fetch = (async (url: string, init?: RequestInit) => (up ? good.fetch(url, init) : new Response("", { status: 503 }))) as typeof globalThis.fetch;
    const feed = new LedgerFeed({ relayer: null, vaults: [{ vault: VAULT, symbol: "CVNT" }], fetch, now: () => t });
    await feed.latest();
    await feed.latest();
    expect(good.calls).toHaveLength(1);
    t = 60_000;
    up = false;
    await expect(feed.latest()).resolves.toMatchObject({ txs: [{ hash: "0x01" }] });
  });

  it("fails when the explorer has never answered", async () => {
    const feed = new LedgerFeed({ relayer: null, vaults: [{ vault: VAULT, symbol: "CVNT" }], fetch: blockscout({}).fetch });
    await expect(feed.latest()).rejects.toThrow(/500/);
  });
});
