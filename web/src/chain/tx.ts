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
import { type ChainCtx, signerNeeded } from "./client";
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
    return actor ? { wallet: ctx.wallet(actor) } : { refusal: `There is no dev key for ${shortAddress(party)} on ${ctx.net.key === "playground" ? "the Playground" : "the local chain"}.` };
  }
  if (!ctx.signer) {
    return { refusal: ctx.walletChainId !== null && ctx.walletChainId !== undefined ? signerNeeded(ctx.net, ctx.walletChainId) : `Connect a wallet to send this on ${ctx.net.name}.` };
  }
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
 * A dev chain's sends skip the node round trips a public chain needs. Its Anvil prices gas at zero (`client.ts`), so a
 * fixed limit costs nothing and needs no estimate, and its fees are known without reading a block. On the Playground
 * every round trip crosses the internet to the backend, and a run of the attack lab sends dozens of transactions in a
 * row. The limit stays under EIP-7825's per-transaction cap (2^24), which a later Anvil may enforce; `sameBlock` sends
 * with its own, smaller limits, so its transactions share one block.
 */
const DEV_GAS = 16_000_000n;
const DEV_FEES = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n } as const;

/**
 * The gas and fees a dev chain's direct writes (outside `send`) carry, and nothing on a public chain, whose node and
 * wallet price them. A dev-chain write must not leave its fees to viem: it asks Anvil to fill them
 * (`eth_fillTransaction`), keeps Anvil's 1 gwei tip with the chain's zero fee cap, and Anvil refuses the result.
 */
export const devTxFields = (ctx: ChainCtx, gas: bigint = DEV_GAS) => (ctx.net.caps.devChain ? { gas, ...DEV_FEES } : {});

/**
 * A sent transaction's receipt. Anvil mines on send, so a dev chain's receipt is read once before falling back to
 * polling, which would first ask for the block number.
 */
export async function receiptFor(ctx: ChainCtx, hash: Hex): Promise<TransactionReceipt> {
  if (ctx.net.caps.devChain) {
    const mined = await ctx.pub.getTransactionReceipt({ hash }).catch(() => null);
    if (mined) return mined;
  }
  return ctx.pub.waitForTransactionReceipt({ hash, pollingInterval: ctx.net.caps.devChain ? 100 : 1000, timeout: 180_000 });
}

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
  const dev = ctx.net.caps.devChain;
  let hash: Hex;
  try {
    hash = await wallet.writeContract({
      ...(call as object),
      account: wallet.account,
      chain: ctx.chain,
      gas: opts.gas ?? (dev ? DEV_GAS : pre.ok ? await gasFor(ctx, party, call as never) : FORCED_GAS),
      ...(dev ? DEV_FEES : {}),
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
    receipt = await receiptFor(ctx, hash);
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

/**
 * Poll `check` until it holds. A public chain's RPC balances calls over nodes, and one a block behind still answers from
 * before a transaction just mined: an approval the next call needs, say. A dev chain mines on send and has one node, so
 * it is asked once. Bounded: false once `tries` have all said no.
 */
export async function untilVisible(ctx: ChainCtx, check: () => Promise<boolean>, opts: { tries?: number; everyMs?: number } = {}): Promise<boolean> {
  const tries = ctx.net.caps.devChain ? 1 : (opts.tries ?? 12);
  for (let i = 0; i < tries; i++) {
    if (await check().catch(() => false)) return true;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, opts.everyMs ?? 800));
  }
  return false;
}

/**
 * `send`, simulated again while its pre-flight fails in a way `retryIf` says a lagging node explains (an approval it has
 * not seen yet), up to `tries` sends in all, `everyMs` apart. Nothing goes out until a simulation passes, so a retry never
 * sends twice. A gas estimate refused the same way (it runs on whichever node answers) counts as the same failure.
 */
export async function sendRetrying<const abi extends Abi, fn extends ContractFunctionName<abi, Mutability>>(
  ctx: ChainCtx,
  party: Party,
  call: Call<abi, fn>,
  opts: SendOptions,
  retry: { retryIf: (o: Outcome) => boolean; tries?: number; everyMs?: number },
): Promise<Outcome<ContractFunctionReturnType<abi, Mutability, fn>>> {
  // A dev chain has one node, mining on send: a refusal there is the contract's, and is not asked again.
  const tries = ctx.net.caps.devChain ? 1 : (retry.tries ?? 4);
  for (let i = 1; ; i++) {
    let o: Outcome<ContractFunctionReturnType<abi, Mutability, fn>>;
    try {
      o = await send(ctx, party, call, opts);
    } catch (e) {
      const error = classify(e) ?? decodeRevert(e, opts.describe);
      if (i >= tries || !retry.retryIf({ ok: false, error })) throw e;
      await new Promise((r) => setTimeout(r, retry.everyMs ?? 1000));
      continue;
    }
    if (o.ok || o.hash || i >= tries || !retry.retryIf(o)) return o;
    await new Promise((r) => setTimeout(r, retry.everyMs ?? 1000));
  }
}

/**
 * A step that must not fail, failed. Its message is the one scripts log ("approve failed: Sig(…)"); `outcome` keeps the
 * decoded refusal or failure, so the app's toast can say what the contract or the wallet said, not just the signature.
 */
export class StepFailed extends Error {
  override name = "StepFailed";
  constructor(
    readonly what: string,
    readonly outcome: Outcome,
  ) {
    super(`${what} failed: ${outcome.error?.signature ?? "unknown error"}`);
  }
}

/** Throw unless the outcome succeeded. For setup steps that must not fail. */
export function must<T>(o: Outcome<T>, what: string): Outcome<T> {
  if (!o.ok) throw new StepFailed(what, o);
  return o;
}
