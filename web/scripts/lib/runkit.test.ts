import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseError, type Hex, encodeErrorResult } from "viem";
import { describe, expect, it } from "vitest";
import { errorAbi } from "../../src/chain/abi.generated";
import type { ChainCtx } from "../../src/chain/client";
import { type RunRecord, replayTx, runKit } from "./runkit";

const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const receipt = (hash: Hex, status: "success" | "reverted") => ({ transactionHash: hash, blockNumber: 7n, status });

/** A chain that knows the receipts and mempool entries it is given, and nothing else. */
function chain(o: { receipts?: Record<string, "success" | "reverted">; mempool?: Hex[] }) {
  return {
    net: { key: "base-sepolia", caps: { devChain: false } },
    pub: {
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const s = o.receipts?.[hash];
        if (!s) throw new Error("timed out");
        return receipt(hash, s);
      },
      getTransaction: async ({ hash }: { hash: Hex }) => {
        if (o.mempool?.includes(hash)) return { hash };
        throw new Error("not found");
      },
    },
  } as unknown as ChainCtx;
}

const kit = (record: RunRecord<"a" | "b">, ctx: ChainCtx) => {
  const path = join(mkdtempSync(join(tmpdir(), "runkit-")), "record.json");
  return { path, ...runKit<"a" | "b">({ path, record, ctx, log: () => {} }) };
};

describe("runKit", () => {
  it("saves a step's hash the moment it is broadcast, and clears it once the step is recorded", () => {
    const record: RunRecord<"a" | "b"> = { steps: {} };
    const k = kit(record, chain({}));
    k.sending("a").onHash(H(1));
    expect(JSON.parse(readFileSync(k.path, "utf8")).pending).toEqual({ a: H(1) });
    k.record("a", { title: "a", status: "success", hash: H(1), block: 7, detail: "" });
    expect(record.pending).toEqual({});
    expect(record.steps.a?.hash).toBe(H(1));
  });

  it("hands back a step that landed as wanted, so it is recorded and never sent again", async () => {
    const k = kit({ steps: {}, pending: { a: H(1), b: H(2) } }, chain({ receipts: { [H(1)]: "success", [H(2)]: "reverted" } }));
    expect((await k.landed("a"))?.transactionHash).toBe(H(1));
    expect((await k.landed("b", "reverted"))?.transactionHash).toBe(H(2));
  });

  it("clears a hash that never landed, or landed the wrong way, so the step is sent afresh", async () => {
    const record: RunRecord<"a" | "b"> = { steps: {}, pending: { a: H(1), b: H(2) } };
    const k = kit(record, chain({ receipts: { [H(2)]: "reverted" } }));
    expect(await k.landed("a")).toBeNull();
    expect(await k.landed("b")).toBeNull();
    expect(record.pending).toEqual({});
  });

  it("stops rather than resend a transaction still waiting in the mempool", async () => {
    const k = kit({ steps: {}, pending: { a: H(1) } }, chain({ mempool: [H(1)] }));
    await expect(k.landed("a")).rejects.toThrow(/still waiting to be mined/);
  });
});

describe("replayTx", () => {
  /** A chain holding one transaction mined in block 7, whose replay reverts with PaceExceeded. */
  const replayChain = (status: "success" | "reverted", seen: bigint[]) =>
    ({
      pub: {
        getTransaction: async () => ({ from: H(9).slice(0, 42), to: H(8).slice(0, 42), input: "0x12345678", value: 0n }),
        getTransactionReceipt: async ({ hash }: { hash: Hex }) => receipt(hash, status),
        call: async ({ blockNumber }: { blockNumber: bigint }) => {
          seen.push(blockNumber);
          const data = encodeErrorResult({ abi: errorAbi, errorName: "PaceExceeded", args: [1_000_000_000n, 264_622_709n] });
          throw Object.assign(new BaseError("execution reverted"), { data });
        },
      },
    }) as unknown as ChainCtx;

  it("replays a revert in its own block, so arguments that move with time read as the chain's did", async () => {
    const seen: bigint[] = [];
    const err = await replayTx(replayChain("reverted", seen), H(1));
    expect(seen).toEqual([7n]);
    expect(err.name).toBe("PaceExceeded");
    expect(err.args.map(String)).toEqual(["1000000000", "264622709"]);
  });

  it("refuses to explain a transaction that did not revert", async () => {
    const seen: bigint[] = [];
    await expect(replayTx(replayChain("success", seen), H(1))).rejects.toThrow(/did not revert/);
    expect(seen).toEqual([]);
  });
});
