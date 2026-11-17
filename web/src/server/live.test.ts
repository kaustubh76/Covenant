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
const onRecord = ["84532.json", "84532.runtime.json", "84532.proof.json", "84532-lp.proof.json", "84532-manage.proof.json"].map(read).join("\n");

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

  it("is null when nothing is on record, so the landing keeps its local-chain wording", async () => {
    process.env.COVENANT_DEPLOYMENTS_DIR = mkdtempSync(join(tmpdir(), "covenant-empty-"));
    vi.resetModules();
    const { liveDeployment } = await import("./live");
    expect(await liveDeployment()).toBeNull();
  });
});
