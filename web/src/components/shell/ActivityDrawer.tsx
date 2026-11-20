"use client";

// Every page's record of what was tried and what the chain said, not only the vault page's: a pill at the bottom left
// opens the activity feed in a panel, with this app's attempts (refusals included) and the vault's events.

import { AnimatePresence, motion } from "framer-motion";
import { History, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ActivityFeed } from "@/components/covenant/ActivityFeed";
import { useChain } from "@/store/chain";

export function ActivityDrawer({ raised }: { raised: boolean }) {
  const [open, setOpen] = useState(false);
  const count = useChain((s) => s.log.length);
  const ready = useChain((s) => s.status === "ready");
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!ready) return null;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`fixed left-4 z-40 flex items-center gap-2 rounded-full border border-line-strong bg-raised/95 px-2.5 py-2 sm:px-3.5 text-[12.5px] text-ink shadow-lg backdrop-blur transition-colors hover:border-muted ${raised ? "bottom-[72px]" : "bottom-5"}`}
        aria-label={`Activity: ${count} from this session`}
      >
        <History size={14} strokeWidth={1.8} />
        {/* icon only on a phone, where the pill floats over the page */}
        <span className="hidden sm:inline">Activity</span>
        {count > 0 && <span className="num rounded-full bg-ink px-1.5 text-[11px] leading-[18px] text-bg">{count}</span>}
      </button>
      <AnimatePresence>
        {open && (
          <>
            <motion.div className="fixed inset-0 z-50 bg-black/40" onClick={() => setOpen(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            <motion.aside
              role="dialog"
              aria-label="Activity"
              className="fixed inset-y-0 right-0 z-50 w-[min(440px,100vw)] overflow-y-auto border-l border-line bg-surface px-5 py-6"
              initial={{ x: 32, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 32, opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="eyebrow">Activity</div>
                  <h2 className="mt-1 text-[17px] font-medium text-ink">What was tried, and what the chain said</h2>
                </div>
                <button onClick={() => setOpen(false)} aria-label="Close" className="rounded p-1.5 text-faint transition-colors hover:bg-bg hover:text-ink">
                  <X size={16} strokeWidth={1.8} />
                </button>
              </div>
              <div className="mt-4">
                <ActivityFeed limit={40} />
              </div>
              <Link href="/ledger" onClick={() => setOpen(false)} className="mt-4 block border-t border-line pt-4 text-[13px] text-muted underline-offset-2 hover:text-ink hover:underline">
                Every transaction on Base Sepolia, and what each function and attack did there →
              </Link>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
