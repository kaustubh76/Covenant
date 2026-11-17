"use client";

import clsx from "clsx";
import { ArrowRight, Check, Copy } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { shortAddress } from "@/chain/accounts";
import { Button, Tag } from "@/components/ui";
import type { LiveDeployment, LiveStep } from "@/server/live";
import { Container, Reveal, SectionHead } from "./motion";

const nf = new Intl.NumberFormat("en-US");
export const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
/** A step's detail, without the revert it repeats, with full addresses shortened and wei-precise amounts rounded. */
export const tidy = (s: LiveStep) =>
  (s.error && s.detail.startsWith(`${s.error}: `) ? s.detail.slice(s.error.length + 2) : s.detail)
    .replace(/0x[0-9a-fA-F]{40}/g, (a) => shortAddress(a))
    .replace(/\b\d+\.\d{8,}\b/g, (n) => (Number(n) < 1 ? Number(n).toPrecision(3) : Number(n).toFixed(4)));

function CopyAddress({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      aria-label={done ? "Copied" : "Copy address"}
      title={done ? "Copied" : "Copy address"}
      onClick={() => navigator.clipboard?.writeText(value).then(() => setDone(true), () => {})}
      className="grid h-7 w-7 place-items-center rounded-md text-faint transition-colors hover:bg-raised hover:text-ink"
    >
      {done ? <Check size={13} className="text-pass" /> : <Copy size={13} />}
    </button>
  );
}

function Proof({ steps, explorer }: { steps: LiveStep[]; explorer: string }) {
  return (
    <ol>
      {steps.map((s, i) => {
        const refused = s.status === "reverted";
        return (
          <li key={s.key} className="grid grid-cols-[18px_minmax(0,1fr)] gap-4">
            <div className="relative flex justify-center" aria-hidden>
              <span className={clsx("relative z-10 mt-[7px] h-2.5 w-2.5 rounded-full ring-4 ring-bg", refused ? "bg-breach" : "bg-pass")} />
              {i < steps.length - 1 && <span className="absolute bottom-0 top-[18px] w-px bg-line-strong" />}
            </div>
            <Reveal delay={i * 0.05} className={clsx("min-w-0", i < steps.length - 1 && "pb-8")}>
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                <Tag tone={refused ? "breach" : "pass"}>{refused ? "Reverted" : "Mined"}</Tag>
                <span className="text-[15.5px] text-ink">{s.title}</span>
              </div>
              {s.error && <div className="num mt-2 truncate text-[13px] text-breach">{s.error}</div>}
              <p className="mt-1.5 text-[14px] leading-relaxed text-muted [overflow-wrap:anywhere]">{tidy(s)}</p>
              <a href={`${explorer}/tx/${s.hash}`} target="_blank" rel="noreferrer" className="num mt-2 inline-block max-w-full truncate text-[12px] text-faint underline-offset-2 hover:text-ink hover:underline">
                block {nf.format(s.block)} · {shortHash(s.hash)} ↗
              </a>
            </Reveal>
          </li>
        );
      })}
    </ol>
  );
}

function Contracts({ live }: { live: LiveDeployment }) {
  return (
    <div className="rounded-2xl border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
        <span className="eyebrow">Deployed contracts</span>
        <a href={`https://repo.sourcify.dev/${live.chainId}/${live.hook}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[12.5px] text-pass underline-offset-2 hover:underline">
          <Check size={13} /> Core contracts verified on Sourcify ↗
        </a>
      </div>
      <ul className="divide-y divide-line">
        {live.contracts.map((c) => (
          <li key={c.address} className="flex items-center justify-between gap-3 py-2 pl-5 pr-3">
            <span className="min-w-0 truncate text-[13.5px] text-muted">{c.label}</span>
            <span className="flex shrink-0 items-center gap-1">
              <a href={`${live.explorer}/address/${c.address}`} target="_blank" rel="noreferrer" title={c.address} className="num text-[12.5px] text-ink underline-offset-2 hover:underline">
                {shortAddress(c.address)} ↗
              </a>
              <CopyAddress value={c.address} />
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2.5 border-t border-line p-5">
        <Link href="/vault?net=base-sepolia">
          <Button variant="primary">
            Open the live vault <ArrowRight size={15} />
          </Button>
        </Link>
        <a href={`${live.explorer}/address/${live.vault}`} target="_blank" rel="noreferrer">
          <Button>Vault on Basescan ↗</Button>
        </a>
      </div>
    </div>
  );
}

/** The real deployment: the contracts' addresses and the live proof's transactions, each linked to the explorer. */
export function LiveSection({ live }: { live: LiveDeployment }) {
  const stories = live.stories.length ? live.stories : live.steps.length ? [{ key: "covenant" as const, title: "", vault: live.vault, symbol: live.symbol, steps: live.steps }] : [];
  const [pick, setPick] = useState(0);
  const story = stories[Math.min(pick, stories.length - 1)];
  const proven = stories.length > 0;
  return (
    <Container>
      <section id="live" className="scroll-mt-24 border-t border-line py-24">
        <SectionHead
          eyebrow={`Live on ${live.network}`}
          title={proven ? "Deployed, launched and attacked in public." : "Deployed and launched in public."}
          lead={
            proven
              ? `The same bytecode runs on ${live.network}, launched through Uniswap's Liquidity Launcher and CCA. The curator tried a soft rug there and the pool refused it; a stranger restored support for the bounty${stories.some((s) => s.key === "lp") ? "; an outside LP joined, earned fees and left, in kind" : ""}${stories.some((s) => s.key === "manage") ? "; and after a pump, the curator's chase above the Anchor and its try at moving everything at once were both refused, while an honest re-centre settled" : ""}. Every line links to its transaction.`
              : `The same bytecode runs on ${live.network}, launched through Uniswap's Liquidity Launcher and CCA, and its core contracts are verified on Sourcify.`
          }
        />
        <div className={clsx("mt-12 grid gap-10 lg:gap-14", proven && "lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]")}>
          {proven && story && (
            <div className="min-w-0">
              {stories.length > 1 ? (
                <div role="tablist" aria-label="Live proofs" className="mb-6 flex flex-wrap gap-2">
                  {stories.map((s, i) => (
                    <button
                      key={s.key}
                      type="button"
                      role="tab"
                      aria-selected={s === story}
                      onClick={() => setPick(i)}
                      className={clsx(
                        "rounded-full border px-3.5 py-1.5 text-left text-[12.5px] transition-colors",
                        s === story ? "border-ink bg-raised text-ink" : "border-line-strong text-muted hover:border-muted hover:text-ink",
                      )}
                    >
                      <span className="num text-faint">{s.symbol}</span> · {s.title}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="eyebrow mb-6">The live proof, transaction by transaction</div>
              )}
              <Proof key={story.key} steps={story.steps} explorer={live.explorer} />
            </div>
          )}
          <Reveal className="min-w-0 self-start lg:sticky lg:top-24">
            <Contracts live={live} />
          </Reveal>
        </div>
      </section>
    </Container>
  );
}
