// The backend's relayer (backend/src/relay): real Base Sepolia transactions for a visitor without a wallet, sent from the
// backend's own small key, for a fixed list of actions. The answer carries the transaction's hash.

import type { Address, Hex } from "viem";

export type RelayAction = "poke" | "collectFees" | "restore" | "sell" | "buy" | "drip";

export interface RelayStatus {
  enabled: boolean;
  /** Why it is off, when the backend says. */
  reason?: string;
  address?: Address;
  balanceEth?: number | null;
  spentTodayEth?: number;
  dailyBudgetEth?: number;
  /** The recorded vaults it acts on; it refuses any other. */
  vaults?: Address[];
}

export type Relayed =
  | { ok: true; hash: Hex; hashes: Hex[]; status: "success" | "reverted" | "pending"; title: string }
  | { ok: false; status: number; reason: string; revert?: string };

/**
 * The relayer's status, or null when the backend did not answer: a free backend sleeps when idle and takes about a
 * minute to wake, so no answer means "not yet", not "off".
 */
export async function relayStatus(backend: string): Promise<RelayStatus | null> {
  try {
    const res = await fetch(`${backend}/v1/relay`, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) return (await res.json()) as RelayStatus;
    return res.status >= 500 || res.status === 429 ? null : { enabled: false };
  } catch {
    return null;
  }
}

/** Ask the relayer to send `action`. A refusal its simulation found names the contract's error in `revert`. */
export async function relay(backend: string, action: RelayAction, body: { vault?: Address; to?: Address; indices?: number[] } = {}): Promise<Relayed> {
  let res: Response;
  try {
    res = await fetch(`${backend}/v1/relay/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(150_000),
    });
  } catch {
    return { ok: false, status: 0, reason: "The backend did not answer. It sleeps when idle and takes about a minute to wake: try again shortly." };
  }
  const data = (await res.json().catch(() => ({}))) as { hash?: Hex; hashes?: Hex[]; status?: "success" | "reverted" | "pending"; title?: string; error?: string };
  if (!res.ok || !data.hash) {
    const reason = data.error ?? `The backend answered ${res.status}.`;
    return { ok: false, status: res.status, reason, revert: res.status === 409 ? /would revert: ([A-Za-z_][A-Za-z0-9_]*\([^)]*\))/.exec(reason)?.[1] : undefined };
  }
  return { ok: true, hash: data.hash, hashes: data.hashes?.length ? data.hashes : [data.hash], status: data.status ?? "success", title: data.title ?? action };
}
