import { afterEach, describe, expect, it, vi } from "vitest";
import { backendUrl, servedNetworks } from "./deployments";

describe("servedNetworks", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("offers every network the app knows when COVENANT_NETWORKS is unset or empty", () => {
    vi.stubEnv("COVENANT_NETWORKS", "");
    expect(servedNetworks()).toEqual(["local", "base-sepolia", "base-sepolia-fork"]);
  });

  it("adds the Playground to the unlisted default only when a backend is set for it, and honours an explicit list", () => {
    vi.stubEnv("COVENANT_NETWORKS", "");
    vi.stubEnv("COVENANT_BACKEND_URL", "https://covenant-backend.example/");
    expect(servedNetworks()).toEqual(["local", "base-sepolia", "base-sepolia-fork", "playground"]);
    expect(backendUrl()).toBe("https://covenant-backend.example");
    vi.stubEnv("COVENANT_BACKEND_URL", "not a url");
    expect(backendUrl()).toBeNull();
    vi.stubEnv("COVENANT_NETWORKS", "base-sepolia,playground");
    expect(servedNetworks()).toEqual(["base-sepolia", "playground"]);
  });

  it("offers only the listed networks, in the app's order, ignoring names it does not know", () => {
    vi.stubEnv("COVENANT_NETWORKS", "base-sepolia");
    expect(servedNetworks()).toEqual(["base-sepolia"]);
    vi.stubEnv("COVENANT_NETWORKS", " base-sepolia-fork , mainnet,local");
    expect(servedNetworks()).toEqual(["local", "base-sepolia-fork"]);
  });
});
