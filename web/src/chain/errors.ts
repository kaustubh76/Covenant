import { BaseError, type Hex, decodeErrorResult, formatEther } from "viem";
import { errorAbi } from "./abi.generated";
import { shortAddress } from "./accounts";

/** Which promise of the covenant (or which part of the stack) a refusal comes from. */
export type Rule = "Conservation" | "Support" | "Pace" | "Guard" | "Anchor" | "Lock" | "Access" | "Restore" | "Shape" | "Terms" | "Auction" | "Pool" | "Other";

export interface DecodedError {
  /** Custom error name, e.g. "SupportBroken", or "Error"/"Panic" for string and panic reverts. */
  name: string;
  args: readonly unknown[];
  /** The revert as it reads on-chain, e.g. SupportBroken(3156, 4000). */
  signature: string;
  rule: Rule;
  /** One plain sentence on why the contract refused. */
  reason: string;
}

export interface DescribeContext {
  /** Current chain time, for timelock messages. */
  now?: number;
  quoteSymbol?: string;
  tokenSymbol?: string;
}

const n = (v: unknown) => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));
const pctBps = (bps: unknown, dp = 1) => `${(n(bps) / 100).toFixed(dp)}%`;
/** Pace fractions are parts per 1e9 of the vault's value. */
const pctFraction = (f: unknown) => `${(n(f) / 1e7).toFixed(1)}%`;
/** Principal shares: 1e18 is the issuer's whole principal. */
const pctShares = (s: unknown) => `${(n(s) / 1e16).toFixed(2)}%`;
const eth = (wei: unknown) => {
  const v = Number(formatEther(typeof wei === "bigint" ? wei : BigInt(n(wei))));
  return v >= 1 ? v.toFixed(2) : v.toPrecision(3);
};
const span = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`;
};

type Describer = (args: readonly unknown[], c: DescribeContext) => [Rule, string];

const REASONS: Record<string, Describer> = {
  // ---- who may act
  NotCurator: () => ["Access", "Only the named curator can reshape the vault."],
  NotIssuer: () => ["Access", "Only the issuer can do this."],
  NotPendingIssuer: () => ["Access", "Only the proposed issuer can accept the issuer role."],
  NoCuratorProposal: () => ["Access", "There is no pending curator change to accept or cancel."],
  InsufficientShares: ([have, asked]) => [
    "Access",
    n(have) === 0
      ? "This address holds no vault shares, so there is nothing for it to withdraw. A curator never holds any."
      : `This address holds ${pctShares(have)} of the principal's size in shares and asked for ${pctShares(asked)}.`,
  ],
  // ---- the four promises
  IdleTooLarge: ([q0, q1], c) => [
    "Conservation",
    `${eth(q0)} ${c.quoteSymbol ?? "ETH"} and ${eth(q1)} ${c.tokenSymbol ?? "tokens"} would be left out of the pool. A reshape must put back everything it lifts.`,
  ],
  SupportBroken: ([have, need]) => [
    "Support",
    `Only ${pctBps(have)} of the vault's quote would bid inside the support band. The covenant requires ${pctBps(need, 0)}.`,
  ],
  PaceExceeded: ([asked, available]) => [
    "Pace",
    `This moves ${pctFraction(asked)} of the vault's value, but Pace lets only ${pctFraction(available)} move now. The allowance refills every epoch.`,
  ],
  SetupEpoch: ([endsAt], c) => [
    "Pace",
    `Outside deposits open after the setup epoch${c.now !== undefined ? `, in ${span(n(endsAt) - c.now)}` : ""}.`,
  ],
  TimelockActive: ([readyAt], c) => [
    "Pace",
    `The curator change is still inside its timelock${c.now !== undefined ? `: ${span(n(readyAt) - c.now)} to go` : ""}. Holders have this window to react.`,
  ],
  PriceGuard: ([spot, twap]) => [
    "Guard",
    `Spot is ${Math.abs(n(spot) - n(twap))} ticks from the time-weighted price. Nothing can change until the price has held.`,
  ],
  BidAboveCeiling: ([top, ceiling]) => [
    "Anchor",
    `A bid would reach ${n(top) - n(ceiling)} ticks above the Anchor ceiling. The vault never bids above a price it has not held for days.`,
  ],
  Locked: ([withdrawable, asked]) => [
    "Lock",
    `Only ${pctShares(withdrawable)} of the issuer's principal is withdrawable now. This asks for ${pctShares(asked)}.`,
  ],
  // ---- restore
  NothingToRestore: ([have, need]) => [
    "Restore",
    `Support is ${pctBps(have)} against a ${pctBps(need, 0)} minimum, so there is nothing to restore and no bounty to claim.`,
  ],
  RestoreInsufficient: ([have, need]) => [
    "Restore",
    `Moving these ranges would only bring support to ${pctBps(have)}, short of ${pctBps(need, 0)}. The call is refused and pays nothing.`,
  ],
  NoQuoteToRestore: ([i]) => ["Restore", `Range ${n(i)} holds no quote, so restoring it would not add support.`],
  RestoreBandEmpty: ([bottom, top]) => [
    "Anchor",
    `Restore would have to bid between ticks ${n(bottom)} and ${n(top)}, above every price the vault has sold at. It refuses rather than chase a pumped price.`,
  ],
  // ---- layout
  TooManyRanges: ([count, max]) => ["Shape", `${n(count)} ranges. A reshape may leave at most ${n(max)}, so restore always has room.`],
  InvalidCut: ([i]) => ["Shape", `Cut ${n(i)} is invalid: indices must be strictly increasing and name existing ranges.`],
  InvalidLeg: ([i]) => ["Shape", `Leg ${n(i)} is invalid: bounds must be aligned to the tick spacing and ordered.`],
  SharesExceedWhole: () => ["Shape", "The legs ask for more than 100% of one of the currencies."],
  SinkStraddlesPrice: ([i]) => ["Shape", `Leg ${n(i)} takes the remainder but straddles the price, so it would need both currencies.`],
  // ---- money in, money out
  InsufficientPayment: ([owed, paid]) => ["Other", `The deposit costs ${eth(owed)} ETH but ${eth(paid)} ETH was sent. The vault never pays for a depositor.`],
  // Solady's SafeTransferLib, which the vault takes a depositor's tokens with, drops the token's own reason: a short
  // balance and a missing approval both arrive as this one error.
  TransferFromFailed: (_, c) => ["Other", `The vault could not take the ${c.tokenSymbol ?? "tokens"} it is owed: the sender holds too few, or has not approved the vault for that many.`],
  // The same library sends a deposit's unused ETH back to the sender.
  ETHTransferFailed: () => ["Other", "The vault could not send back the ETH this call did not use: the sender's address does not accept ETH."],
  Slippage: () => ["Other", "The amounts moved past the limits set for this call."],
  ZeroShares: () => ["Other", "The amount of shares must be above zero."],
  Expired: () => ["Other", "The deadline for this call has passed."],
  NotAdopted: () => ["Other", "The launch's liquidity has not been adopted by the vault yet."],
  PoolNotLive: () => ["Other", "The pool has not been initialized yet."],
  AlreadyHasOutsideShares: () => ["Other", "Adoption has to happen before any outside deposit."],
  NotOwnedByVault: ([id]) => ["Access", `Position ${n(id)} is not owned by this vault.`],
  WrongPool: ([id]) => ["Other", `Position ${n(id)} belongs to a different pool.`],
  // ---- terms (factory)
  InvalidSupportBps: ([v]) => ["Terms", `Support of ${pctBps(v)} is outside 0.01%–100%.`],
  InvalidGuardTicks: ([v]) => ["Terms", `A guard of ${n(v)} ticks is outside 1–10,000.`],
  InvalidSupportBand: ([band, min]) => ["Terms", `The support band of ${n(band)} ticks must be at least ${n(min)} (guard plus three tick spacings) and at most 200,000.`],
  InvalidPaceBps: ([v]) => ["Terms", `Pace of ${pctBps(v)} is outside 0.01%–100%.`],
  InvalidEpochLength: () => ["Terms", "The epoch must be between 1 hour and 30 days."],
  InvalidTwapWindow: ([w, max]) => ["Terms", `An averaging window of ${span(n(w))} is outside 5 minutes–${span(n(max))}.`],
  InvalidCuratorFeeBps: ([v]) => ["Terms", `A curator fee of ${pctBps(v)} is above the 30% cap.`],
  WrongHook: () => ["Terms", "The pool key does not use the Covenant hook."],
  InvalidPoolKey: () => ["Terms", "The pool key is invalid: currencies must be sorted, the fee static and the spacing in range."],
  QuoteMismatch: () => ["Terms", "Native ETH can only be the quote, and it sorts to currency0."],
  ZeroAddress: () => ["Terms", "The issuer and treasury must be set."],
  // ---- the auction
  BidMustBeAboveClearingPrice: () => ["Auction", "Bids must be above the current clearing price."],
  AuctionNotStarted: () => ["Auction", "The auction has not started yet."],
  AuctionIsOver: () => ["Auction", "The auction is over."],
  AuctionIsNotOver: () => ["Auction", "The auction is still running."],
  AuctionSoldOut: () => ["Auction", "Every token is already spoken for: the auction has nothing left to sell."],
  TickPriceNotAtBoundary: () => ["Auction", "A bid's price must sit on the auction's price grid."],
  InvalidBidPriceTooHigh: ([, max]) => ["Auction", `A bid can go up to ${(n(max) / 2 ** 96).toPrecision(4)} ETH a token at most.`],
  BidAmountTooSmall: () => ["Auction", "The bid is too small to buy anything at this price."],
  // the auction's own (no arguments: the ETH sent is not the bid's amount) and the launcher's (an amount over its cap)
  InvalidAmount: ([amount, max]) => ["Auction", amount === undefined ? "The ETH sent must equal the bid's amount." : `${eth(amount)} is more than the ${eth(max)} allowed.`],
  NotAuthorized: ([authorized, caller]) => ["Auction", `Only ${shortAddress(String(authorized))}, the recipient the auction names, can do this. It was sent from ${shortAddress(String(caller))}.`],
  CannotSweepTokens: () => ["Auction", "The unsold tokens have already been swept to the treasury."],
  // once it is over: leaving, and claiming what a bid bought
  NotGraduated: () => ["Auction", "The auction did not raise what it needed to graduate: bids leave with their ETH, and there are no tokens to claim."],
  AuctionIsNotFinalized: () => ["Auction", "The auction is not settled yet: its final checkpoint comes first."],
  BidAlreadyExited: () => ["Auction", "This bid has already left the auction."],
  BidNotExited: () => ["Auction", "A bid leaves the auction before it claims its tokens."],
  CannotExitBid: () => ["Auction", "This bid cannot leave yet: one at or under the clearing price leaves once the auction is over."],
  CannotPartiallyExitBidBeforeEndBlock: () => ["Auction", "A partly filled bid leaves once the auction is over."],
  CannotPartiallyExitBidBeforeGraduation: () => ["Auction", "A partly filled bid leaves once the auction has graduated."],
  NotClaimable: () => ["Auction", "The tokens are not claimable yet: claims open a few blocks after the auction ends."],
  TokensNotReceived: () => ["Auction", "The auction has not received the tokens it is meant to sell."],
  InvalidBidUnableToClear: () => ["Auction", "A bid at that price could never be filled: raise its price."],
  MpsRemainingIsZero: () => ["Auction", "The auction has nothing left to sell in its remaining blocks."],
  // ---- the launch strategy (LBPStrategy), which turns an auction into the pool and the vault's positions
  InitializerNotRegistered: () => ["Auction", "This launch has already migrated: the strategy migrates an auction once. What is left is for the vault to adopt its positions."],
  MigrationNotYetAllowed: ([at, now]) => ["Auction", `Migration opens at block ${n(at)}; this is block ${n(now)}.`],
  NoPositionsCreated: () => ["Auction", "The migration would mint no pool positions, so it is refused."],
  // ---- tokens (OpenZeppelin's ERC-20)
  ERC20InsufficientBalance: ([, have, need], c) => ["Other", `The sender holds ${eth(have)} ${c.tokenSymbol ?? "tokens"} and this needs ${eth(need)}.`],
  ERC20InsufficientAllowance: ([spender, have, need], c) => [
    "Other",
    `${shortAddress(String(spender))} may take ${eth(have)} ${c.tokenSymbol ?? "tokens"} from the sender and this needs ${eth(need)}: the approval is missing or too small.`,
  ],
  ERC20InvalidApprover: () => ["Other", "There is no account to approve from: connect a wallet on this network first."],
  // ---- the pool
  PriceLimitAlreadyExceeded: () => ["Pool", "The price is already past the swap's limit."],
  PoolNotInitialized: () => ["Pool", "The pool has no price yet: it is created when the launch migrates."],
  SwapAmountCannotBeZero: () => ["Pool", "A swap has to move some amount: this one rounds to nothing."],
  // The PoolManager keys positions by owner: removing liquidity from a range the caller never added to underflows its
  // own empty position (LiquidityMath.addDelta), so the vault's ranges are out of anyone else's reach.
  SafeCastOverflow: () => ["Access", "That position belongs to its owner: the caller holds no liquidity there to remove."],
};

/** Render one decoded custom error. */
export function describeError(name: string, args: readonly unknown[] = [], ctx: DescribeContext = {}): DecodedError {
  const render = (a: unknown): string => (typeof a === "bigint" ? a.toString() : Array.isArray(a) ? `[${a.map(render).join(", ")}]` : String(a));
  const signature = `${name}(${args.map(render).join(", ")})`;
  const d = REASONS[name];
  if (d) {
    const [rule, reason] = d(args, ctx);
    return { name, args, signature, rule, reason };
  }
  return { name, args, signature, rule: "Other", reason: "The call reverted." };
}

/** Find raw revert data anywhere in a viem error chain. */
function revertData(e: unknown): Hex | undefined {
  if (!(e instanceof BaseError)) return undefined;
  let found: Hex | undefined;
  e.walk((inner) => {
    const x = inner as { data?: unknown; raw?: unknown };
    if (typeof x.raw === "string" && x.raw.startsWith("0x") && x.raw.length >= 10) found ??= x.raw as Hex;
    if (typeof x.data === "string" && x.data.startsWith("0x") && x.data.length >= 10) found ??= x.data as Hex;
    return false;
  });
  return found;
}

/** Decode why a call reverted: custom errors from every contract the app calls, string reverts, panics. */
export function decodeRevert(e: unknown, ctx: DescribeContext = {}): DecodedError {
  const raw = revertData(e);
  if (raw) {
    try {
      const d = decodeErrorResult({ abi: errorAbi, data: raw });
      if (d.errorName === "WrappedError" && Array.isArray(d.args) && typeof d.args[2] === "string") {
        // A hook or callee reverted inside the PoolManager: report the inner error.
        try {
          const inner = decodeErrorResult({ abi: errorAbi, data: d.args[2] as Hex });
          return describeError(inner.errorName, inner.args ?? [], ctx);
        } catch {
          /* fall through to the wrapper */
        }
      }
      return describeError(d.errorName, d.args ?? [], ctx);
    } catch {
      /* not one of ours */
    }
  }
  if (e instanceof BaseError) {
    const r = e.walk((inner) => typeof (inner as { reason?: unknown }).reason === "string") as { reason?: string } | null;
    if (r?.reason) return { name: "Error", args: [r.reason], signature: `Error("${r.reason}")`, rule: "Other", reason: r.reason };
    return { name: "Error", args: [], signature: e.shortMessage, rule: "Other", reason: e.shortMessage };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { name: "Error", args: [], signature: msg, rule: "Other", reason: msg };
}
