import { describe, expect, it } from "vitest";
import { milestones } from "./milestones";

const view = (time: number, pendingCurator: `0x${string}` | null = null) => ({
  time,
  pace: { setup: true, setupEndsAt: 1_000, available: 1, cap: 0.5 },
  lock: { adoptedAt: 0, unlockStartsAt: 90_000, fullyVestedAt: 120_000, vested: 0, withdrawable: 0 },
  people: { issuer: "0x1", pendingIssuer: null, curator: "0x2", pendingCurator, curatorReadyAt: 5_000, treasury: "0x3" },
}) as never;

describe("milestones", () => {
  it("lists what is still ahead of the chain's clock, soonest first", () => {
    expect(milestones(view(500)).map((m) => m.key)).toEqual(["setup", "unlock", "vested"]);
    expect(milestones(view(2_000)).map((m) => m.key)).toEqual(["unlock", "vested"]);
  });
  it("includes a proposed curator's timelock while one is pending", () => {
    expect(milestones(view(500, "0x00000000000000000000000000000000000000c0")).map((m) => m.key)).toEqual(["setup", "curator", "unlock", "vested"]);
  });
  it("is empty once everything has happened", () => {
    expect(milestones(view(200_000))).toEqual([]);
  });
});
