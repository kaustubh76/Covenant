import { describe, expect, it } from "vitest";
import type { ChainCtx } from "./client";
import { MAX_MINE, SnapshotGone, TooManyBlocks, mineTo, revertTo } from "./time";

/** A dev chain at block `head` whose Anvil answers evm_revert with `reverts`, and records what it was asked to mine. */
function devChain(head: bigint, reverts: boolean, mined: number[]) {
  const test = {
    mine: async ({ blocks }: { blocks: number }) => void mined.push(blocks),
    request: async ({ method }: { method: string }) => (method === "evm_revert" ? reverts : null),
  };
  return { net: { caps: { devChain: true } }, test, pub: { getBlock: async () => ({ number: head, timestamp: 1_000n }) } } as unknown as ChainCtx;
}

describe("mineTo", () => {
  it("mines up to the block asked for", async () => {
    const mined: number[] = [];
    await mineTo(devChain(100n, true, mined), 300n);
    expect(mined).toEqual([200]);
  });

  it("mines nothing for a block already behind", async () => {
    const mined: number[] = [];
    await mineTo(devChain(100n, true, mined), 50n);
    expect(mined).toEqual([]);
  });

  it("refuses a target past the cap (another chain's block height), and mines nothing", async () => {
    const mined: number[] = [];
    const far = 100n + BigInt(MAX_MINE) + 1n;
    await expect(mineTo(devChain(100n, true, mined), far)).rejects.toBeInstanceOf(TooManyBlocks);
    await expect(mineTo(devChain(100n, true, mined), 61_262_454n)).rejects.toThrow(/Nothing was mined/);
    expect(mined).toEqual([]);
    // the cap itself is fine: a dev launch's auction is about 200 blocks
    await mineTo(devChain(100n, true, mined), 100n + BigInt(MAX_MINE));
    expect(mined).toEqual([MAX_MINE]);
  });
});

describe("revertTo", () => {
  it("returns when Anvil reverted", async () => {
    await expect(revertTo(devChain(1n, true, []), "0x1")).resolves.toBeUndefined();
  });

  it("throws SnapshotGone when Anvil had no such snapshot, rather than report a revert that did not happen", async () => {
    const e = await revertTo(devChain(1n, false, []), "0x7").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SnapshotGone);
    expect((e as SnapshotGone).name).toBe("SnapshotGone");
    expect((e as SnapshotGone).message).toMatch(/reset or replaced/);
  });
});
