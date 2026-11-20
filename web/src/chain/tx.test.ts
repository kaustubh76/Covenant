import { type Address, type Hex, RawContractError, UserRejectedRequestError, WaitForTransactionReceiptTimeoutError, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { covenantVaultAbi } from "./abi.generated";
import type { ChainCtx } from "./client";
import { send, sendRetrying, untilVisible } from "./tx";

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

/** A dev chain (the Playground): a dev key signs, and every round trip to the node is counted. */
function devChain(sent: Record<string, unknown>[], asked: string[], mined = true) {
  return {
    net: { key: "playground", name: "Playground", caps: { devChain: true } },
    address: () => ME,
    pub: {
      simulateContract: async () => (asked.push("simulate"), { result: undefined }),
      estimateContractGas: async () => (asked.push("estimateGas"), 100_000n),
      getTransactionReceipt: async () => {
        asked.push("getReceipt");
        if (!mined) throw new Error("Transaction receipt could not be found.");
        return { status: "success", transactionHash: HASH, blockNumber: 1n };
      },
      waitForTransactionReceipt: async () => (asked.push("waitReceipt"), { status: "success", transactionHash: HASH, blockNumber: 1n }),
    },
    wallet: () => ({
      account: { address: ME },
      writeContract: async (tx: Record<string, unknown>) => (sent.push(tx), HASH),
    }),
  } as unknown as ChainCtx;
}

describe("send, on a dev chain", () => {
  it("skips the gas estimate and the fee lookup, and reads the receipt Anvil has already mined", async () => {
    const sent: Record<string, unknown>[] = [];
    const asked: string[] = [];
    const o = await send(devChain(sent, asked), "holder", poke);
    expect(o.ok).toBe(true);
    expect(asked).toEqual(["simulate", "getReceipt"]);
    expect(sent[0]).toMatchObject({ gas: 16_000_000n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n });
  });

  it("polls for the receipt when the block is not mined yet", async () => {
    const asked: string[] = [];
    const o = await send(devChain([], asked, false), "holder", poke);
    expect(o.ok).toBe(true);
    expect(asked).toEqual(["simulate", "getReceipt", "waitReceipt"]);
  });

  it("keeps a gas limit the caller chose", async () => {
    const sent: Record<string, unknown>[] = [];
    await send(devChain(sent, []), "holder", poke, { gas: 3_000_000n });
    expect(sent[0].gas).toBe(3_000_000n);
  });
});

describe("send, when nothing is mined", () => {
  it("reports a wallet's refusal as declined, not as a revert", async () => {
    const ctx = chain(100_000n, []);
    (ctx as unknown as { wallet: () => unknown }).wallet = () => ({
      account: { address: ME },
      writeContract: async () => {
        throw new UserRejectedRequestError(new Error("User rejected the request."));
      },
    });
    const o = await send(ctx, "holder", poke);
    expect(o.ok).toBe(false);
    expect(o.error?.name).toBe("Rejected");
    expect(o.hash).toBeUndefined();
  });

  it("keeps the hash of a transaction that was sent but not mined in time", async () => {
    const ctx = chain(100_000n, []);
    (ctx.pub as unknown as { waitForTransactionReceipt: () => Promise<never> }).waitForTransactionReceipt = async () => {
      throw new WaitForTransactionReceiptTimeoutError({ hash: HASH });
    };
    const o = await send(ctx, "holder", poke);
    expect(o.error?.name).toBe("Pending");
    expect(o.hash).toBe(HASH);
  });
});

/** A public chain whose node refuses the first `lagging` simulations with `selector` (a node a block behind), then passes. */
function laggingChain(lagging: number, selector: Hex, sent: unknown[]) {
  let asked = 0;
  return {
    net: { key: "base-sepolia", name: "Base Sepolia", caps: { devChain: false } },
    signer: ME,
    walletChainId: null,
    address: () => ME,
    pub: {
      simulateContract: async () => {
        if (asked++ < lagging) throw new RawContractError({ data: selector });
        return { result: undefined };
      },
      estimateContractGas: async () => 100_000n,
      waitForTransactionReceipt: async () => ({ status: "success", transactionHash: HASH, blockNumber: 1n }),
    },
    wallet: () => ({ account: { address: ME }, writeContract: async (tx: unknown) => (sent.push(tx), HASH) }),
  } as unknown as ChainCtx;
}
const TRANSFER_FROM_FAILED = "0x7939f424" as Hex;

describe("sendRetrying: a refusal a lagging node explains", () => {
  it("simulates again until the node has caught up, then sends once", async () => {
    const sent: unknown[] = [];
    const o = await sendRetrying(laggingChain(2, TRANSFER_FROM_FAILED, sent), "holder", poke, {}, { retryIf: (x) => x.error?.name === "TransferFromFailed", everyMs: 1 });
    expect(o.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("gives up after its tries and returns the refusal, having sent nothing", async () => {
    const sent: unknown[] = [];
    const o = await sendRetrying(laggingChain(9, TRANSFER_FROM_FAILED, sent), "holder", poke, {}, { retryIf: (x) => x.error?.name === "TransferFromFailed", tries: 3, everyMs: 1 });
    expect(o.ok).toBe(false);
    expect(o.error?.name).toBe("TransferFromFailed");
    expect(sent).toHaveLength(0);
  });

  it("does not retry a refusal it was not told to", async () => {
    const sent: unknown[] = [];
    const o = await sendRetrying(laggingChain(1, TRANSFER_FROM_FAILED, sent), "holder", poke, {}, { retryIf: () => false, everyMs: 1 });
    expect(o.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("untilVisible", () => {
  const pub = { net: { caps: { devChain: false } } } as unknown as ChainCtx;
  const dev = { net: { caps: { devChain: true } } } as unknown as ChainCtx;

  it("on a public chain, asks until the answer holds", async () => {
    let n = 0;
    expect(await untilVisible(pub, async () => ++n >= 3, { everyMs: 1 })).toBe(true);
    expect(n).toBe(3);
  });

  it("is bounded, and a failed read counts as no", async () => {
    let n = 0;
    expect(
      await untilVisible(
        pub,
        async () => {
          n++;
          throw new Error("no answer");
        },
        { tries: 4, everyMs: 1 },
      ),
    ).toBe(false);
    expect(n).toBe(4);
  });

  it("on a dev chain, asks once: Anvil mines on send and has one node", async () => {
    let n = 0;
    expect(await untilVisible(dev, async () => (n++, false))).toBe(false);
    expect(n).toBe(1);
  });
});
