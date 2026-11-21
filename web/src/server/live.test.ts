import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const RECORDS = join(process.cwd(), "..", "deployments");
const read = (f: string) => {
  try {
    return readFileSync(join(RECORDS, f), "utf8").toLowerCase();
  } catch {
    return "";
  }
};
const onRecord = ["84532.json", "84532.runtime.json", "84532.proof.json", "84532-lp.proof.json", "84532-manage.proof.json", "84532-refusals.proof.json", "84532-lifecycle.proof.json"].map(read).join("\n");

afterEach(() => {
  delete process.env.COVENANT_DEPLOYMENTS_DIR;
  vi.resetModules();
});

describe("liveDeployment", () => {
  it("shows only addresses and transactions that are on record for Base Sepolia", async () => {
    const { liveDeployment } = await import("./live");
    const live = await liveDeployment();
    expect(live).not.toBeNull();
    if (!live) return;
    expect(live.chainId).toBe(84532);
    expect(live.explorer).toBe("https://sepolia.basescan.org");
    expect(live.contracts.length).toBeGreaterThanOrEqual(8);
    for (const c of live.contracts) expect(onRecord, c.label).toContain(c.address.toLowerCase());
    for (const s of live.steps) expect(onRecord, s.key).toContain(s.hash.toLowerCase());
    // every finished proof, the covenant's first, each against one of the chain's own launches
    expect(live.stories[0]?.key).toBe("covenant");
    for (const story of live.stories) {
      expect(onRecord, story.key).toContain(story.vault.toLowerCase());
      for (const s of story.steps) expect(onRecord, `${story.key}.${s.key}`).toContain(s.hash.toLowerCase());
    }
    if (read("84532-lp.proof.json")) expect(live.stories.find((s) => s.key === "lp")?.steps.map((s) => s.key)).toEqual(["join", "buy", "sell", "collect", "claim", "leave"]);
    expect(live.steps.map((s) => s.key)).toEqual(["rug", "deepen", "crash", "restore", "fees", "refill"]);
    const rug = live.steps[0];
    expect(rug.status).toBe("reverted");
    expect(rug.error).toMatch(/^SupportBroken\(/);
    expect(live.steps.slice(1).every((s) => s.status === "success")).toBe(true);
    // the first import of ./live pulls in viem and the ABIs: seconds on a loaded machine
  }, 30_000);

  it("dates every step and takes the ticker and the attacks from the ledger's own transactions", async () => {
    const { liveDeployment } = await import("./live");
    const { ATTACKS } = await import("@/chain/scenarios/attacks");
    const live = await liveDeployment();
    const ledger = JSON.parse(readFileSync(join(RECORDS, "84532.ledger.json"), "utf8")) as { generatedAt: string; generatedAtBlock: number; txs: { hash: string; status: string; error?: string; time: string }[] };
    expect(live).not.toBeNull();
    if (!live) return;
    const byHash = new Map(ledger.txs.map((t) => [t.hash.toLowerCase(), t]));
    // every proof step the landing tells is a ledger transaction, dated with the time the ledger read back
    for (const story of live.stories) for (const s of story.steps) expect(s.time, `${story.key}.${s.key}`).toBe(byHash.get(s.hash.toLowerCase())?.time);
    expect(live.asOf).toEqual({ time: ledger.generatedAt, block: ledger.generatedAtBlock });
    // the ticker: exactly the refused transactions on record, each with its decoded error
    const refused = ledger.txs.filter((t) => t.status === "reverted" && t.error);
    expect(live.refusals.map((r) => r.hash)).toEqual(refused.map((t) => t.hash));
    for (const r of live.refusals) expect(r.error).toBe(byHash.get(r.hash.toLowerCase())?.error);
    // "N of 20 attacks played for real": every attack card has transactions on chain, each one on record
    for (const a of ATTACKS) {
      expect(live.attacks[a.id]?.length ?? 0, a.id).toBeGreaterThan(0);
      for (const t of live.attacks[a.id]) expect(byHash.has(t.hash.toLowerCase()), `${a.id} ${t.hash}`).toBe(true);
    }
    // no network in the tests: the page makes no Sourcify claim
    expect(live.sourcify).toBeNull();
  }, 30_000);

  it("claims Sourcify verification only for the contracts Sourcify matches, and makes no claim when it does not answer", async () => {
    const { checkSourcify } = await import("./live");
    const core = [
      { label: "Covenant hook", address: "0x1ae2FdAED268851B72268E9369651e901ee4B040" as const },
      { label: "Lens", address: "0x2f572fab2f0802B4Ef6Ce325EEf7a4B494d754Da" as const },
    ];
    const answer = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", (url: string) => (url.endsWith(core[0].address) ? answer(200, { match: "match", runtimeMatch: "match" }) : answer(404, { error: "not found" })));
    const some = await checkSourcify(84532, core);
    expect(some?.verified.map((c) => c.label)).toEqual(["Covenant hook"]);
    expect(some?.of).toBe(2);
    vi.stubGlobal("fetch", () => answer(503, { error: "busy" }));
    expect(await checkSourcify(84532, core)).toBeNull();
    vi.unstubAllGlobals();
  });

  it("is null when nothing is on record, so the landing keeps its local-chain wording", async () => {
    process.env.COVENANT_DEPLOYMENTS_DIR = mkdtempSync(join(tmpdir(), "covenant-empty-"));
    vi.resetModules();
    const { liveDeployment } = await import("./live");
    expect(await liveDeployment()).toBeNull();
  });
});
