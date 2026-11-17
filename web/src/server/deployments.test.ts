import { afterEach, describe, expect, it, vi } from "vitest";
import { servedNetworks } from "./deployments";

describe("servedNetworks", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("offers every network the app knows when COVENANT_NETWORKS is unset or empty", () => {
    vi.stubEnv("COVENANT_NETWORKS", "");
    expect(servedNetworks()).toEqual(["local", "base-sepolia", "base-sepolia-fork"]);
  });

  it("offers only the listed networks, in the app's order, ignoring names it does not know", () => {
    vi.stubEnv("COVENANT_NETWORKS", "base-sepolia");
    expect(servedNetworks()).toEqual(["base-sepolia"]);
    vi.stubEnv("COVENANT_NETWORKS", " base-sepolia-fork , mainnet,local");
    expect(servedNetworks()).toEqual(["local", "base-sepolia-fork"]);
  });
});
