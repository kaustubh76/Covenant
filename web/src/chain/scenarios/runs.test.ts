import { describe, expect, it } from "vitest";
import { type AttackRun, eachAttack, scriptFailed } from "./attacks";
import { ATTACKS } from "./attacks";
import { EXPECTED, LIVE_CHECKS, type LiveCheck, NOT_LIVE, judged, runLiveChecks } from "./livechecks";

const ctx = { pub: { getBlock: async () => ({ number: 100n, timestamp: 1_000n }), readContract: async () => 0n } } as never;
const view = { token: "0x0000000000000000000000000000000000000001", people: { issuer: "0x0000000000000000000000000000000000000002" } } as never;
const verdict = (blocked: boolean): AttackRun => ({ blocked, summary: blocked ? "refused" : "taken", beats: [] });
const check = (id: string, run: LiveCheck["run"], expect: string[] = [], skip?: LiveCheck["skip"]): LiveCheck => ({ id, expect, run, skip });
const refusal = (name: string) => ({ actor: "curator", title: "Rug", ok: false, error: { name, args: [], signature: `${name}()`, rule: "Support", reason: "…" } });

describe("the attack lab's runs", () => {
  it("never calls a run the network did not answer a verdict: no answer, a throw and a hang each arrive with the reason", async () => {
    const got: Record<string, AttackRun> = {};
    await runLiveChecks(
      ctx,
      view,
      (id, r) => void (got[id] = r),
      [
        check("answered", async () => verdict(true)),
        check("no-answer", async () => ({
          blocked: true,
          summary: "would be blocked",
          beats: [{ actor: "anyone", title: "Withdraw", ok: false, error: { name: "NoAnswer", args: [], signature: "No answer from the network", rule: "Other", reason: "The network did not answer just now, so nothing was decided. Try again." } }] as never,
        })),
        check("throws", async () => {
          throw new Error("eth_simulateV1 is not supported\nmore detail");
        }),
        check("hangs", () => new Promise(() => {})),
        check("nothing", async () => null),
      ],
      50,
    );
    expect(got.answered).toMatchObject({ blocked: true });
    expect(got.answered.noVerdict).toBeUndefined();
    expect(got["no-answer"]).toMatchObject({ blocked: false, noVerdict: "The network did not answer just now, so nothing was decided. Try again." });
    expect(got.throws.noVerdict).toBe("This check could not run: eth_simulateV1 is not supported");
    expect(got.hangs.noVerdict).toMatch(/did not answer this check within 0 seconds|within/);
    // a scene that could not be set is no verdict, and says so, rather than leave the card blank
    expect(got.nothing.noVerdict).toMatch(/could not be set/);
  });

  it("a contract's refusal is a verdict, even inside a check: only failures of the network or wallet are not", async () => {
    const got: Record<string, AttackRun> = {};
    await runLiveChecks(
      ctx,
      view,
      (id, r) => void (got[id] = r),
      [
        check(
          "refused",
          async () => ({
            blocked: true,
            summary: "refused",
            beats: [{ actor: "curator", title: "Rug", ok: false, error: { name: "SupportBroken", args: [277n, 4000n], signature: "SupportBroken(277, 4000)", rule: "Support", reason: "…" } }] as never,
          }),
          ["SupportBroken"],
        ),
      ],
    );
    expect(got.refused).toMatchObject({ blocked: true });
    expect(got.refused.noVerdict).toBeUndefined();
  });

  it("counts a refusal as blocked only when it is the one the attack tests: another rule saying no is no verdict", async () => {
    const got: Record<string, AttackRun> = {};
    await runLiveChecks(
      ctx,
      view,
      (id, r) => void (got[id] = r),
      [
        // the guard was tripped when the check ran: the soft rug is refused, but not by the support rule
        check("guarded", async () => ({ blocked: true, summary: "Support is checked", beats: [refusal("PriceGuard")] as never }), ["SupportBroken"]),
        // a check that measures an outcome, where a step was refused
        check("measured", async () => ({ blocked: true, summary: "Absorbed", beats: [refusal("PriceGuard")] as never })),
        // one that does not apply to this vault right now
        check("skipped", async () => verdict(true), [], () => "These terms let the whole vault move in one epoch"),
      ],
    );
    expect(got.guarded).toMatchObject({ blocked: false });
    expect(got.guarded.noVerdict).toMatch(/Refused here by PriceGuard, not by what this attack tests \(SupportBroken\)/);
    expect(got.measured.noVerdict).toMatch(/A step was refused \(PriceGuard\)/);
    expect(got.skipped).toMatchObject({ skipped: true, noVerdict: "Not checked on this vault right now: These terms let the whole vault move in one epoch." });
    // the same rule judges a dev-chain run of the scripts
    expect(judged({ expect: ["IdleTooLarge"] }, { blocked: true, summary: "", beats: [refusal("IdleTooLarge")] as never }).noVerdict).toBeUndefined();
  });

  it("names, for every attack, the refusal that means it was stopped, and has a live check for each but the one that needs days", () => {
    for (const a of ATTACKS) expect(EXPECTED[a.id], a.id).toBeDefined();
    const checked = new Set(LIVE_CHECKS.map((c) => c.id));
    expect(ATTACKS.filter((a) => !checked.has(a.id)).map((a) => a.id)).toEqual(Object.keys(NOT_LIVE));
  });

  it("runs each attack in turn and stops between attacks when asked", async () => {
    const order: string[] = [];
    let stopAfter = 2;
    const ran = await eachAttack(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      async (a) => (order.push(a.id), verdict(true)),
      () => stopAfter--,
      () => stopAfter <= 0,
    );
    expect(ran).toBe(2);
    expect(order).toEqual(["a", "b"]);
  });

  it("calls a script that crashed a run with no verdict, never 'got through', and ends the run when the chain was reset under it", () => {
    const r = scriptFailed(new Error("HTTP request failed\nURL: …"));
    expect(r).toMatchObject({ blocked: false, noVerdict: "HTTP request failed" });
    const gone = Object.assign(new Error("That save point is gone: the chain was reset or replaced since it was taken."), { name: "SnapshotGone" });
    expect(() => scriptFailed(gone)).toThrow(/save point is gone/);
  });
});
