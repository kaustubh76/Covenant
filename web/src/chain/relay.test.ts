import { type Abi, encodeErrorResult } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorAbi } from "./abi.generated";
import { relay, relayOff, relayRefusal, relayStatus, sentNote } from "./relay";

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
    // asleep or unreachable is "not yet", which the app retries; an answer saying off is "off"
    await expect(relayStatus("https://backend.example")).resolves.toBeNull();
    vi.stubGlobal("fetch", answer(200, { enabled: false, reason: "RELAYER_PRIVATE_KEY is not set." }));
    await expect(relayStatus("https://backend.example")).resolves.toEqual({ enabled: false, reason: "RELAYER_PRIVATE_KEY is not set." });
  });

  it("keeps every hash of a multi-step action, the approval's too", async () => {
    const a = `0x${"aa".repeat(32)}`;
    const b = `0x${"bb".repeat(32)}`;
    vi.stubGlobal("fetch", answer(200, { hash: b, hashes: [a, b], status: "success", title: "Approve, then sell" }));
    await expect(relay("https://backend.example", "sell")).resolves.toMatchObject({ ok: true, hash: b, hashes: [a, b] });
  });

  it("decodes the refusal the relayer found into the app's own sentence, from the revert data it sends", async () => {
    const data = encodeErrorResult({ abi: errorAbi as unknown as Abi, errorName: "NothingToRestore", args: [9999n, 4000n] });
    vi.stubGlobal("fetch", answer(409, { error: "Restore support, for the bounty would revert: NothingToRestore(9999, 4000). Nothing was sent.", revert: { name: "NothingToRestore", data } }));
    const r = await relay("https://backend.example", "restore", { indices: [0] });
    expect(r).toMatchObject({ ok: false, status: 409, revert: "NothingToRestore(9999, 4000)", revertData: data });
    if (r.ok) throw new Error("expected a refusal");
    const d = relayRefusal(r);
    expect(d).toMatchObject({ name: "NothingToRestore", signature: "NothingToRestore(9999, 4000)" });
    // the app's sentence, not the generic one for an error it does not know
    expect(d?.reason).not.toBe("The call reverted.");
    expect(d?.rule).not.toBe("Other");
    expect(sentNote(r.reason)).toBe("Nothing was sent.");
  });

  it("falls back to the name when there is no revert data, or data it cannot read", async () => {
    vi.stubGlobal("fetch", answer(409, { error: "Sell 1 CVNT would revert: Unknown. Already sent: 0xaa. ", revert: { data: "0xdeadbeef" } }));
    const r = await relay("https://backend.example", "sell");
    if (r.ok) throw new Error("expected a refusal");
    expect(relayRefusal(r)).toBeNull();
    expect(sentNote(r.reason)).toBe("Already sent: 0xaa.");
    vi.stubGlobal("fetch", answer(409, { error: "would revert: X()", revert: { data: "not hex" } }));
    const q = await relay("https://backend.example", "poke");
    expect(q).toMatchObject({ ok: false, revertData: undefined });
  });

  it("says why the relayer cannot send: off, or out of today's budget", () => {
    expect(relayOff(undefined)).toBeNull();
    expect(relayOff({ enabled: true, spentTodayEth: 0.001, dailyBudgetEth: 0.02 })).toBeNull();
    expect(relayOff({ enabled: true, spentTodayEth: 0.02, dailyBudgetEth: 0.02 })).toMatch(/spent today's budget of 0.02 ETH/);
    expect(relayOff({ enabled: false, reason: "RELAYER_PRIVATE_KEY is not set." })).toBe("RELAYER_PRIVATE_KEY is not set.");
    expect(relayOff({ enabled: false })).toMatch(/off/);
  });
});
