import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { networkOf, parseManifest } from "./network";
import { openPlayground, resetPlayground } from "./playground";

const records = (f: string) => JSON.parse(readFileSync(new URL(`../../../deployments/${f}`, import.meta.url), "utf8"));
const manifest = parseManifest(records("playground.json"));
const runtime = records("playground.runtime.json");
const net = { ...networkOf("playground", "https://backend.example/rpc/play/", manifest, runtime), backend: "https://backend.example" };
const ID = "ab".repeat(16);
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the Playground client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the records the backend seeded this chain from, not the app's own copy", async () => {
    const theirs = { ...manifest, lens: "0x000000000000000000000000000000000000beef" };
    vi.stubGlobal("fetch", vi.fn(async () => reply({ id: ID, resumed: false, expired: false, chainId: 31337, rpcPath: `/rpc/play/${ID}`, idleMs: 600_000, manifest: theirs, runtime: { ...runtime, defaultVault: "0x00000000000000000000000000000000000000aa", rpcUrl: "", baselineSnapshot: "0x7" } })));
    const o = await openPlayground(net, () => {}, () => false);
    if (!o.ok) throw new Error(o.reason);
    expect(o.net.rpcUrl).toBe(`https://backend.example/rpc/play/${ID}`);
    expect(o.net.manifest.lens).toBe("0x000000000000000000000000000000000000beef");
    expect(o.net.runtime).toMatchObject({ defaultVault: "0x00000000000000000000000000000000000000aa", baselineSnapshot: "0x7" });
  });

  it("keeps the app's records when the backend's do not parse, and still takes the new baseline", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ id: ID, resumed: true, expired: false, chainId: 31337, rpcPath: `/rpc/play/${ID}`, idleMs: 600_000, manifest: { nope: 1 }, runtime: { baselineSnapshot: "0x9" } })));
    const o = await openPlayground(net, () => {}, () => false);
    if (!o.ok) throw new Error(o.reason);
    expect(o.net.manifest).toEqual(manifest);
    expect(o.net.runtime).toMatchObject({ defaultVault: runtime.defaultVault, baselineSnapshot: "0x9" });
  });

  it("resets the chain it opened even where the browser keeps no storage", async () => {
    // node has no localStorage at all: the id opened above lives on in memory
    const f = vi.fn(async (url: string) => (String(url).endsWith("/reset") ? reply({ ok: true, baselineSnapshot: "0xa" }) : reply({ id: ID, resumed: false, expired: false, chainId: 31337, rpcPath: `/rpc/play/${ID}`, idleMs: 600_000, runtime: {} })));
    vi.stubGlobal("fetch", f);
    await openPlayground(net, () => {}, () => false);
    await expect(resetPlayground(net)).resolves.toBe("0xa");
    expect(String(f.mock.calls.at(-1)?.[0])).toBe(`https://backend.example/v1/playground/sessions/${ID}/reset`);
  });
});
