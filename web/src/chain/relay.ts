// The backend's relayer (backend/src/relay): real Base Sepolia transactions for a visitor without a wallet, sent from the
// backend's own small key, for a fixed list of actions. The answer carries the transaction's hash.

import type { Address, Hex } from "viem";

export type RelayAction = "poke" | "collectFees" | "restore" | "sell" | "buy" | "drip";

export interface RelayStatus {
  enabled: boolean;
  address?: Address;
  balanceEth?: number | null;
  spentTodayEth?: number;
  dailyBudgetEth?: number;
}

export type Relayed =
  | { ok: true; hash: Hex; status: "success" | "reverted" | "pending"; title: string }
  | { ok: false; status: number; reason: string; revert?: string };

export async function relayStatus(backend: string): Promise<RelayStatus> {
  try {
    const res = await fetch(`${backend}/v1/relay`, { signal: AbortSignal.timeout(10_000) });
    return res.ok ? ((await res.json()) as RelayStatus) : { enabled: false };
  } catch {
    return { enabled: false };
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
  const data = (await res.json().catch(() => ({}))) as { hash?: Hex; status?: "success" | "reverted" | "pending"; title?: string; error?: string };
  if (!res.ok || !data.hash) {
    const reason = data.error ?? `The backend answered ${res.status}.`;
    return { ok: false, status: res.status, reason, revert: res.status === 409 ? /would revert: ([A-Za-z_][A-Za-z0-9_]*\([^)]*\))/.exec(reason)?.[1] : undefined };
  }
  return { ok: true, hash: data.hash, status: data.status ?? "success", title: data.title ?? action };
}
