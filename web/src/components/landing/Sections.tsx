"use client";

import clsx from "clsx";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ATTACKS } from "@/chain/scenarios/attacks";
import { Button } from "@/components/ui";
import { duration } from "@/lib/format";
import { RULES } from "@/lib/rules";
import type { LiveAttackTx, LiveRefusal } from "@/server/live";
import { day } from "./Live";
import { Reveal } from "./motion";

// ------------------------------------------------------------------ revert tape
/** The contracts' real refusals on the live chain, each a transaction on record, linked to the explorer. */
export function RevertTape({ refusals, explorer, network, asOf }: { refusals: LiveRefusal[]; explorer: string; network: string; asOf: { time: string } | null }) {
  const row = (hidden?: boolean) => (
    <div className="flex shrink-0 items-center" aria-hidden={hidden}>
      {refusals.map((r) => (
        <a
          key={r.hash}
          href={`${explorer}/tx/${r.hash}`}
          target="_blank"
          rel="noreferrer"
          tabIndex={hidden ? -1 : undefined}
          title={`${r.symbol ? `${r.symbol} · ` : ""}${day(r.time)} · ${r.hash}`}
          className="num flex items-center gap-3 whitespace-nowrap px-6 text-[13px] text-muted hover:text-ink"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-breach" />
          <span className="text-faint">reverted</span>
          {r.error}
        </a>
      ))}
    </div>
  );
  const first = refusals[0]?.time;
  const lastTime = refusals[refusals.length - 1]?.time;
  return (
    <div>
      <div className="tape border-y border-line bg-surface/60 py-3.5" aria-label={`Transactions the contracts refused on ${network}`}>
        <div className="tape-track flex w-max">
          {row()}
          {row(true)}
        </div>
      </div>
      <p className="mx-auto mt-2 max-w-6xl px-5 text-center text-[12px] text-faint">
        {refusals.length} transactions the contracts refused on {network}
        {first && lastTime ? `, ${day(first)} to ${day(lastTime)}` : ""}, each on record and linked{asOf ? ` (the record was read back from the chain on ${day(asOf.time)})` : ""}.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ the problem, drawn
function Diagram({ mode }: { mode: "locked" | "managed" | "covenant" }) {
  const reduce = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Reduced motion holds the frame that tells the story (price has moved, liquidity has or hasn't followed).
  const still = mounted && !!reduce;
  const at = (frames: number[]) => (still ? frames[3] : frames);
  const D = 7;
  const loop = still ? { duration: 0 } : { duration: D, repeat: Infinity, ease: "easeInOut" as const };
  const priceX = [70, 70, 250, 250, 70];
  const times = [0, 0.12, 0.55, 0.9, 1];
  const blockX = mode === "locked" ? [22, 22, 22, 22, 22] : [22, 22, 202, 202, 22];
  const blockO = mode === "managed" ? [1, 1, 1, 0, 0] : [1, 1, 1, 1, 1];
  const blockY = mode === "managed" ? [0, 0, 0, -46, -46] : [0, 0, 0, 0, 0];
  const color = mode === "covenant" ? "var(--support)" : "var(--muted)";
  return (
    <svg viewBox="0 0 320 130" className="w-full" role="img" aria-label={`${mode} liquidity as the price moves`}>
      {mode === "covenant" && <rect x={8} y={18} width={304} height={88} rx={6} fill="none" stroke="var(--accent)" strokeOpacity={0.45} strokeDasharray="3 4" />}
      <line x1={12} x2={308} y1={98} y2={98} stroke="var(--line-strong)" />
      <motion.g animate={{ x: at(blockX), opacity: at(blockO), y: at(blockY) }} initial={{ x: blockX[0] }} transition={{ ...loop, times }}>
        <rect x={0} y={44} width={48} height={54} fill={color} opacity={0.25} />
        <rect x={0} y={44} width={48} height={2} fill={color} />
      </motion.g>
      <motion.g animate={{ x: at(priceX) }} initial={{ x: priceX[0] }} transition={{ ...loop, times }}>
        <line x1={0} x2={0} y1={26} y2={98} stroke="var(--ink)" />
        <text x={0} y={20} textAnchor="middle" fontSize={10} fill="var(--ink)" className="num">
          price
        </text>
      </motion.g>
      {mode === "managed" && (
        <motion.text x={226} y={60} textAnchor="middle" fontSize={11} fill="var(--breach)" className="num" animate={{ opacity: at([0, 0, 0, 1, 0]) }} transition={{ ...loop, times }}>
          withdrawn
        </motion.text>
      )}
      {mode === "locked" && (
        <motion.text x={250} y={118} textAnchor="middle" fontSize={11} fill="var(--breach)" className="num" animate={{ opacity: at([0, 0, 1, 1, 0]) }} transition={{ ...loop, times }}>
          nothing here
        </motion.text>
      )}
    </svg>
  );
}

export function ProblemTriptych() {
  const items = [
    { mode: "locked" as const, name: "Locked", verdict: "Safe, and inert.", body: "Nobody can pull it. But when the price moves, the liquidity stays where it was and the market trades through thin air." },
    { mode: "managed" as const, name: "Managed", verdict: "Useful, on trust.", body: "A manager keeps depth at the price. Whoever can move liquidity can also remove it, or park it where it never trades." },
    { mode: "covenant" as const, name: "Covenant", verdict: "Both, enforced.", body: "The curator moves liquidity along the price axis. The pool checks every move, so it can follow the price but cannot leave." },
  ];
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {items.map((it, i) => (
        <Reveal key={it.name} delay={i * 0.08}>
          <div className={clsx("flex h-full flex-col rounded-xl border p-5 md:p-6", it.mode === "covenant" ? "border-accent/50 bg-raised" : "border-line bg-surface")}>
            <div className="rounded-lg border border-line bg-bg/60 p-2">
              <Diagram mode={it.mode} />
            </div>
            <div className="mt-5 flex items-baseline justify-between gap-3">
              <div className={clsx("display text-[30px] leading-none", it.mode === "covenant" ? "text-accent" : "text-ink")}>{it.name}</div>
              <div className="text-[13px] font-medium text-ink">{it.verdict}</div>
            </div>
            <p className="mt-3 text-[14.5px] leading-relaxed text-muted">{it.body}</p>
          </div>
        </Reveal>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ rule explorer
/**
 * The five rules, each with the attack it stops and the transactions that played that attack on the live chain (from the
 * ledger on record). `attacks` is null in a copy with no live deployment: the attack lab runs them instead.
 */
export function RuleExplorer({ attacks, explorer, network }: { attacks: Record<string, LiveAttackTx[]> | null; explorer: string; network: string }) {
  const [key, setKey] = useState<string>(RULES[0].key);
  const [shown, setShown] = useState(false);
  const rule = RULES.find((r) => r.key === key)!;
  const attack = ATTACKS.find((a) => a.id === rule.attack)!;
  const txs = attacks?.[rule.attack] ?? [];
  const pick = (k: string) => {
    setKey(k);
    setShown(false);
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]">
      <div role="tablist" aria-label="Rules" className="scroll-x flex gap-2 lg:flex-col">
        {RULES.map((r, i) => (
          <button
            key={r.key}
            role="tab"
            aria-selected={r.key === key}
            onClick={() => pick(r.key)}
            className={clsx("group min-w-[220px] shrink-0 rounded-xl border p-5 text-left transition-colors lg:min-w-0", r.key === key ? "border-accent/60 bg-raised" : "border-line bg-surface hover:border-line-strong")}
          >
            <div className="flex items-baseline justify-between">
              <span className="num text-xs text-faint">0{i + 1}</span>
              <span className={clsx("h-1.5 w-1.5 rounded-full transition-colors", r.key === key ? "bg-accent" : "bg-line-strong")} />
            </div>
            <div className="mt-2 text-[18px] font-medium text-ink">{r.name}</div>
            <div className="display mt-0.5 text-[19px] italic text-accent">{r.line}</div>
          </button>
        ))}
      </div>

      <div role="tabpanel" className="flex flex-col rounded-xl border border-line-strong bg-surface p-6 md:p-8">
        <motion.div key={key} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <div className="display text-[34px] leading-tight text-ink">{rule.name}</div>
          <p className="mt-3 max-w-xl text-[16px] leading-relaxed text-muted">{rule.body}</p>
          <div className="mt-7 rounded-lg border border-line bg-bg/50 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 max-w-md">
                <div className="eyebrow">The attack it stops · {attack.who}</div>
                <div className="mt-1 text-[16px] font-medium text-ink">{attack.title}</div>
                <p className="mt-1 text-[14px] leading-relaxed text-muted">{attack.story}</p>
              </div>
              {txs.length > 0 ? (
                <Button variant={shown ? "ghost" : "danger"} onClick={() => setShown((x) => !x)}>
                  {shown ? "Hide" : `See it played on ${network}`}
                </Button>
              ) : (
                <Link href="/attacks">
                  <Button variant="danger">Run it in the attack lab</Button>
                </Link>
              )}
            </div>
            {shown && txs.length > 0 && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4 border-t border-line pt-3">
                <ul className="grid gap-1.5">
                  {txs.map((t) => (
                    <li key={t.hash} className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-baseline gap-x-2.5 text-[13px]">
                      <span className={clsx("h-1.5 w-1.5 rounded-full", t.status === "reverted" ? "bg-breach" : "bg-pass")} aria-hidden />
                      <span className="min-w-0 truncate">
                        <span className={t.status === "reverted" ? "num text-breach" : "text-ink"}>{t.status === "reverted" ? (t.error ?? "Reverted") : "Settled"}</span>
                        <span className="text-faint">
                          {" "}
                          · {t.symbol}
                          {t.time ? ` · ${day(t.time)}` : ""}
                        </span>
                      </span>
                      <a href={`${explorer}/tx/${t.hash}`} target="_blank" rel="noreferrer" className="num text-[12px] text-faint underline-offset-2 hover:text-ink hover:underline">
                        {t.hash.slice(0, 10)}… ↗
                      </a>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex flex-wrap items-baseline justify-between gap-3 text-[13px]">
                  <span className="text-muted">Transactions on record on {network}: the settled ones set the attack up, the refused ones are the contracts saying no.</span>
                  <Link href="/attacks" className="text-accent underline-offset-4 hover:underline">
                    Check it live in the attack lab →
                  </Link>
                </div>
              </motion.div>
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ lifecycle
const VERBS = [
  { verb: "Seed", when: "At launch", body: "The first reshape reads the auction's outbid demand, which the CCA keeps on-chain, and places support where those buyers said they would buy." },
  { verb: "Reshape", when: "Each epoch after", body: "The curator re-centres liquidity as the price moves, inside the pace cap, with every rule checked in the same transaction." },
  { verb: "Enforce", when: "Always", body: "If a sell-off strands the support below its band, any address restores it for a bounty. No rule depends on the curator behaving." },
  { verb: "Release", when: "After the lock", body: "The issuer's principal vests in a straight line. Outside LPs were never locked and leave in kind whenever they like." },
];

/** The four stages. `epoch` is the live vault's epoch length, in seconds, which sets the reshape's cadence; null until read. */
export function Lifecycle({ epoch, symbol }: { epoch: number | null; symbol: string }) {
  const when = (v: (typeof VERBS)[number]) => (v.verb === "Reshape" && epoch ? `Every ${duration(epoch)} after, on ${symbol}` : v.when);
  return (
    <div className="relative">
      <motion.div
        className="absolute left-0 right-0 top-[9px] hidden h-px origin-left bg-accent/60 md:block"
        initial={{ scaleX: 0 }}
        whileInView={{ scaleX: 1 }}
        viewport={{ once: true, margin: "-20% 0px" }}
        transition={{ duration: 1.6, ease: [0.2, 0.7, 0.2, 1] }}
      />
      <div className="grid gap-8 md:grid-cols-4 md:gap-6">
        {VERBS.map((v, i) => (
          <Reveal key={v.verb} delay={0.15 + i * 0.18}>
            <div className="relative">
              <span className="relative z-10 block h-[19px] w-[19px] rounded-full border border-accent bg-bg">
                <span className="absolute inset-[5px] rounded-full bg-accent" />
              </span>
              <div className="eyebrow mt-5">{when(v)}</div>
              <div className="display mt-1 text-[38px] leading-none text-ink">{v.verb}</div>
              <p className="mt-3 text-[14.5px] leading-relaxed text-muted">{v.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ seats
const SEATS = [
  { href: "/launch", who: "Issuers", line: "Commit the terms, run the auction, seed the pool from its losing bids." },
  { href: "/curate", who: "Curators", line: "Reshape liquidity with every rule checked before you sign." },
  { href: "/vault", who: "Holders", line: "See where the liquidity sits and whether each promise is holding." },
  { href: "/keep", who: "Keepers", line: "Restore lapsed support from any address and collect the bounty." },
  { href: "/provide", who: "Outside LPs", line: "Deposit beside the issuer in kind, and leave when you like." },
];

export function Seats() {
  const track = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {SEATS.map((c, i) => (
        <Reveal key={c.href} delay={i * 0.06}>
          <Link href={c.href} onMouseMove={track} className="spot group flex h-full flex-col rounded-xl border border-line bg-surface p-5 transition-colors hover:border-line-strong">
            <div className="display text-[28px] text-ink">{c.who}</div>
            <p className="mt-2 flex-1 text-[13.5px] leading-relaxed text-muted">{c.line}</p>
            <ArrowRight size={16} className="mt-5 text-faint transition-all group-hover:translate-x-1 group-hover:text-accent" />
          </Link>
        </Reveal>
      ))}
    </div>
  );
}
