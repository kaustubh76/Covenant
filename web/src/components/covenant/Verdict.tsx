"use client";

import clsx from "clsx";
import { IDLE_BPS, IDLE_FLOOR_WEI, RESHAPE_MAX_RANGES } from "@/chain/constants";
import { motion } from "framer-motion";
import { Check, Minus, X } from "lucide-react";
import { ACTOR_LABEL } from "@/chain/accounts";
import type { Beat } from "@/chain/beat";
import type { DecodedError } from "@/chain/errors";
import { FAILURE_LABEL, isFailureKind } from "@/chain/failure";
import type { Preflight } from "@/chain/preflight";
import { priceAt } from "@/chain/price";
import type { VaultView } from "@/chain/view";
import { Tag } from "@/components/ui";
import { pct, price } from "@/lib/format";

type State = "pass" | "fail" | "skip" | "pending";

function Line({ state, name, children }: { state: State; name: string; children: React.ReactNode }) {
  return (
    <li className={clsx("flex items-start gap-3 border-b border-line py-3 last:border-b-0", state === "skip" && "opacity-55")}>
      <span
        className={clsx(
          "mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full",
          state === "pass" && "bg-pass/15 text-pass",
          state === "fail" && "bg-breach/15 text-breach",
          (state === "skip" || state === "pending") && "bg-line text-faint",
        )}
      >
        {state === "pass" ? <Check size={12} strokeWidth={2.5} /> : state === "fail" ? <X size={12} strokeWidth={2.5} /> : <Minus size={12} strokeWidth={2.5} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium text-ink">{name}</span>
          {state === "skip" && <span className="text-[11px] uppercase tracking-[0.08em] text-faint">not reached</span>}
        </div>
        <div className="mt-0.5 text-[13px] leading-snug text-muted">{children}</div>
      </div>
    </li>
  );
}

// The order CovenantVault.reshape checks things in (src/CovenantVault.sol, src/vault/VaultOps.sol): the curator, the
// guard, the cuts (CovenantLogic.cutFraction), Pace, the legs (validateLegs), then the layout the reshape leaves.
type CheckKey = "curator" | "guard" | "cuts" | "pace" | "layout" | "ceiling" | "conservation" | "rangeCap" | "support";
const ORDER: CheckKey[] = ["curator", "guard", "cuts", "pace", "layout", "ceiling", "conservation", "rangeCap", "support"];
const CHECK_OF: Record<string, CheckKey> = {
  NotCurator: "curator",
  NotAdopted: "curator",
  Expired: "curator",
  PriceGuard: "guard",
  InvalidCut: "cuts",
  PaceExceeded: "pace",
  InvalidLeg: "layout",
  SharesExceedWhole: "layout",
  SinkStraddlesPrice: "layout",
  BidAboveCeiling: "ceiling",
  IdleTooLarge: "conservation",
  TooManyRanges: "rangeCap",
  SupportBroken: "support",
};

const n = (v: unknown) => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));

/** Every reshape check, in the contract's order, from a pre-flight of the exact transaction. */
/**
 * `moved` is the share of the vault the reshape moves: the simulated Reshaped event's own figure when `measured`, else
 * the page's estimate (the reshape reverted, so the contract did not measure it), which the line says.
 */
export function ReshapeVerdict({ before, pre, moved, measured = false, loading }: { before: VaultView; pre: Preflight | null; moved: number; measured?: boolean; loading?: boolean }) {
  const movedText = measured ? <span className="num text-ink">{pct(moved * 1e4)}</span> : <>about <span className="num text-ink">{pct(moved * 1e4)}</span> (an estimate)</>;
  const failed = pre && !pre.ok ? CHECK_OF[pre.error?.name ?? ""] : undefined;
  const failedAt = failed ? ORDER.indexOf(failed) : -1;
  // The network did not answer (or the wallet, or the node refused it): no check was reached, and none failed.
  const unanswered = !!pre && !pre.ok && isFailureKind(pre.error?.name);
  const state = (k: CheckKey): State => {
    if (!pre || loading || unanswered) return "pending";
    if (pre.ok) return "pass";
    if (failedAt < 0) return "skip";
    const i = ORDER.indexOf(k);
    return i < failedAt ? "pass" : i === failedAt ? "fail" : "skip";
  };
  const e = pre?.error;
  const after = pre?.after;
  const v = before;
  return (
    <div>
      <ul>
        {failed === "curator" && (
          <Line state="fail" name="Curator only">
            You are not the named curator for this vault. Switch to the curator in the top bar.
          </Line>
        )}
        <Line state={state("guard")} name="Guard">
          Spot is <span className="num text-ink">{Math.round(v.guard.diff)}</span> ticks from the TWAP. Limit <span className="num text-ink">{v.guard.limit}</span>.
        </Line>
        {failed === "cuts" && e && (
          <Line state="fail" name="Cuts">
            {e.reason}
          </Line>
        )}
        <Line state={state("pace")} name="Pace">
          {failed === "pace" && e ? (
            <>
              This moves <span className="num text-breach">{pct(n(e.args[0]) / 1e5)}</span> of the vault, but Pace lets only <span className="num text-ink">{pct(n(e.args[1]) / 1e5)}</span> move now.
            </>
          ) : v.pace.setup ? (
            <>Setup epoch: not enforced. This would move {movedText} of the vault&apos;s value.</>
          ) : (
            <>
              This would move {movedText} of the vault&apos;s value. Up to <span className="num text-ink">{pct(v.pace.available * 1e4)}</span> may move now.
            </>
          )}
        </Line>
        <Line state={state("layout")} name="Layout">
          {failed === "layout" && e ? e.reason : <>Cuts name real ranges, legs are aligned to the tick spacing, and no currency is over-allocated.</>}
        </Line>
        <Line state={state("ceiling")} name="Bid ceiling">
          {failed === "ceiling" && e ? (
            e.reason
          ) : (
            <>
              Every bid stays at or below <span className="num text-ink">{price(priceAt(v.ceiling))}</span>, the Anchor plus the guard.
            </>
          )}
        </Line>
        <Line state={state("conservation")} name="Conservation">
          {failed === "conservation" && e ? (
            e.reason
          ) : (
            <>
              Everything lifted goes back into the pool: at most {pct(IDLE_BPS, 1)} of what the reshape handles, or {IDLE_FLOOR_WEI.toString()} wei if that is more, may sit idle.
            </>
          )}
        </Line>
        {(failed === "rangeCap" || (after && after.ranges.length > 10)) && (
          <Line state={state("rangeCap")} name="Range cap">
            {failed === "rangeCap" && e ? (
              e.reason
            ) : (
              <>
                <span className="num text-ink">{after?.ranges.length}</span> ranges after this. A reshape may leave {RESHAPE_MAX_RANGES}.
              </>
            )}
          </Line>
        )}
        <Line state={state("support")} name="Support">
          {failed === "support" && e ? (
            <>
              <span className="num text-breach">{pct(n(e.args[0]))}</span> of quote in the band after this. Needs <span className="num text-ink">{pct(v.support.need, 0)}</span>.
            </>
          ) : after ? (
            <>
              <span className="num text-ink">{pct(after.support.have)}</span> of quote in the band after this. Needs <span className="num text-ink">{pct(v.support.need, 0)}</span>.
            </>
          ) : (
            <>
              At least <span className="num text-ink">{pct(v.support.need, 0)}</span> of the quote must bid inside the band afterwards.
            </>
          )}
        </Line>
      </ul>
      <div className={clsx("mt-3 rounded-md border px-3.5 py-3", !pre || loading || unanswered ? "border-line" : pre.ok ? "border-pass/40 bg-pass/5" : "border-breach/50 bg-breach/5")}>
        {!pre || loading ? (
          <>
            <div className="eyebrow">Asking the contract</div>
            <div className="mt-1 text-[13px] text-muted">Simulating this exact reshape in the next block…</div>
          </>
        ) : unanswered && pre.error ? (
          <>
            <div className="eyebrow">{FAILURE_LABEL[pre.error.name as keyof typeof FAILURE_LABEL]}</div>
            <div className="mt-1 text-[13px] text-muted">{pre.error.reason} The next block checks again.</div>
          </>
        ) : pre.ok ? (
          <>
            <div className="eyebrow !text-pass">Would settle</div>
            <div className="mt-1 text-[13px] text-muted">The contract accepts it. The pool would be reshaped in one transaction.</div>
          </>
        ) : (
          <>
            <div className="eyebrow !text-breach">Would revert</div>
            <div className="num mt-1 break-words text-[13px] text-breach">{e?.signature}</div>
          </>
        )}
      </div>
    </div>
  );
}

/** What the chain said back. */
/** A refusal. `label` says whether it happened ("Reverted", the default) or is what a simulation says would happen. */
export function RevertCard({ error, className, label = "Reverted" }: { error: Pick<DecodedError, "signature" | "rule" | "reason">; className?: string; label?: "Reverted" | "Would revert" }) {
  return (
    <div className={clsx("refuse rounded-md border border-breach/50 bg-breach/5 px-4 py-3", className)}>
      <div className="flex items-center justify-between gap-3">
        <span className="eyebrow !text-breach">{label}</span>
        <Tag tone="breach">{error.rule}</Tag>
      </div>
      <div className="num mt-1.5 break-words text-sm text-breach">{error.signature}</div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{error.reason}</p>
    </div>
  );
}

/** A sequence of attempts and how each ended. */
export function BeatList({
  beats,
  compact,
  stagger = 0,
}: {
  beats: (Pick<Beat, "actor" | "title" | "detail" | "ok" | "hash"> & { error?: Pick<DecodedError, "signature" | "reason"> })[];
  compact?: boolean;
  /** Seconds between rows as they appear. 0 shows them all at once. */
  stagger?: number;
}) {
  return (
    <ol className="space-y-0">
      {beats.map((b, i) => (
        <motion.li
          key={i}
          initial={stagger ? { opacity: 0, y: 8 } : false}
          animate={stagger ? (b.ok ? { opacity: 1, y: 0 } : { opacity: 1, y: 0, x: [0, -6, 5, -3, 2, 0] }) : undefined}
          transition={{ delay: i * stagger, duration: b.ok ? 0.35 : 0.5, ease: "easeOut" }}
          className="flex gap-3 border-b border-line py-3 last:border-b-0"
          title={b.hash ? `tx ${b.hash}` : undefined}
        >
          <span className={clsx("mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full", b.ok ? "bg-pass/15 text-pass" : "bg-breach/15 text-breach")}>
            {b.ok ? <Check size={12} strokeWidth={2.5} /> : <X size={12} strokeWidth={2.5} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm text-ink">{b.title}</span>
              <span className="text-xs text-faint">{ACTOR_LABEL[b.actor]}</span>
            </div>
            {b.ok
              ? b.detail && <div className="mt-0.5 text-[13px] leading-snug text-muted">{b.detail}</div>
              : b.error && (
                  <>
                    <div className="num mt-1 break-words text-[13px] text-breach">{b.error.signature}</div>
                    {!compact && <div className="mt-0.5 text-[13px] leading-snug text-muted">{b.error.reason}</div>}
                  </>
                )}
          </div>
        </motion.li>
      ))}
    </ol>
  );
}
