// What this browser has sent on a public chain: each transaction's hash, what it was and how it ended, kept per chain in
// localStorage so a reload, or another page, can still link to it. Only a convenience: the chain itself is the record,
// and the /ledger page shows what the project's own keys and the relayer sent for everyone.

import type { Hex } from "viem";
import type { Beat } from "@/chain/beat";

export interface SentTx {
  hash: Hex;
  title: string;
  ok: boolean;
  /** Who sent it, as the activity feed says: "You", or "Covenant's relayer". */
  by?: string;
  error?: string;
  /** When it was recorded here, ms. */
  at: number;
}

const KEY = (chainId: number) => `covenant.sent.${chainId}`;
const LIMIT = 50;

/**
 * Whether a network's sends are kept: only where a public explorer can show them later. The rehearsal fork shares Base
 * Sepolia's chain id but mines only on this machine, so its sends would be listed as Base Sepolia's, linked to nothing.
 */
export function keepsSent(caps: { explorer?: string }): boolean {
  return !!caps.explorer;
}

export function readSent(chainId: number): SentTx[] {
  try {
    const raw = localStorage.getItem(KEY(chainId));
    const list = raw ? (JSON.parse(raw) as SentTx[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Keep the beats that carry a transaction hash, newest first, once each. */
export function rememberSent(chainId: number, beats: Beat[]) {
  const fresh = beats.filter((b) => b.source === "app" && b.hash);
  if (!fresh.length) return;
  try {
    const list = readSent(chainId);
    const known = new Set(list.map((t) => t.hash));
    const add: SentTx[] = fresh
      .filter((b) => !known.has(b.hash as Hex))
      .map((b) => ({ hash: b.hash as Hex, title: b.title, ok: b.ok, ...(b.by ? { by: b.by } : {}), ...(b.error ? { error: b.error.signature } : {}), at: Date.now() }));
    if (!add.length) return;
    localStorage.setItem(KEY(chainId), JSON.stringify([...add, ...list].slice(0, LIMIT)));
    window.dispatchEvent(new Event("covenant:sent"));
  } catch {
    /* private mode or storage full: the activity feed still has it for this visit */
  }
}
