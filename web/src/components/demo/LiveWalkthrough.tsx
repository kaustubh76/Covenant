"use client";

import clsx from "clsx";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RuleRail } from "@/components/covenant/RuleRail";
import { ShapeChart, ShapeLegend } from "@/components/covenant/ShapeChart";
import { Backdrop } from "@/components/landing/FluidField";
import { day, shortHash, tidy } from "@/components/landing/Live";
import { Button, Panel, Tag } from "@/components/ui";
import type { LiveDeployment, LiveStep, LiveStory } from "@/server/live";
import { useChain } from "@/store/chain";

const nf = new Intl.NumberFormat("en-US");

/** What each step of the live proof demonstrates, and the rule doing the work. */
const NOTES: Record<string, { rule: string; text: string }> = {
  rug: {
    rule: "Support",
    text: "The curator asked the vault to park its buy support far below the price, where it would never trade. Support is checked on the layout a reshape would leave, so the chain refused the whole transaction. The assets never moved.",
  },
  deepen: {
    rule: "Conservation · Pace",
    text: "An honest reshape goes through: half the reserve, four bands deeper. Everything lifted went back in, support stayed above the minimum, and the move fit inside the epoch's Pace.",
  },
  crash: {
    rule: "The market",
    text: "The market sells the price down. The vault's bids absorb the sale, and as the average price catches up, support measured near it starts to lapse.",
  },
  restore: {
    rule: "Restore",
    text: "With support lapsed, an address holding no role called restore: the vault moved its own bids back under the price and paid the caller a bounty from its pool. Nobody had to trust the curator to do it.",
  },
  fees: {
    rule: "Fees",
    text: "Anyone can collect the swap fees. The principal's share goes to the treasury, and part of the quote tops up the bounty pool first.",
  },
  refill: {
    rule: "Bounty pool",
    text: "The issuer tops the bounty pool back up, so the next restore is paid for too.",
  },
  // the LP proof
  join: {
    rule: "Shares in kind",
    text: "An outside LP deposits ETH and tokens in exactly the proportion every range holds, and receives shares for that slice. There is no share price, so there is nothing to manipulate on the way in.",
  },
  buy: { rule: "The market", text: "The market buys through the pool. The trade crosses the vault's ranges and pays the pool fee, which accrues to every share." },
  sell: { rule: "The market", text: "And sells back about what it bought, paying the fee again." },
  collect: {
    rule: "Fees",
    text: "Anyone can collect the fees. The principal's part goes to the treasury; the outside shares' part stays in the vault, owed to them.",
  },
  claim: { rule: "Fees", text: "The LP claims the fees its shares earned while the market traded. The curator takes its cut and nothing else." },
  leave: {
    rule: "Exit in kind",
    text: "The LP burns every share and takes back the same slice of every range. Outside LPs are never locked, and the price guard never blocks an exit.",
  },
  // the management proof
  pump: { rule: "The market", text: "Someone pumps the price above the Anchor's ceiling and holds it there, the move that drained the prototype." },
  chase: {
    rule: "Anchor",
    text: "The curator tries to chase the pump with bids above the ceiling. The vault never bids above the Anchor plus the guard, so the chain refuses it: a pump cannot drag the vault's bids up under itself.",
  },
  recentre: { rule: "Anchor · Pace", text: "A re-centre capped at the ceiling settles. The curator can still manage the liquidity, inside the rules." },
  overpace: { rule: "Pace", text: "Moving the whole vault at once is refused: no more than the terms' Pace moves per epoch." },
};

/** The guided demo on a public chain: the live proof, step by step, each a real transaction on the explorer. */
export function LiveWalkthrough({ live }: { live: LiveDeployment }) {
  const told = live.stories.filter((s) => s.listed !== false);
  const stories: LiveStory[] = told.length ? told : [{ key: "covenant", title: "", vault: live.vault, symbol: live.symbol, steps: live.steps }];
  const [si, setSi] = useState(0);
  const story = stories[Math.min(si, stories.length - 1)];
  const steps = story.steps;
  const [at, setAt] = useState(0);
  const view = useChain((s) => s.view);
  const selectVault = useChain((s) => s.selectVault);
  const offersLocal = useChain((s) => s.networks.some((n) => n.key === "local"));
  const setNetwork = useChain((s) => s.setNetwork);
  const busy = useChain((s) => s.busy);
  const s: LiveStep = steps[Math.min(at, steps.length - 1)];
  const note = NOTES[s.key];
  const ours = view && view.address.toLowerCase() === story.vault.toLowerCase() ? view : null;
  const refusals = steps.filter((x) => x.status === "reverted").length;
  const pickStory = (i: number) => {
    setSi(i);
    setAt(0);
  };

  const forward = useCallback(() => setAt((i) => Math.min(i + 1, steps.length - 1)), [steps.length]);
  const back = useCallback(() => setAt((i) => Math.max(i - 1, 0)), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "ArrowRight") forward();
      else if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [forward, back]);

  const refused = s.status === "reverted";
  return (
    <div className="relative isolate">
      <Backdrop className="h-[440px]" />
      <div className="pb-6 pt-8 md:pt-12">
        <div className="eyebrow">
          Guided demo · on record on {live.network}
          {steps[0]?.time ? `, ${day(steps[0].time)}${steps[steps.length - 1]?.time && day(steps[steps.length - 1].time!) !== day(steps[0].time) ? ` to ${day(steps[steps.length - 1].time!)}` : ""}` : ""}
        </div>
        <h1 className="display mt-3 max-w-3xl text-[38px] leading-[1.04] text-ink md:text-[52px]">The covenant, proven in public.</h1>
        <p className="mt-4 max-w-2xl text-[15.5px] leading-relaxed text-muted">
          The ten-step demo needs a clock that jumps months and can rewind. {live.network} keeps real time, so here is the story as it actually happened on it,
          against the {story.symbol} vault: {steps.length} real transactions{refusals ? `, ${refusals} refused by the contracts` : ""}. Use the arrows, or ← and →.
        </p>
        {stories.length > 1 && (
          <div role="tablist" aria-label="Live proofs" className="mt-5 flex flex-wrap gap-2">
            {stories.map((x, i) => (
              <button
                key={x.key}
                type="button"
                role="tab"
                aria-selected={x === story}
                onClick={() => pickStory(i)}
                className={clsx(
                  "rounded-full border px-3.5 py-1.5 text-left text-[12.5px] transition-colors",
                  x === story ? "border-ink bg-raised text-ink" : "border-line-strong text-muted hover:border-muted hover:text-ink",
                )}
              >
                <span className="num text-faint">{x.symbol}</span> · {x.title}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mb-6 h-1 overflow-hidden rounded-full bg-line">
        <motion.div className="h-full bg-accent" animate={{ width: `${((at + 1) / steps.length) * 100}%` }} transition={{ duration: 0.4, ease: [0.2, 0.7, 0.2, 1] }} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
        <ol className="space-y-1.5">
          {steps.map((x, i) => (
            <li key={x.key}>
              <button
                type="button"
                onClick={() => setAt(i)}
                aria-current={i === at ? "step" : undefined}
                className={clsx(
                  "flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left text-[13.5px] transition-colors",
                  i === at ? "border-ink bg-raised text-ink" : "border-transparent text-muted hover:border-line-strong hover:text-ink",
                )}
              >
                <span className={clsx("h-2 w-2 shrink-0 rounded-full", x.status === "reverted" ? "bg-breach" : "bg-pass")} />
                <span className="num w-5 shrink-0 text-faint">{i + 1}</span>
                <span className="min-w-0 truncate">{x.title}</span>
              </button>
            </li>
          ))}
        </ol>

        <motion.div key={`${story.key}:${s.key}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="min-w-0">
          <Panel
            eyebrow={`Step ${at + 1} of ${steps.length} · ${note?.rule ?? ""}`}
            title={s.title}
            action={<Tag tone={refused ? "breach" : "pass"}>{refused ? "Reverted on chain" : "Mined"}</Tag>}
          >
            {s.error && <div className="num mb-3 truncate text-[14px] text-breach">{s.error}</div>}
            <p className="text-[15px] leading-relaxed text-ink [overflow-wrap:anywhere]">{tidy(s)}</p>
            {note && <p className="mt-3 text-[14px] leading-relaxed text-muted">{note.text}</p>}
            <a
              href={`${live.explorer}/tx/${s.hash}`}
              target="_blank"
              rel="noreferrer"
              className="num mt-4 inline-block max-w-full truncate text-[12.5px] text-faint underline-offset-2 hover:text-ink hover:underline"
            >
              {s.time ? `${day(s.time)} · ` : ""}block {nf.format(s.block)} · {shortHash(s.hash)} · view on the explorer ↗
            </a>
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <Button variant="ghost" disabled={at === 0} onClick={back}>
                <ArrowLeft size={15} /> Back
              </Button>
              {at < steps.length - 1 ? (
                <Button variant="primary" onClick={forward}>
                  Next <ArrowRight size={15} />
                </Button>
              ) : (
                <Link href="/vault?net=base-sepolia" onClick={() => void selectVault(story.vault)}>
                  <Button variant="primary">
                    Open the live vault <ArrowRight size={15} />
                  </Button>
                </Link>
              )}
            </div>
          </Panel>
        </motion.div>
      </div>

      <Panel
        className="mt-8"
        eyebrow={`The ${story.symbol} vault now`}
        title="Where its liquidity sits today, read from the chain"
        action={
          ours ? undefined : (
            <Button size="sm" onClick={() => void selectVault(story.vault)}>
              Show the {story.symbol} vault
            </Button>
          )
        }
      >
        {ours ? (
          <>
            <ShapeChart world={ours} height={280} />
            <div className="mt-3">
              <ShapeLegend />
            </div>
            <div className="mt-6">
              <RuleRail world={ours} />
            </div>
          </>
        ) : (
          <p className="py-6 text-center text-[13.5px] text-muted">Another vault is selected. Show the {story.symbol} vault to see the one this proof ran against.</p>
        )}
      </Panel>

      {offersLocal && (
        <p className="mt-6 text-center text-[13px] text-faint">
          The ten scripted steps, with the clock moved for you, run on the local chain.{" "}
          <button type="button" disabled={!!busy} onClick={() => void setNetwork("local")} className="text-muted underline-offset-2 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50">
            Switch to it
          </button>
        </p>
      )}
    </div>
  );
}
