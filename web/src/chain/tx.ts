import {
  type Abi,
  type Account,
  type Address,
  type Chain,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type ContractFunctionReturnType,
  type Hex,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
  zeroAddress,
} from "viem";
import { type Actor, actorOf, shortAddress } from "./accounts";
import type { ChainCtx } from "./client";
import { type DecodedError, type DescribeContext, decodeRevert } from "./errors";
import { classify } from "./failure";

/**
 * Who an action is from: a demo role, or a specific address. Passing the vault's curator by address lets a page show
 * what the curator's action would do on a public chain, where nobody but the curator's own wallet can send it.
 */
export type Party = Actor | Address;
export const isAddressParty = (p: Party): p is Address => p.startsWith("0x");

/** The address `party` acts from. On a public chain with no wallet connected, a role is previewed from address zero. */
export function partyAddress(ctx: ChainCtx, party: Party): Address {
  if (isAddressParty(party)) return party;
  if (!ctx.net.caps.devChain && !ctx.signer) return zeroAddress;
  return ctx.address(party);
}

/** The wallet that sends for `party` here, or why nobody can. */
export function signerFor(ctx: ChainCtx, party: Party): { wallet: WalletClient<Transport, Chain, Account> } | { refusal: string } {
  if (ctx.net.caps.devChain) {
    const actor = isAddressParty(party) ? actorOf(party) : party;
    return actor ? { wallet: ctx.wallet(actor) } : { refusal: `There is no dev key for ${shortAddress(party)} on the local chain.` };
  }
  if (!ctx.signer) return { refusal: `Connect a wallet to send this on ${ctx.net.name}.` };
  if (isAddressParty(party) && party.toLowerCase() !== ctx.signer.toLowerCase()) {
    return { refusal: `Only ${shortAddress(party)} can send this. The connected wallet is ${shortAddress(ctx.signer)}.` };
  }
  return { wallet: ctx.wallet("holder") };
}

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
  /** The pre-flight passed but nobody here can sign for the sender: who could, and who is connected. */
  refused?: string;
}

export interface SendOptions {
  /** Local chain only: send even if the pre-flight reverts, so the failure is mined with a hash. */
  force?: boolean;
  gas?: bigint;
  describe?: DescribeContext;
  /**
   * Called the moment the transaction is broadcast, before its receipt is waited for: a runner that records its steps
   * saves the hash here, so a rerun after a crash finds the transaction instead of sending it twice.
   */
  onHash?: (hash: Hex) => void;
}

const FORCED_GAS = 10_000_000n;

/**
 * The gas a pre-flighted call is sent with: the node's estimate, plus headroom. An estimate is the least that ran in the
 * block it was made against, but some of Covenant's costs move with the clock. The first swap of each oracle minute
 * stores a new slot (TwapOracle.write), about 22k gas more than a write inside the minute, so a swap estimated in one
 * minute and mined in the next would run out of gas, reverting with no reason given. Unused gas is not charged.
 */
async function gasFor(ctx: ChainCtx, party: Party, call: Call<Abi, string>): Promise<bigint> {
  const estimate = await ctx.pub.estimateContractGas({ ...(call as object), account: partyAddress(ctx, party) } as never);
  return estimate + estimate / 4n + 50_000n;
}

/** Pre-flight only: what the contract would return or why it would revert, from `party`, in the next block. */
export async function simulate<const abi extends Abi, fn extends ContractFunctionName<abi, Mutability>>(
  ctx: ChainCtx,
  party: Party,
  call: Call<abi, fn>,
  describe?: DescribeContext,
): Promise<Outcome<ContractFunctionReturnType<abi, Mutability, fn>>> {
  try {
    // "pending" executes in the block the transaction would land in (next number, next timestamp), so time- and
    // block-gated checks (auction start, timelocks, the setup epoch, the TWAP) match what the transaction will see.
    const { result } = await ctx.pub.simulateContract({ ...(call as object), account: partyAddress(ctx, party), blockTag: "pending" } as never);
    return { ok: true, value: result as ContractFunctionReturnType<abi, Mutability, fn> };
  } catch (e) {
    // A node that did not answer is not a refusal: say so, instead of decoding it as a revert.
    return { ok: false, error: classify(e) ?? decodeRevert(e, describe) };
  }
}

/**
 * Simulate, then send from `party` and wait for the receipt. A call that would revert is not sent. On the local chain
 * `force` sends it anyway, so the failure is mined with a hash and the pre-flight says why; a public chain never does,
 * since the wallet's owner would pay gas for a refusal the pre-flight already decoded.
 */
export async function send<const abi extends Abi, fn extends ContractFunctionName<abi, Mutability>>(
  ctx: ChainCtx,
  party: Party,
  call: Call<abi, fn>,
  opts: SendOptions = {},
): Promise<Outcome<ContractFunctionReturnType<abi, Mutability, fn>>> {
  const pre = await simulate(ctx, party, call, opts.describe);
  if (!pre.ok && !(opts.force && ctx.net.caps.devChain)) return pre;
  const who = signerFor(ctx, party);
  if ("refusal" in who) {
    return { ok: false, value: pre.value, refused: who.refusal, error: { name: "NotSent", args: [], signature: "Not sent", rule: "Other", reason: who.refusal } };
  }
  const wallet = who.wallet;
  let hash: Hex;
  try {
    hash = await wallet.writeContract({
      ...(call as object),
      account: wallet.account,
      chain: ctx.chain,
      gas: opts.gas ?? (pre.ok ? await gasFor(ctx, party, call as never) : FORCED_GAS),
    } as never);
  } catch (e) {
    // Declined in the wallet, the wallet on another network, not enough ETH, a node that did not answer: nothing was
    // sent, and none of it is the contract's refusal.
    const why = classify(e);
    if (why) return { ok: false, value: pre.value, error: why };
    throw e;
  }
  opts.onHash?.(hash);
  // Anvil mines at once; a public chain is polled at its own pace, which its RPC's rate limits also prefer.
  let receipt: TransactionReceipt;
  try {
    receipt = await ctx.pub.waitForTransactionReceipt({ hash, pollingInterval: ctx.net.caps.devChain ? 100 : 1000, timeout: 180_000 });
  } catch (e) {
    // Sent but not seen mined in time: keep the hash, so the visitor can follow it, rather than losing it to an error.
    const why = classify(e);
    if (why) return { ok: false, hash, error: why };
    throw e;
  }
  if (receipt.status === "success") return { ok: true, value: pre.value, hash, receipt };
  if (pre.error) return { ok: false, hash, receipt, error: pre.error };
  // Passed the pre-flight but failed when mined: something changed in between. Replay it at its parent block.
  try {
    await ctx.pub.simulateContract({ ...(call as object), account: partyAddress(ctx, party), blockNumber: receipt.blockNumber - 1n } as never);
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
