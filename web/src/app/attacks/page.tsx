"use client";

import clsx from "clsx";
import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { ATTACKS, type AttackRun, runAttacks } from "@/chain/scenarios/attacks";
import { runLiveChecks } from "@/chain/scenarios/livechecks";
import { NeedsChain } from "@/components/chain/NeedsChain";
import { BeatList } from "@/components/covenant/Verdict";
import { Button, Num, PageHeader, Tag } from "@/components/ui";
import { recorded } from "@/fixtures";
import { useChain } from "@/store/chain";

/** The suite's attacks as `npm run record` captured them from the contracts on the local chain. */
const RECORDED = recorded.attacks as unknown as Record<string, AttackRun>;

export default function AttacksPage() {
  const status = useChain((s) => s.status);
  const run = useChain((s) => s.run);
  const busy = useChain((s) => s.busy);
  // Attacks run in snapshots and move the clock, which only the local chain allows. A public chain shows the runs
  // recorded from the same contracts instead.
  const live = useChain((s) => s.net?.caps.devChain ?? true);
  const netName = useChain((s) => s.net?.name);
  const setNetwork = useChain((s) => s.setNetwork);
  const offersLocal = useChain((s) => s.networks.some((n) => n.key === "local"));
  const ctx = useChain((s) => s.ctx);
  const view = useChain((s) => s.view);
  const [ownResults, setResults] = useState<Record<string, AttackRun>>({});
  // On a public chain: the single-call attacks, checked against the live vault (nothing sent); the rest as recorded.
  const [checked, setChecked] = useState<Record<string, AttackRun>>({});
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState(0);
  const results = live ? ownResults : { ...RECORDED, ...checked };
  const liveIds = Object.keys(checked);
  const vaultAddress = view?.address;
  useEffect(() => {
    if (live || !ctx || !view) return;
    let on = true;
    setChecked({});
    setChecking(true);
    runLiveChecks(ctx, view, (id, r) => {
      if (!on) return;
      setChecked((prev) => ({ ...prev, [id]: r }));
      setArrivals((n) => ({ ...n, [id]: (n[id] ?? 0) + 1 }));
    })
      .catch((e: unknown) => console.warn("live attack checks stopped:", e instanceof Error ? e.message : e))
      .finally(() => on && setChecking(false));
    return () => {
      on = false;
    };
    // a fresh check per vault, and on request; not on every block
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, ctx, vaultAddress, checkedAt]);
  // how many times each card's result has landed, so the card can react every time
  const [arrivals, setArrivals] = useState<Record<string, number>>({});
  const ran = Object.keys(results).length;
  const blocked = Object.values(results).filter((r) => r.blocked).length;

  const attempt = (ids: string[]) =>
    run(
      ids.length > 1 ? `Running ${ids.length} attacks` : "Running the attack",
      async (ctx, rec) => {
        await runAttacks(
          ctx,
          ATTACKS.filter((a) => ids.includes(a.id)),
          (id, r) => {
            setResults((prev) => ({ ...prev, [id]: r }));
            setArrivals((n) => ({ ...n, [id]: (n[id] ?? 0) + 1 }));
          },
          rec.progress,
        );
      },
      { quiet: true },
    );

  if (status !== "ready") return <NeedsChain what="the attack lab" />;
  return (
    <>
      <PageHeader
        eyebrow="Attack lab"
        title={`${ATTACKS.length} ways to take the liquidity. Run them.`}
        lead={
          live
            ? "Each card replays an attack from the contracts' adversarial test suite as real transactions, against a fresh vault on the local chain, inside a snapshot that is rolled back afterwards. Nothing on this page is pre-written: every outcome is what the contracts returned."
            : `Cards marked Live were just run against the ${view?.tokenSymbol ?? ""} vault on ${netName ?? "this chain"} as it is now, in simulated blocks on top of the chain's head. Its real curator and issuer act as themselves, stand-ins with no role are funded inside the simulation, and blocks hours or days later let the setup epoch, the curator timelock and a TWAP window pass. Nothing is sent: every refusal is the deployed contracts' own. Cards still marked Recorded need days of chain time, or a layout this vault does not have, so they show the suite's run against the same contracts on the local chain.`
        }
        aside={
          <div className="flex items-center gap-4">
            {ran > 0 && (
              <div className="text-right">
                <div className="num text-[28px] leading-none text-ink">
                  <Num value={blocked} format={(x) => String(Math.round(x))} />
                  <span className="text-faint"> / {ran}</span>
                </div>
                <div className="eyebrow mt-1">blocked</div>
              </div>
            )}
            {live ? (
              <Button variant="primary" disabled={!!busy} onClick={() => attempt(ATTACKS.map((a) => a.id))}>
                Run all {ATTACKS.length}
              </Button>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="primary" disabled={checking || !view} onClick={() => setCheckedAt(Date.now())}>
                  {checking ? "Checking the live vault…" : "Check again, live"}
                </Button>
                {offersLocal && (
                  <Button variant="ghost" onClick={() => void setNetwork("local")}>
                    Run all on the local chain
                  </Button>
                )}
              </div>
            )}
          </div>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {ATTACKS.map((a) => {
          const r = results[a.id];
          return (
            <article key={`${a.id}:${arrivals[a.id] ?? 0}`} className={clsx("flex flex-col rounded-lg border bg-surface p-5 transition-colors duration-500", r ? (r.blocked ? "refuse border-pass/40" : "border-breach/60") : "border-line")}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="eyebrow">{a.who}</div>
                  <h2 className="mt-1 text-[17px] font-medium leading-snug text-ink">{a.title}</h2>
                </div>
                <Tag tone={r ? (r.blocked ? "pass" : "breach") : "neutral"}>{r ? (r.blocked ? "Blocked" : "Got through") : a.rule}</Tag>
              </div>
              <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{a.story}</p>
              {r && (
                <div className="mt-3 border-t border-line">
                  <BeatList beats={r.beats} compact stagger={0.12} />
                  <p className={clsx("mt-2 text-[13px] font-medium", r.blocked ? "text-pass" : "text-breach")}>{r.summary}</p>
                </div>
              )}
              <div className="mt-auto flex items-center justify-between gap-3 pt-4">
                <span className="num truncate text-xs text-faint" title={a.test}>
                  {a.test}
                </span>
                {live ? (
                  <Button size="sm" variant={r ? "ghost" : "danger"} disabled={!!busy} onClick={() => attempt([a.id])}>
                    {r ? "Run again" : a.slow ? "Attempt (slow)" : "Attempt"}
                  </Button>
                ) : liveIds.includes(a.id) ? (
                  <Tag tone="accent">Live on {netName}</Tag>
                ) : (
                  <Tag>Recorded</Tag>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {ran === ATTACKS.length && blocked === ran && (
        <div className="mt-8 flex items-center gap-4 rounded-lg border border-pass/40 bg-pass/5 p-5">
          <ShieldCheck className="shrink-0 text-pass" size={28} strokeWidth={1.5} />
          <div>
            <div className="text-[15px] font-medium text-ink">
              All {ran} attacks were blocked by the deployed contracts
              {live ? "" : ` (${liveIds.length} just now on ${netName}, the other ${ran - liveIds.length} recorded on the local chain)`}.
            </div>
            <div className="text-[13.5px] text-muted">
              The successful steps inside a card are what an attacker is allowed to do, such as trading or proposing a curator. The step that would have taken value is the one the contract refused, or the
              one that turned out to take nothing. Every run happened in a snapshot: the chain is exactly as it was.
            </div>
          </div>
        </div>
      )}
    </>
  );
}
