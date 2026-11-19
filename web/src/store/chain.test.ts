import { afterEach, describe, expect, it, vi } from "vitest";
import type { NetworkKey } from "@/chain/network";
import { isHostedCopy, offeredDevNetwork, useChain } from "./chain";

const list = (...n: [NetworkKey, "ready" | "offline"][]) => ({ networks: n.map(([key, state]) => ({ key, name: key, state })) });

describe("offeredDevNetwork: where the guided demo and the attack lab can run for real", () => {
  it("prefers a dev chain that is up: the local one, else the Playground", () => {
    expect(offeredDevNetwork(list(["local", "ready"], ["playground", "ready"]))).toBe("local");
    expect(offeredDevNetwork(list(["local", "offline"], ["base-sepolia", "ready"], ["playground", "ready"]))).toBe("playground");
  });
  it("points at an offline local chain only when nothing is up, and at nothing on a copy that offers neither", () => {
    expect(offeredDevNetwork(list(["local", "offline"], ["base-sepolia", "ready"]))).toBe("local");
    expect(offeredDevNetwork(list(["base-sepolia", "ready"], ["playground", "offline"]))).toBeNull();
  });
});

describe("isHostedCopy: whether a visitor may be shown deploy commands", () => {
  it("follows the server's list when there is one", () => {
    expect(isHostedCopy([{ key: "base-sepolia" }, { key: "playground" }], "localhost")).toBe(true);
    expect(isHostedCopy([{ key: "local" }, { key: "base-sepolia" }], "covenant-uhi11.vercel.app")).toBe(false);
  });
  it("falls back to the page's address when the list could not be fetched", () => {
    expect(isHostedCopy([], "covenant-uhi11.vercel.app")).toBe(true);
    for (const local of ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]) expect(isHostedCopy([], local)).toBe(false);
    expect(isHostedCopy([], null)).toBe(false);
  });
});

describe("loadNetworks, when the app server does not answer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it("keeps the list it had instead of emptying it", async () => {
    const before = [{ key: "base-sepolia" as NetworkKey, name: "Base Sepolia", state: "ready" as const }];
    useChain.setState({ networks: before });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await useChain.getState().loadNetworks();
    expect(useChain.getState().networks).toEqual(before);
  });
  it("tries again shortly while it has no list", async () => {
    vi.useFakeTimers();
    useChain.setState({ networks: [] });
    const list = [{ key: "base-sepolia", name: "Base Sepolia", state: "ready" }];
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue({ ok: true, json: async () => list });
    vi.stubGlobal("fetch", fetch);
    await useChain.getState().loadNetworks();
    expect(useChain.getState().networks).toEqual([]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(useChain.getState().networks).toEqual(list);
  });
});
