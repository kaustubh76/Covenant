import { afterEach, describe, expect, it } from "vitest";
import { type Address, zeroAddress } from "viem";
import type { ChainCtx } from "./client";
import { UnsupportedQuote, readVaultView, symbolOf, vestedFraction } from "./view";

const TOKEN = "0x0b689019f31bb5927b8daf80f47577aaf2be0f34" as Address;
const VAULT = "0x2d887961773d3793cF5950f6a9Bec4F4BF79582d" as Address;

/** A public-chain context whose reads answer from `answer(functionName)`, counting each read. */
function publicCtx(answer: (fn: string, args: readonly unknown[]) => unknown, calls: string[] = []) {
  return {
    net: { key: "base-sepolia", chainId: 84532, caps: { devChain: false }, manifest: { lens: "0x2f572fab2f0802B4Ef6Ce325EEf7a4B494d754Da", poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408" } },
    signer: null,
    pub: {
      getBlock: async () => ({ number: 100n, timestamp: 1_800_000_000n }),
      readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        calls.push(functionName);
        const out = answer(functionName, args ?? []);
        if (out instanceof Error) throw out;
        return out;
      },
    },
  } as unknown as ChainCtx;
}

describe("symbolOf: the token's name, or nothing made up", () => {
  afterEach(() => undefined);
  it("gives null, not a stand-in name, when symbol() cannot be read, and reads it again next time", async () => {
    let fail = true;
    const calls: string[] = [];
    const ctx = publicCtx(() => (fail ? new Error("no answer") : "CVQ"), calls);
    const token = "0x00000000000000000000000000000000000000c1" as Address;
    expect(await symbolOf(ctx, token)).toBeNull();
    fail = false;
    expect(await symbolOf(ctx, token)).toBe("CVQ");
    // once read, it is kept: no third read
    expect(await symbolOf(ctx, token)).toBe("CVQ");
    expect(calls).toHaveLength(2);
  });
});

describe("readVaultView: only what it can label truthfully", () => {
  it("refuses a vault quoted in a token, rather than show its amounts as ETH", async () => {
    const ctx = publicCtx((fn) =>
      fn === "snapshot" ? { quoteIsCurrency0: true, key: { currency0: TOKEN, currency1: "0x00000000000000000000000000000000000000d2", fee: 3000, tickSpacing: 60, hooks: zeroAddress } } : new Error(`unexpected ${fn}`),
    );
    const e = await readVaultView(ctx, VAULT).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UnsupportedQuote);
    expect((e as Error).message).toMatch(/not ETH/);
  });
});

describe("vestedFraction: as the contract counts vested principal", () => {
  it("is nothing before the lock ends, everything after the vest, and rounds down in between", () => {
    expect(vestedFraction(false, 500, 100, 1100)).toBe(0);
    expect(vestedFraction(true, 99, 100, 1100)).toBe(0);
    expect(vestedFraction(true, 1100, 100, 1100)).toBe(1);
    expect(vestedFraction(true, 5000, 100, 1100)).toBe(1);
    expect(vestedFraction(true, 600, 100, 1100)).toBe(0.5);
    // 1/3 of the way: the contract keeps whole shares (1e18 · 1 / 3, rounded down), never a rounded-up third
    expect(vestedFraction(true, 101, 100, 103)).toBeLessThanOrEqual(1 / 3);
    // a zero-length vest releases everything the moment the lock ends
    expect(vestedFraction(true, 100, 100, 100)).toBe(1);
  });
});
