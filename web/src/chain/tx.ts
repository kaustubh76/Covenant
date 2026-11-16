import type { Abi, Address, ContractFunctionArgs, ContractFunctionName, ContractFunctionReturnType, Hex, TransactionReceipt } from "viem";
import type { Actor } from "./accounts";
import type { ChainCtx } from "./client";
import { type DecodedError, type DescribeContext, decodeRevert } from "./errors";

type Mutability = "nonpayable" | "payable";

export interface Call<abi extends Abi, fn extends ContractFunctionName<abi, Mutability>> {
  address: Address;
  abi: abi;
  functionName: fn;
  args: ContractFunctionArgs<abi, Mutability, fn>;
  value?: bigint;
}

export interface Outcome<T = unknown> {
  ok: boolean;
  /** The return value, from the pre-flight simulation. */
  value?: T;
  hash?: Hex;
  receipt?: TransactionReceipt;
  error?: DecodedError;
}

export interface SendOptions {
  /** Send even if the pre-flight reverts, so the failure is mined with a hash. */
  force?: boolean;
  gas?: bigint;
  describe?: DescribeContext;
}

const FORCED_GAS = 10_000_000n;

/** Pre-flight only: what the contract would return or why it would revert, from `actor`, in the next block. */
export async function simulate<const abi extends Abi, fn extends ContractFunctionName<abi, Mutability>>(
  ctx: ChainCtx,
  actor: Actor,
  call: Call<abi, fn>,
  describe?: DescribeContext,
): Promise<Outcome<ContractFunctionReturnType<abi, Mutability, fn>>> {
  try {
    // "pending" executes in the block the transaction would land in (next number, next timestamp), so time- and
    // block-gated checks (auction start, timelocks, the setup epoch, the TWAP) match what the transaction will see.
    const { result } = await ctx.pub.simulateContract({ ...(call as object), account: ctx.address(actor), blockTag: "pending" } as never);
    return { ok: true, value: result as ContractFunctionReturnType<abi, Mutability, fn> };
  } catch (e) {
    return { ok: false, error: decodeRevert(e, describe) };
  }
}

/**
 * Simulate, then send from `actor` and wait for the receipt. A call that would revert is not sent unless `force` is
 * set; then it is mined as a failed transaction, and the pre-flight says why.
 */
export async function send<const abi extends Abi, fn extends ContractFunctionName<abi, Mutability>>(
  ctx: ChainCtx,
  actor: Actor,
  call: Call<abi, fn>,
  opts: SendOptions = {},
): Promise<Outcome<ContractFunctionReturnType<abi, Mutability, fn>>> {
  const pre = await simulate(ctx, actor, call, opts.describe);
  if (!pre.ok && !opts.force) return pre;
  const wallet = ctx.wallet(actor);
  const hash = await wallet.writeContract({
    ...(call as object),
    account: wallet.account,
    chain: ctx.chain,
    ...(pre.ok ? (opts.gas ? { gas: opts.gas } : {}) : { gas: opts.gas ?? FORCED_GAS }),
  } as never);
  // Anvil mines at once; a public chain is polled at its own pace, which its RPC's rate limits also prefer.
  const receipt = await ctx.pub.waitForTransactionReceipt({ hash, pollingInterval: ctx.net.caps.devChain ? 100 : 1000, timeout: 180_000 });
  if (receipt.status === "success") return { ok: true, value: pre.value, hash, receipt };
  if (pre.error) return { ok: false, hash, receipt, error: pre.error };
  // Passed the pre-flight but failed when mined: something changed in between. Replay it at its parent block.
  try {
    await ctx.pub.simulateContract({ ...(call as object), account: ctx.address(actor), blockNumber: receipt.blockNumber - 1n } as never);
  } catch (e) {
    return { ok: false, hash, receipt, error: decodeRevert(e, opts.describe) };
  }
  return { ok: false, hash, receipt, error: { name: "Error", args: [], signature: "reverted", rule: "Other", reason: "The transaction reverted." } };
}

/** Throw unless the outcome succeeded. For setup steps that must not fail. */
export function must<T>(o: Outcome<T>, what: string): Outcome<T> {
  if (!o.ok) throw new Error(`${what} failed: ${o.error?.signature ?? "unknown error"}`);
  return o;
}
