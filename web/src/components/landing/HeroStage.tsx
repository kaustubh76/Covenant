"use client";

import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { shortAddress } from "@/chain/accounts";
import { covenantVaultAbi } from "@/chain/abi.generated";
import { isFailureKind } from "@/chain/failure";
import { NEVER } from "@/chain/launch";
import { type Plan, cutAll, skim, softRug } from "@/chain/plans";
import { type Preflight, failedPreflight, preflight } from "@/chain/preflight";
import { LIVE_CHECKS } from "@/chain/scenarios/livechecks";
import type { VaultView } from "@/chain/view";
import { ShapeChart, ShapeLegend } from "@/components/covenant/ShapeChart";
import { RevertCard } from "@/components/covenant/Verdict";
import { Button, Tag } from "@/components/ui";
import { amt, pct } from "@/lib/format";
import type { LiveDeployment } from "@/server/live";
import { useChain } from "@/store/chain";
import { EVERY_MS, type LiveVault, ago } from "./useLiveVault";

/**
 * No answer, rather than the contract's: the network did not answer, or failed in a way no contract error explains
 * (decodeRevert's and failedPreflight's fallback, named "Error"). Never shown as "would revert", never counted.
 */
const unanswered = (p: Preflight) => !p.ok && (isFailureKind(p.error?.name) || p.error?.name === "Error");

/** The three takings the hero offers, each a reshape the curator could submit. */
const TRIES: { key: string; label: string; plan: (v: VaultView) => Plan }[] = [
  { key: "pull", label: "Pull the liquidity", plan: (v) => ({ cuts: cutAll(v), legs: [] }) },
  { key: "skim", label: "Keep 10% of the support", plan: (v) => skim(v) },
  { key: "soft", label: "Hide the support", plan: (v) => softRug(v) },
];

type Outcome = { state: "checking" } | { state: "done"; p: Preflight };

/**
 * The landing page's vault: the live one on Base Sepolia, read at the block shown, and three ways its curator could try
 * to take the liquidity, each simulated against it as that curator. Nothing is sent.
 */
export function HeroStage({ deployment, live }: { deployment: LiveDeployment | null; live: LiveVault }) {
  const setNetwork = useChain((s) => s.setNetwork);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [last, setLast] = useState<string | null>(null);
  const [, tick] = useState(0);
  // the age of the read, kept current
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  if (!deployment) {
    return (
      <div className="glass rounded-2xl border border-line-strong p-6 text-[14px] leading-relaxed text-muted md:p-8">
        This copy of the app has no live deployment on record, so there is no vault to show here. Start the local chain with <span className="num text-ink">make demo</span> and open the vault.
      </div>
    );
  }
  const v = live.view;
  const fresh = !!v && !live.error && !!live.readAt && Date.now() - live.readAt < 90_000;
  const sym = v?.tokenSymbol ?? deployment.symbol;

  const attempt = async (key: string) => {
    const t = TRIES.find((x) => x.key === key)!;
    if (!v || !live.ctx) return;
    setLast(key);
    setOutcomes((o) => ({ ...o, [key]: { state: "checking" } }));
    const plan = t.plan(v);
    const call = { address: v.address, abi: covenantVaultAbi, functionName: "reshape", args: [plan.cuts, plan.legs, NEVER] as readonly unknown[] };
    const p = await preflight(live.ctx, v.people.curator, call, v).catch(failedPreflight);
    setOutcomes((o) => ({ ...o, [key]: { state: "done", p } }));
  };
  const refusedCount = TRIES.filter((t) => {
    const o = outcomes[t.key];
    return o?.state === "done" && !o.p.ok && !unanswered(o.p);
  }).length;
  // the block a simulation ran in, as the chain's head was when the try was pressed (not the view's block)
  const inBlock = (p: Preflight) => (p.simulatedAt ? ` in block ${p.simulatedAt.toLocaleString("en-US")}` : "");
  const shown = last ? outcomes[last] : undefined;

  return (
    <div className="glass rounded-2xl border border-line-strong">
      <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5 md:px-7">
        <div className="flex min-w-0 items-center gap-3">
          <span className="relative flex h-2 w-2 shrink-0" title={fresh ? "Read from the chain in the last 90 seconds" : "Not read recently"}>
            {fresh && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-support opacity-60" />}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${fresh ? "bg-support" : "bg-line-strong"}`} />
          </span>
          <span className="eyebrow !text-ink">
            The live vault · {sym} on {deployment.network}
          </span>
          {v && (
            <span className="hidden truncate text-[13px] text-faint md:inline">
              {amt(v.principal.quote)} {v.quoteSymbol} and {amt(v.principal.token)} {sym} in it
            </span>
          )}
        </div>
        {v && <Tag tone={v.support.have >= v.support.need ? "pass" : "breach"}>Support {pct(v.support.have)}</Tag>}
      </div>

      {!v ? (
        <div className="grid min-h-[300px] place-items-center px-6 py-10 text-center text-[14px] text-muted">
          {live.error ? (
            <div>
              <div className="text-ink">Not read yet</div>
              <p className="mt-1.5 max-w-md">{live.error}</p>
              <Button className="mt-4" onClick={live.retry}>
                <RotateCcw size={14} /> Try again
              </Button>
            </div>
          ) : (
            <span>
              Reading {sym} on {deployment.network}…
            </span>
          )}
        </div>
      ) : (
        <div className="grid lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="px-3 pb-4 pt-5 md:px-6">
            <ShapeChart world={v} height={330} />
            <div className="mt-2 px-2">
              <ShapeLegend />
            </div>
          </div>

          <div className="flex flex-col border-t border-line p-5 md:p-7 lg:border-l lg:border-t-0">
            <div className="eyebrow">Try to take it</div>
            <p className="display mt-2 text-[26px] leading-tight text-ink">You hold the curator&apos;s keys.</p>
            <p className="mt-3 text-[14px] leading-relaxed text-muted">
              <span className="num text-ink">{pct(v.support.have)}</span> of this vault&apos;s {v.quoteSymbol} bids in the band under the price, and the covenant never lets a reshape take that below{" "}
              <span className="num text-ink">{pct(v.support.need)}</span>. Each try is simulated against it as the chain stands when you press it, as its curator ({shortAddress(v.people.curator)}). Nothing is sent.
            </p>
            <div className="mt-5 grid gap-2">
              {TRIES.map((t) => {
                const o = outcomes[t.key];
                const word = !o ? "try" : o.state === "checking" ? "asking…" : o.p.ok ? "would settle" : unanswered(o.p) ? "no answer" : "would revert";
                return (
                  <Button key={t.key} variant="danger" className="w-full justify-between" disabled={o?.state === "checking"} onClick={() => void attempt(t.key)}>
                    {t.label}
                    <span className="num text-[11px] opacity-70">{word}</span>
                  </Button>
                );
              })}
            </div>
            {shown?.state === "done" &&
              (shown.p.ok ? (
                <div className="mt-4 rounded-md border border-line-strong px-4 py-3 text-[13px] text-ink">The contract would accept this one{inBlock(shown.p)}.</div>
              ) : unanswered(shown.p) ? (
                <div className="mt-4 rounded-md border border-line-strong px-4 py-3 text-[13px] text-muted">No answer from the simulation: {shown.p.error?.reason} Try it again.</div>
              ) : (
                shown.p.error && (
                  <>
                    <RevertCard key={last} label="Would revert" error={shown.p.error} className="mt-4" />
                    {shown.p.simulatedAt && <p className="mt-1.5 text-[11.5px] text-faint">Simulated{inBlock(shown.p)}, as the curator. Nothing was sent.</p>}
                  </>
                )
              ))}
            {refusedCount === TRIES.length && (
              <Link href="/attacks" className="mt-4 text-[13.5px] text-accent underline-offset-4 hover:underline">
                The contract would refuse all three. The attack lab checks {LIVE_CHECKS.length} attacks live against the vault you pick there →
              </Link>
            )}
          </div>
        </div>
      )}

      <div className="border-t border-line px-5 py-2.5 text-[11.5px] text-faint md:px-7">
        {v ? (
          <>
            Read from {deployment.network} with the lens at block <span className="num">{v.block.toLocaleString("en-US")}</span>, {live.readAt ? ago(live.readAt) : ""}
            {live.error ? `; the latest read failed (${live.error}), so this is the last good one` : `, and again every ${EVERY_MS / 1000} s`}.{" "}
            <Link href="/vault?net=base-sepolia" onClick={() => void setNetwork("base-sepolia")} className="text-muted underline-offset-2 hover:text-ink hover:underline">
              Open the vault →
            </Link>
          </>
        ) : (
          <>The vault is read live from {deployment.network}, at the block shown, with no wallet.</>
        )}
      </div>
    </div>
  );
}
