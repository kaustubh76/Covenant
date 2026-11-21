"use client";

// The landing page's vault, read live from Base Sepolia whatever network the rest of the app is on: the lens's snapshot
// of the deployment's first launch, at the block it was read, read again every 30 seconds while the page is in view. A
// read that fails leaves the last good one on screen, with its block and age, and says why.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { type ChainCtx, createChainCtx } from "@/chain/client";
import type { Network } from "@/chain/network";
import { type VaultView, readVaultView } from "@/chain/view";

export interface LiveVault {
  /** The read-only context the view was read with, for simulations against the same chain. */
  ctx: ChainCtx | null;
  view: VaultView | null;
  /** When `view` was read, in ms since the epoch. */
  readAt: number | null;
  /** Why the latest read failed, while it keeps failing; null once one succeeds. */
  error: string | null;
  reading: boolean;
  retry(): void;
}

/** How often the vault is read again while the page is in view. */
export const EVERY_MS = 30_000;

export function useLiveVault(vault: Address | null): LiveVault {
  const [state, setState] = useState<Omit<LiveVault, "retry">>({ ctx: null, view: null, readAt: null, error: null, reading: !!vault });
  const ctx = useRef<ChainCtx | null>(null);
  const seq = useRef(0);
  // one read at a time: on a slow RPC the next tick waits for this one rather than stack another
  const inFlight = useRef(false);

  const read = useCallback(async () => {
    if (!vault || inFlight.current) return;
    inFlight.current = true;
    const mine = ++seq.current;
    setState((s) => ({ ...s, reading: true }));
    try {
      if (!ctx.current) {
        const res = await fetch("/api/chain?net=base-sepolia", { cache: "no-store" }).then(
          (r) => r.json() as Promise<{ state: "ready"; network: Network } | { state: "offline"; reason: string }>,
        );
        // the server's reason, first sentence only: what follows is a deploy hint for developers, not for visitors
        if (res.state !== "ready") throw new Error(res.reason.split(/(?<=\.)\s/)[0]);
        ctx.current = createChainCtx(res.network);
      }
      const view = await readVaultView(ctx.current, vault);
      if (mine === seq.current) setState({ ctx: ctx.current, view, readAt: Date.now(), error: null, reading: false });
    } catch (e) {
      if (mine === seq.current) setState((s) => ({ ...s, ctx: ctx.current, error: e instanceof Error ? e.message.split("\n")[0] : String(e), reading: false }));
    } finally {
      inFlight.current = false;
    }
  }, [vault]);

  useEffect(() => {
    if (!vault) return;
    void read();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, EVERY_MS);
    // back to the tab: read at once rather than show a figure from before it was hidden
    const onShow = () => document.visibilityState === "visible" && void read();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [vault, read]);

  return { ...state, retry: () => void read() };
}

/** How long ago `at` was, in words: "just now", "40 s ago", "3 min ago". */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 90) return `${s} s ago`;
  return `${Math.round(s / 60)} min ago`;
}
