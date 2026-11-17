import { type Address, type Hex, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { covenantVaultAbi } from "./abi.generated";
import type { ChainCtx } from "./client";
import { send } from "./tx";

const ME = "0x00000000000000000000000000000000000000a1" as Address;
const HASH = `0x${"11".repeat(32)}` as Hex;

/** A public chain with a connected wallet, whose node estimates `estimate` gas and mines every transaction. */
function chain(estimate: bigint, sent: { gas?: bigint }[]) {
  return {
    net: { key: "base-sepolia", name: "Base Sepolia", caps: { devChain: false } },
    signer: ME,
    address: () => ME,
    pub: {
      simulateContract: async () => ({ result: undefined }),
      estimateContractGas: async () => estimate,
      waitForTransactionReceipt: async () => ({ status: "success", transactionHash: HASH, blockNumber: 1n }),
    },
    wallet: () => ({
      account: { address: ME },
      writeContract: async (tx: { gas?: bigint }) => {
        sent.push(tx);
        return HASH;
      },
    }),
  } as unknown as ChainCtx;
}

const poke = { address: zeroAddress, abi: covenantVaultAbi, functionName: "poke", args: [] } as const;

describe("send", () => {
  it("sends with headroom over the estimate, for the gas that moves with the clock (a new oracle minute)", async () => {
    const sent: { gas?: bigint }[] = [];
    const o = await send(chain(200_000n, sent), "holder", poke);
    expect(o.ok).toBe(true);
    // 200k estimated: a quarter more, and 50k on top, well over the ~22k a swap's first write of a minute adds.
    expect(sent.map((t) => t.gas)).toEqual([300_000n]);
  });

  it("keeps a gas limit the caller chose", async () => {
    const sent: { gas?: bigint }[] = [];
    await send(chain(200_000n, sent), "holder", poke, { gas: 123_456n });
    expect(sent.map((t) => t.gas)).toEqual([123_456n]);
  });
});
