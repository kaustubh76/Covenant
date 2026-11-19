import { afterEach, describe, expect, it, vi } from "vitest";
import { relay, relayStatus } from "./relay";

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("the relayer client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the hash of a sent action", async () => {
    vi.stubGlobal("fetch", answer(200, { hash: `0x${"ab".repeat(32)}`, status: "success", title: "Sync the Anchor (poke)" }));
    await expect(relay("https://backend.example", "poke")).resolves.toMatchObject({ ok: true, status: "success" });
  });

  it("names the contract's refusal when the relayer's simulation found one", async () => {
    vi.stubGlobal("fetch", answer(409, { error: "Restore support, for the bounty would revert: NothingToRestore(9999, 4000). Nothing was sent." }));
    await expect(relay("https://backend.example", "restore", { indices: [0] })).resolves.toMatchObject({ ok: false, status: 409, revert: "NothingToRestore(9999, 4000)" });
  });

  it("passes limits and budgets through as they are, and a sleeping backend as no answer", async () => {
    vi.stubGlobal("fetch", answer(429, { error: "Test funds go once a day per address. Try again tomorrow." }));
    await expect(relay("https://backend.example", "drip", { to: "0x00000000000000000000000000000000000000b2" })).resolves.toMatchObject({ ok: false, status: 429, revert: undefined });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(relay("https://backend.example", "poke")).resolves.toMatchObject({ ok: false, status: 0 });
    await expect(relayStatus("https://backend.example")).resolves.toEqual({ enabled: false });
  });
});
