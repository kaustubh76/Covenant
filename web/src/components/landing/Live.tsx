"use client";

import clsx from "clsx";
import { ArrowRight, Check, Copy, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { shortAddress } from "@/chain/accounts";
import { Button, Tag } from "@/components/ui";
import type { LiveDeployment, LiveStep } from "@/server/live";
import { useChain } from "@/store/chain";
import { Container, Reveal, SectionHead } from "./motion";

const nf = new Intl.NumberFormat("en-US");
export const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
/** The UTC day of an ISO time, e.g. "17 Nov 2026": when a transaction on record was made. */
export const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
/** A step's detail, without the revert it repeats, with full addresses shortened and wei-precise amounts rounded. */
export const tidy = (s: LiveStep) =>
  (s.error && s.detail.startsWith(`${s.error}: `) ? s.detail.slice(s.error.length + 2) : s.detail)
    .replace(/0x[0-9a-fA-F]{40}/g, (a) => shortAddress(a))
    .replace(/\b\d+\.\d{8,}\b/g, (n) => (Number(n) < 1 ? Number(n).toPrecision(3) : Number(n).toFixed(4)));

function CopyAddress({ value }: { value: string }) {
  // "copied", or "failed" when the browser refused (no clipboard access): said, rather than a click that does nothing
  const [done, setDone] = useState<false | "copied" | "failed">(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), done === "failed" ? 3000 : 1500);
    return () => clearTimeout(t);
  }, [done]);
  const label = done === "copied" ? "Copied" : done === "failed" ? "This browser did not allow copying: select the address to copy it" : "Copy address";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => (navigator.clipboard ? navigator.clipboard.writeText(value).then(() => setDone("copied"), () => setDone("failed")) : setDone("failed"))}
      className="grid h-7 w-7 place-items-center rounded-md text-faint transition-colors hover:bg-raised hover:text-ink"
    >
      {done === "copied" ? <Check size={13} className="text-pass" /> : done === "failed" ? <X size={13} className="text-breach" /> : <Copy size={13} />}
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
                {s.time ? `${day(s.time)} · ` : ""}block {nf.format(s.block)} · {shortHash(s.hash)} ↗
              </a>
            </Reveal>
          </li>
        );
      })}
    </ol>
  );
}

function Contracts({ live }: { live: LiveDeployment }) {
  // the store reads ?net= when the app loads, not on an in-app link: switch it here, e.g. coming back from a Playground
  const setNetwork = useChain((s) => s.setNetwork);
  return (
    <div className="rounded-2xl border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
        <span className="eyebrow">Deployed contracts</span>
        {/* Only what Sourcify said while this page was built: no claim when it did not answer. */}
        {live.sourcify && live.sourcify.verified.length > 0 && (
          <a
            href={`https://repo.sourcify.dev/${live.chainId}/${live.sourcify.verified[0].address}`}
            target="_blank"
            rel="noreferrer"
            title={`Asked Sourcify on ${day(live.sourcify.checkedAt)}: ${live.sourcify.verified.map((c) => c.label).join(", ")}`}
            className="inline-flex items-center gap-1.5 text-[12.5px] text-pass underline-offset-2 hover:underline"
          >
            <Check size={13} /> {live.sourcify.verified.length === live.sourcify.of ? "Core contracts" : `${live.sourcify.verified.length} of ${live.sourcify.of} core contracts`} verified on Sourcify, checked{" "}
            {day(live.sourcify.checkedAt)} ↗
          </a>
        )}
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
        <Link href="/vault?net=base-sepolia" onClick={() => void setNetwork("base-sepolia")}>
          <Button variant="primary">
            Open the live vault <ArrowRight size={15} />
          </Button>
        </Link>
        <a href={`${live.explorer}/address/${live.vault}`} target="_blank" rel="noreferrer">
          <Button>Vault on Basescan ↗</Button>
        </a>
        <Link href="/ledger">
          <Button variant="ghost">Every transaction on record</Button>
        </Link>
      </div>
    </div>
  );
}

/** The real deployment: the contracts' addresses and the live proof's transactions, each linked to the explorer. */
export function LiveSection({ live }: { live: LiveDeployment }) {
  const told = live.stories.filter((s) => s.listed !== false);
  const stories = told.length ? told : live.steps.length ? [{ key: "covenant" as const, title: "", vault: live.vault, symbol: live.symbol, steps: live.steps }] : [];
  const [pick, setPick] = useState(0);
  const story = stories[Math.min(pick, stories.length - 1)];
  const proven = stories.length > 0;
  return (
    <Container>
      <section id="live" className="scroll-mt-24 border-t border-line py-24">
        <SectionHead
          eyebrow={`On ${live.network}, on record`}
          title={proven ? "Deployed, launched and attacked in public." : "Deployed and launched in public."}
          lead={
            proven
              ? `These contracts run on ${live.network}, launched through Uniswap's Liquidity Launcher and CCA. Every line below is a transaction there, dated and linked: what each one did, as the run that sent it read it back. The project's own keys played every part, the keeper included.`
              : `These contracts run on ${live.network}, launched through Uniswap's Liquidity Launcher and CCA.`
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
