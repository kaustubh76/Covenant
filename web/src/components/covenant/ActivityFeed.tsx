"use client";

import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { useMemo } from "react";
import { ACTOR_LABEL } from "@/chain/accounts";
import { FAILURE_LABEL, isFailureKind } from "@/chain/failure";
import { explorerTx } from "@/chain/network";
import { duration } from "@/lib/format";
import { feed, useChain } from "@/store/chain";

/** What has been tried and what the contract said: this app's attempts, refusals included, and the vault's events. */
export function ActivityFeed({ limit = 8 }: { limit?: number }) {
  const log = useChain((s) => s.log);
  const history = useChain((s) => s.history);
  const launched = useChain((s) => s.view?.lock.adoptedAt ?? 0);
  const net = useChain((s) => s.net);
  const items = useMemo(() => feed(log, history, limit), [log, history, limit]);
  if (!items.length) {
    return <p className="py-6 text-center text-[13px] text-muted">Nothing has happened yet. Use the controls at the bottom of the screen to move the market, or pick a role and act.</p>;
  }
  const when = (at: number) => (launched && at ? `${at >= launched ? "T+" : "T−"}${duration(Math.abs(at - launched))}` : "");
  return (
    <ul>
      <AnimatePresence initial={false}>
      {items.map((e) => (
        <motion.li key={e.id} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} className="grid grid-cols-[76px_1fr_auto] items-baseline gap-3 border-b border-line py-2.5 last:border-b-0" title={e.hash ? `tx ${e.hash}` : "Pre-flight only: nothing was sent"}>
          <span className="num text-xs text-faint">{when(e.at)}</span>
          <div className="min-w-0">
            <div className="truncate text-[13.5px] text-ink">{e.title}</div>
            <div className={clsx("truncate text-xs", e.ok ? "text-muted" : "num text-breach")}>{e.ok ? (e.detail ?? e.by ?? ACTOR_LABEL[e.actor]) : e.error?.signature}</div>
            {e.hash && net && explorerTx(net, e.hash) && (
              <a href={explorerTx(net, e.hash)} target="_blank" rel="noreferrer" className="num text-[11px] text-faint underline-offset-2 hover:text-ink hover:underline">
                tx {e.hash.slice(0, 10)}… ↗
              </a>
            )}
          </div>
          <span className={clsx("text-[11px] font-medium tracking-[0.08em]", e.ok && e.by ? "num normal-case" : "uppercase", e.ok ? "text-faint" : "text-breach")}>{e.ok ? (e.by ?? ACTOR_LABEL[e.actor]) : isFailureKind(e.error?.name) ? FAILURE_LABEL[e.error.name] : e.error?.name === "Error" ? "Failed" : "Reverted"}</span>
        </motion.li>
      ))}
      </AnimatePresence>
    </ul>
  );
}
