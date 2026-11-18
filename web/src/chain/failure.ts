// Why an action did not happen, said honestly. A revert is the contract's own refusal, decoded by errors.ts. Everything
// else is something else: a wallet that said no or is on another network, not enough ETH, a node that did not answer, a
// transaction sent but not yet mined. None of those is shown as a revert.

import type { DecodedError } from "./errors";

export type FailureKind = "Rejected" | "WrongChain" | "Funds" | "WalletBusy" | "Pending" | "NoAnswer" | "NotSent";

/** The short label the app shows for each kind of failure that is not a revert. */
export const FAILURE_LABEL: Record<FailureKind, string> = {
  Rejected: "Declined",
  WrongChain: "Wrong network",
  Funds: "Not enough ETH",
  WalletBusy: "Wallet busy",
  Pending: "Still pending",
  NoAnswer: "No answer",
  NotSent: "Not sent",
};

export const isFailureKind = (name: string | undefined): name is FailureKind => !!name && name in FAILURE_LABEL;

const failure = (name: FailureKind, signature: string, reason: string): DecodedError => ({ name, args: [], signature, rule: "Other", reason });

type Err = { name?: unknown; code?: unknown; status?: unknown; message?: unknown; shortMessage?: unknown; cause?: unknown };

/**
 * What `e` is, when it is not the contract's refusal; null for a revert (decodeRevert says which) or an error nobody
 * here recognises. Walks the error's causes, since viem wraps a wallet's or node's error in its own.
 */
export function classify(e: unknown): DecodedError | null {
  for (let x = e as Err | undefined, depth = 0; x && typeof x === "object" && depth < 8; x = x.cause as Err | undefined, depth++) {
    const name = typeof x.name === "string" ? x.name : "";
    const code = x.code;
    const text = `${typeof x.shortMessage === "string" ? x.shortMessage : ""} ${typeof x.message === "string" ? x.message : ""}`;
    if (name === "UserRejectedRequestError" || code === 4001 || /user (rejected|denied)|rejected the request|request rejected/i.test(text)) {
      return failure("Rejected", "Declined in the wallet", "You declined it in your wallet. Nothing was sent.");
    }
    if (name === "ChainMismatchError" || name === "ChainNotConfiguredError" || /does not match the target chain|chain mismatch/i.test(text)) {
      return failure("WrongChain", "The wallet is on another network", "Your wallet is on another network. Switch it, then try again.");
    }
    if (name === "InsufficientFundsError" || /insufficient funds/i.test(text)) {
      return failure("Funds", "Not enough ETH", "The wallet does not hold enough ETH for this and its gas.");
    }
    if (code === -32002 || /already pending for origin|request of type .* already pending/i.test(text)) {
      return failure("WalletBusy", "The wallet is busy", "Your wallet already has a request open. Finish or dismiss it there, then try again.");
    }
    if (name === "WaitForTransactionReceiptTimeoutError") {
      return failure("Pending", "Sent, not mined yet", "It was sent but is not mined yet. It may still land: follow it on the explorer.");
    }
    if (
      name === "HttpRequestError" ||
      name === "TimeoutError" ||
      code === -32007 ||
      code === 429 ||
      x.status === 429 ||
      /fetch failed|failed to fetch|networkerror|request limit reached|took too long to respond/i.test(text)
    ) {
      return failure("NoAnswer", "No answer from the network", "The network did not answer just now, so nothing was decided. Try again.");
    }
  }
  return null;
}
