import { describe, expect, it } from "vitest";
import { NETWORKS, explorerTx, firstChoice, isNetworkKey, networkOf, parseManifest } from "./network";

const manifest = (chainId: number) =>
  parseManifest({
    chainId,
    poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
    positionManager: "0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80",
    lbpStrategy: "0x73ad52384798AdADfBe19fCfD28ff09D2CC82000",
    hook: "0x1ae2FdAED268851B72268E9369651e901ee4B040",
    vaultOps: "0x34A1D3fff3958843C43aD80F30b94c510645C316",
    factory: "0x90193C961A926261B756D1E5bb255e67ff9498A1",
    vaultImplementation: "0xd04404bcf6d969FC0Ec22021b4736510CAcec492",
    seedPlanner: "0xA8452Ec99ce0C64f20701dB7dD3abDb607c00496",
    lens: "0xBb2180ebd78ce97360503434eD37fcf4a1Df61c3",
  });

describe("networks", () => {
  it("treats Base Sepolia and its fork as public chains with a 200-block log cap; only the local chain is a dev chain", () => {
    expect(NETWORKS.local.caps.devChain).toBe(true);
    for (const k of ["base-sepolia", "base-sepolia-fork"] as const) {
      expect(NETWORKS[k].chainId).toBe(84532);
      expect(NETWORKS[k].caps.devChain).toBe(false);
      expect(NETWORKS[k].caps.logRange).toBe(200);
    }
    // the fork keeps its own records, so a rehearsal never overwrites the real chain's
    expect(NETWORKS["base-sepolia-fork"].records).not.toBe(NETWORKS["base-sepolia"].records);
  });

  it("refuses records made for another chain", () => {
    expect(() => networkOf("base-sepolia", "https://sepolia.base.org", manifest(31337), null)).toThrow(/chain 31337/);
    expect(networkOf("base-sepolia", "https://sepolia.base.org", manifest(84532), null).name).toBe("Base Sepolia");
  });

  it("links to the explorer only where there is one", () => {
    const hash = "0x96e35d784c368d12f64ec90c6814223c094d06b721b62f52e791e48182e448e5";
    expect(explorerTx(NETWORKS["base-sepolia"], hash)).toBe(`https://sepolia.basescan.org/tx/${hash}`);
    expect(explorerTx(NETWORKS["base-sepolia-fork"], hash)).toBeUndefined();
    expect(isNetworkKey("base-sepolia")).toBe(true);
    expect(isNetworkKey("mainnet")).toBe(false);
  });
});

describe("firstChoice", () => {
  it("opens the live Base Sepolia deployment when it answers, even with the local chain up", () => {
    expect(firstChoice([{ key: "local", state: "ready" }, { key: "base-sepolia", state: "ready" }, { key: "base-sepolia-fork", state: "offline" }])).toBe("base-sepolia");
  });

  it("falls back to the first network that is up, then to the local chain", () => {
    expect(firstChoice([{ key: "local", state: "ready" }, { key: "base-sepolia", state: "offline" }])).toBe("local");
    expect(firstChoice([{ key: "local", state: "offline" }, { key: "base-sepolia-fork", state: "ready" }])).toBe("base-sepolia-fork");
    expect(firstChoice([{ key: "local", state: "offline" }, { key: "base-sepolia", state: "offline" }])).toBe("local");
    expect(firstChoice([])).toBe("local");
  });
});
