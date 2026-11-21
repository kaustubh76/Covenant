import { describe, expect, it } from "vitest";
import { NETWORKS } from "@/chain/network";
import { keepsSent } from "./sentTxs";

describe("keepsSent", () => {
  it("keeps Base Sepolia's sends, and not the rehearsal fork's, which share its chain id, nor a dev chain's", () => {
    expect(keepsSent(NETWORKS["base-sepolia"].caps)).toBe(true);
    expect(NETWORKS["base-sepolia-fork"].chainId).toBe(NETWORKS["base-sepolia"].chainId);
    expect(keepsSent(NETWORKS["base-sepolia-fork"].caps)).toBe(false);
    expect(keepsSent(NETWORKS.local.caps)).toBe(false);
    expect(keepsSent(NETWORKS.playground.caps)).toBe(false);
  });
});
