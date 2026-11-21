import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addressOf } from "@/chain/accounts";
import type { Network, NetworkKey } from "@/chain/network";
import type { Beat } from "@/chain/beat";
import type { ChainCtx } from "@/chain/client";
import { FakeAnvil } from "@/chain/fakeanvil.testkit";
import { revertTo, setSnapshotSender, snapshot } from "@/chain/time";
import { canSendAs, feed, isHostedCopy, offeredDevNetwork, restoreSavePoints, useChain } from "./chain";

const list = (...n: [NetworkKey, "ready" | "offline"][]) => ({ networks: n.map(([key, state]) => ({ key, name: key, state })) });

describe("offeredDevNetwork: where the guided demo and the attack lab can run for real", () => {
  it("prefers a dev chain that is up: the local one, else the Playground", () => {
    expect(offeredDevNetwork(list(["local", "ready"], ["playground", "ready"]))).toBe("local");
    expect(offeredDevNetwork(list(["local", "offline"], ["base-sepolia", "ready"], ["playground", "ready"]))).toBe("playground");
  });
  it("points at an offline local chain only when nothing is up, and at nothing on a copy that offers neither", () => {
    expect(offeredDevNetwork(list(["local", "offline"], ["base-sepolia", "ready"]))).toBe("local");
    expect(offeredDevNetwork(list(["base-sepolia", "ready"], ["playground", "offline"]))).toBeNull();
  });
});

describe("isHostedCopy: whether a visitor may be shown deploy commands", () => {
  it("follows the server's list when there is one", () => {
    expect(isHostedCopy([{ key: "base-sepolia" }, { key: "playground" }], "localhost")).toBe(true);
    expect(isHostedCopy([{ key: "local" }, { key: "base-sepolia" }], "covenant-uhi11.vercel.app")).toBe(false);
  });
  it("falls back to the page's address when the list could not be fetched", () => {
    expect(isHostedCopy([], "covenant-uhi11.vercel.app")).toBe(true);
    for (const local of ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]) expect(isHostedCopy([], local)).toBe(false);
    expect(isHostedCopy([], null)).toBe(false);
  });
});

describe("loadNetworks, when the app server does not answer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it("keeps the list it had instead of emptying it", async () => {
    const before = [{ key: "base-sepolia" as NetworkKey, name: "Base Sepolia", state: "ready" as const }];
    useChain.setState({ networks: before });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await useChain.getState().loadNetworks();
    expect(useChain.getState().networks).toEqual(before);
  });
  it("tries again shortly while it has no list", async () => {
    vi.useFakeTimers();
    useChain.setState({ networks: [] });
    const list = [{ key: "base-sepolia", name: "Base Sepolia", state: "ready" }];
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue({ ok: true, json: async () => list });
    vi.stubGlobal("fetch", fetch);
    await useChain.getState().loadNetworks();
    expect(useChain.getState().networks).toEqual([]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(useChain.getState().networks).toEqual(list);
  });
});

describe("canSendAs: whether an action can leave this page", () => {
  const dev = { key: "playground", caps: { devChain: true } } as Network;
  const pub = { key: "base-sepolia", caps: { devChain: false } } as Network;
  const stranger = "0x00000000000000000000000000000000000000a1" as const;
  const mine = { id: "w", name: "Wallet", address: "0xf76b92051035021d8EF9562058f3e8085006D8f0" as const, chainId: 84532 };

  it("on a dev chain: every role, and an address only when a dev key signs for it", () => {
    expect(canSendAs("lp", dev, null)).toBe(true);
    expect(canSendAs(addressOf("curator"), dev, null)).toBe(true);
    expect(canSendAs(stranger, dev, null)).toBe(false);
  });

  it("on a public chain: an address only from its own wallet, and nothing without one", () => {
    expect(canSendAs("lp", pub, null)).toBe(false);
    expect(canSendAs("lp", pub, mine)).toBe(true);
    expect(canSendAs(mine.address.toLowerCase() as `0x${string}`, pub, mine)).toBe(true);
    expect(canSendAs(stranger, pub, mine)).toBe(false);
  });
});

describe("feed: what the activity panel lists", () => {
  const A = "0x00000000000000000000000000000000000000aa";
  const B = "0x00000000000000000000000000000000000000bb";
  const HASH = `0x${"12".repeat(32)}` as const;
  const beat = (b: Partial<Beat> & Pick<Beat, "id" | "at">): Beat => ({ actor: "anyone", title: b.id, ok: true, source: "app", ...b });

  it("lists an attempt only on the vault it was made on", () => {
    const log = [beat({ id: "on-a", at: 2, vault: A }), beat({ id: "on-b", at: 1, vault: B }), beat({ id: "anywhere", at: 0 })];
    expect(feed(log, [], 10, B).map((b) => b.id)).toEqual(["on-b", "anywhere"]);
    expect(feed(log, [], 10, null).map((b) => b.id)).toEqual(["on-a", "on-b", "anywhere"]);
  });

  it("replaces a line that gave up on a transaction (still pending) with the chain's event once it lands", () => {
    const pending = beat({ id: "pending", at: 5, ok: false, hash: HASH, vault: A });
    const landed = beat({ id: "chain-1", at: 6, hash: HASH, source: "chain" });
    expect(feed([pending], [landed], 10, A).map((b) => b.id)).toEqual(["chain-1"]);
  });

  it("keeps the app's own line, with its detail, over the chain's event for a send that settled", () => {
    const settled = beat({ id: "settled", at: 5, hash: HASH, detail: "Paid 1 ETH", vault: A });
    const event = beat({ id: "chain-1", at: 5, hash: HASH, source: "chain" });
    expect(feed([settled], [event], 10, A).map((b) => b.id)).toEqual(["settled"]);
  });
});

describe("save points: kept across a reload, per chain, and never sent when gone", () => {
  const KEY = "covenant.savepoints.v1.local";
  let chain: FakeAnvil;
  let store: Map<string, string>;
  const net = { key: "local", name: "Local chain", chainId: 31337, rpcUrl: "http://127.0.0.1:8545", caps: { devChain: true, pollMs: 500, blockTimeMs: 1000 }, runtime: null } as unknown as Network;
  const ctx = { net, test: {}, pub: {} } as unknown as ChainCtx;
  const stored = () => JSON.parse(store.get(KEY) ?? "null") as { instance: string; points: { id: string; at: number }[] } | null;
  const at = (time: number) => useChain.setState({ view: { time } as never });

  beforeEach(() => {
    chain = new FakeAnvil();
    setSnapshotSender(chain.send);
    store = new Map();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    useChain.setState({ net, ctx, netKey: "local", status: "ready", vault: null, view: null, savePoints: [], log: [], toast: null, busy: null });
  });
  afterEach(() => {
    setSnapshotSender(null);
    vi.unstubAllGlobals();
  });

  it("are stored as they are taken, read back after a reload, and the newest is gone back to", async () => {
    at(100);
    await useChain.getState().savePoint();
    chain.mine(4);
    at(200);
    await useChain.getState().savePoint();
    expect(stored()?.instance).toBe(chain.instance);
    expect(stored()?.points.map((p) => p.at)).toEqual([100, 200]);

    // a reload: the page forgets, the browser and the chain do not
    useChain.setState({ savePoints: [] });
    await restoreSavePoints(ctx);
    expect(useChain.getState().savePoints.map((p) => p.at)).toEqual([100, 200]);

    chain.mine(3);
    await useChain.getState().backToSavePoint();
    expect(chain.state).toBe(4);
    expect(useChain.getState().toast?.title).toBe("Back at the save point");
    // taken again (Anvil used it up), at the same clock
    expect(useChain.getState().savePoints.map((p) => p.at)).toEqual([100, 200]);
    expect(stored()?.points).toHaveLength(2);
  });

  it("are dropped when the chain is another one (a restarted local chain, a fresh Playground chain)", async () => {
    await useChain.getState().savePoint();
    expect(stored()?.points).toHaveLength(1);
    const fresh = new FakeAnvil(2);
    fresh.snapshot(); // the same id, on another chain
    setSnapshotSender(fresh.send);
    useChain.setState({ savePoints: [] });
    await restoreSavePoints(ctx);
    expect(useChain.getState().savePoints).toEqual([]);
    expect(stored()).toBeNull();
  });

  it("a revert past one (the guided demo's Start over) drops it at once; Back to save then sends nothing", async () => {
    const demo = await snapshot(ctx);
    chain.mine(8);
    await useChain.getState().savePoint();
    await revertTo(ctx, demo);
    expect(useChain.getState().savePoints).toEqual([]);
    expect(stored()).toBeNull();
  });

  it("one gone from under the page (another tab, a tool): said, nothing sent, and the earlier ones kept", async () => {
    await useChain.getState().savePoint();
    chain.mine(2);
    const between = chain.snapshot(); // another tab's
    chain.mine(2);
    await useChain.getState().savePoint();
    chain.revert(between); // that tab goes back: the newest save point is gone, the first is not
    const from = chain.calls.length;
    await useChain.getState().backToSavePoint();
    expect(chain.calls.slice(from)).not.toContain("evm_revert");
    const toast = useChain.getState().toast;
    expect(toast?.ok).toBe(false);
    expect(toast?.error?.signature).toBe("Save point gone");
    expect(toast?.error?.reason).toMatch(/1 earlier save point is still there/);
    expect(useChain.getState().savePoints).toHaveLength(1);
    expect(stored()?.points).toHaveLength(1);
  });

  it("Reset clears them, and the local chain's new baseline reaches the app (the guided demo keys on it)", async () => {
    useChain.setState({ net: { ...net, runtime: { rpcUrl: net.rpcUrl, defaultVault: "0x00000000000000000000000000000000000000aa", launches: [], seededAt: 0, baselineSnapshot: "0x0" } } as Network });
    await useChain.getState().savePoint();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, baselineSnapshot: "0x9" }))),
    );
    expect(await useChain.getState().reset()).toBe(true);
    expect(stored()).toBeNull();
    expect(useChain.getState().savePoints).toEqual([]);
    expect(useChain.getState().net?.runtime?.baselineSnapshot).toBe("0x9");
  });
});
