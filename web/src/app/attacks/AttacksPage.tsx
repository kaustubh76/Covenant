"use client";

import clsx from "clsx";
import { ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ATTACKS, type AttackRun, runAttacks } from "@/chain/scenarios/attacks";
import { EXPECTED, NOT_LIVE, judged, runLiveChecks } from "@/chain/scenarios/livechecks";
import { ATTACK_TXS } from "@/chain/scenarios/onchain";
import { NeedsChain } from "@/components/chain/NeedsChain";
import { BeatList } from "@/components/covenant/Verdict";
import { note } from "@/chain/beat";
import { day, shortHash } from "@/components/landing/Live";
import { Button, Num, PageHeader, Tag } from "@/components/ui";
import type { LiveDeployment, LiveStep, LiveStory } from "@/server/live";
import { offeredDevNetwork, useChain } from "@/store/chain";

const nf = new Intl.NumberFormat("en-US");

/** `deployment` is Base Sepolia's, with its proofs (server/live.ts): the cards it has a transaction for link to it. */
export function AttacksPage({ deployment }: { deployment: LiveDeployment | null }) {
  const status = useChain((s) => s.status);
  const run = useChain((s) => s.run);
  const busy = useChain((s) => s.busy);
  // Attacks run in snapshots and move the clock, which only a dev chain allows. On a public chain each one is checked
  // against the live vault instead, in simulated blocks: nothing recorded elsewhere is shown as its result.
  const live = useChain((s) => s.net?.caps.devChain ?? true);
  const netName = useChain((s) => s.net?.name);
  const setNetwork = useChain((s) => s.setNetwork);
  // Where the attacks can run for real: the local chain, or on a hosted copy the visitor's own Playground.
  const devNet = useChain(offeredDevNetwork);
  const ctx = useChain((s) => s.ctx);
  const view = useChain((s) => s.view);
  const [ownResults, setResults] = useState<Record<string, AttackRun>>({});
  // On a public chain: each attack checked against the live vault (nothing sent). A check with no verdict (skipped, not
  // answered, refused by another rule) arrives with `noVerdict`, and its card says why.
  const [checked, setChecked] = useState<Record<string, AttackRun>>({});
  // The block the checks were simulated on top of.
  const [checkBlock, setCheckBlock] = useState<bigint | null>(null);
  // The checks as a whole could not start (the network did not answer the first reads).
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState(0);
  // A run of the attacks can be stopped between attacks.
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopRun = useRef(false);
  // A run counts as blocked only when the contracts refused it with what that attack tests (livechecks.ts `judged`).
  const results = live ? Object.fromEntries(Object.entries(ownResults).map(([id, r]) => [id, judged({ expect: EXPECTED[id] ?? [] }, r)])) : checked;
  // the proofs are Base Sepolia's own transactions: shown there only, not on a fork or the local chain
  const onBaseSepolia = useChain((s) => s.net?.key === "base-sepolia");
  // Every attack has also been played for real on Base Sepolia, by the recorded proofs (scenarios/onchain.ts): the card
  // links each of its transactions, on whichever vault it ran.
  const onChain = (id: string): { story: LiveStory; step: LiveStep }[] =>
    onBaseSepolia
      ? (ATTACK_TXS[id] ?? []).flatMap(([key, stepKey]) => {
          const story = deployment?.stories.find((s) => s.key === key);
          const step = story?.steps.find((x) => x.key === stepKey);
          return story && step ? [{ story, step }] : [];
        })
      : [];
  const linked = ATTACKS.filter((a) => onChain(a.id).length).length;
  const vaultAddress = view?.address;
  useEffect(() => {
    if (live || !ctx || !view) return;
    let on = true;
    setChecked({});
    setCheckBlock(null);
    setCheckError(null);
    setChecking(true);
    runLiveChecks(
      ctx,
      view,
      (id, r) => {
        if (!on) return;
        setChecked((prev) => ({ ...prev, [id]: r }));
        setArrivals((n) => ({ ...n, [id]: (n[id] ?? 0) + 1 }));
      },
      undefined,
      undefined,
      (block) => on && setCheckBlock(block),
    )
      .catch((e: unknown) => on && setCheckError(e instanceof Error ? e.message.split("\n")[0] : String(e)))
      .finally(() => on && setChecking(false));
    return () => {
      on = false;
    };
    // a fresh check per vault, and on request; not on every block
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, ctx, vaultAddress, checkedAt]);
  // how many times each card's result has landed, so the card can react every time
  const [arrivals, setArrivals] = useState<Record<string, number>>({});
  // Only runs with a verdict count: one the network or the script cut short is neither blocked nor through.
  const verdicts = Object.values(results).filter((r) => !r.noVerdict);
  const ran = verdicts.length;
  const blocked = verdicts.filter((r) => r.blocked).length;

  const attempt = (ids: string[]) => {
    stopRun.current = false;
    setStopping(false);
    setRunning(true);
    return run(
      ids.length > 1 ? `Running ${ids.length} attacks` : "Running the attack",
      async (ctx, rec) => {
        try {
          const { ran: done } = await runAttacks(
            ctx,
            ATTACKS.filter((a) => ids.includes(a.id)),
            (id, r) => {
              setResults((prev) => ({ ...prev, [id]: r }));
              setArrivals((n) => ({ ...n, [id]: (n[id] ?? 0) + 1 }));
            },
            rec.progress,
            () => stopRun.current,
          );
          if (done < ids.length) rec.record(note("anyone", "Attack run stopped", `Stopped after ${done} of ${ids.length}. The chain is back where it was.`), { toast: true });
        } catch (e) {
          // The run's snapshot went from under it: another tab reset the chain, or took it back past the run's start.
          if ((e as { name?: string })?.name !== "SnapshotGone") throw e;
          rec.record(note("anyone", "Attack run stopped", "The chain was reset, or taken back in another tab, during the run. The results before that are shown; the chain may hold part of the last attack, so Reset the Playground to start clean."), { toast: true });
        }
      },
      { quiet: true },
    ).finally(() => setRunning(false));
  };

  if (status !== "ready") return <NeedsChain what="the attack lab" />;
  return (
    <>
      <PageHeader
        eyebrow="Attack lab"
        title={`${ATTACKS.length} ways to take the liquidity. Run them.`}
        lead={
          live
            ? `Each card replays an attack from the contracts' adversarial test suite as real transactions, against a fresh vault on ${netName ?? "this chain"}, inside a snapshot that is rolled back afterwards. Nothing on this page is pre-written: every outcome is what the contracts returned.`
            : `Each card is checked against the ${view?.tokenSymbol ?? ""} vault on ${netName ?? "this chain"} as it is${checkBlock ? ` at block ${checkBlock.toLocaleString("en-US")}` : " now"}, in simulated blocks on top of the chain's head: its real curator and issuer act as themselves, stand-ins with no role are funded inside the simulation, and nothing is sent. A card counts as blocked only when the contracts refuse it with the error that attack tests for; a check that could not run, or was refused by another rule, says so and is not counted.${linked ? ` ${linked === ATTACKS.length ? "Every attack has" : `${linked} of the attacks have`} also been played for real on ${netName ?? "this chain"}: each card links the transactions, refused or settled by the deployed contracts.` : ""}`
        }
        aside={
          <div className="flex items-center gap-4">
            {ran > 0 && (
              <div className="text-right">
                <div className="num text-[28px] leading-none text-ink">
                  <Num value={blocked} format={(x) => String(Math.round(x))} />
                  <span className="text-faint"> / {ran}</span>
                </div>
                <div className="eyebrow mt-1">{live ? "blocked" : "would be blocked, checked live"}</div>
              </div>
            )}
            {live ? (
              <div className="flex flex-col items-end gap-1.5">
                {running ? (
                  <Button
                    variant="danger"
                    disabled={stopping}
                    onClick={() => {
                      stopRun.current = true;
                      setStopping(true);
                    }}
                    title="Stops after the attack running now; the chain is then put back as it was"
                  >
                    {stopping ? "Stopping after this attack…" : "Stop"}
                  </Button>
                ) : (
                  <Button variant="primary" disabled={!!busy} onClick={() => void attempt(ATTACKS.map((a) => a.id))} title={busy ? "Wait for the action running now to finish" : undefined}>
                    Run all {ATTACKS.length}
                  </Button>
                )}
                {/* said before it starts: one attack alone pokes the vault through four days of chain time */}
                <span className="text-right text-[11.5px] text-faint">Takes a few minutes; you can stop between attacks.</span>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="primary" disabled={checking || !view} onClick={() => setCheckedAt(Date.now())}>
                  {checking ? "Checking the live vault…" : "Check again, live"}
                </Button>
                {devNet && (
                  <Button variant="ghost" disabled={!!busy} onClick={() => void setNetwork(devNet)} title={busy ? "Wait for the action running now to finish" : undefined}>
                    {devNet === "local" ? "Run all on the local chain" : "Run all on the Playground"}
                  </Button>
                )}
              </div>
            )}
          </div>
        }
      />

      {checkError && !live && (
        <p className="mb-4 rounded-md border border-line bg-surface px-4 py-3 text-[13px] text-muted">
          The live checks could not start: {checkError}. Nothing is shown as checked; try again in a moment.
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {ATTACKS.map((a) => {
          const r = results[a.id];
          const proofs = onChain(a.id);
          return (
            <article
              key={`${a.id}:${arrivals[a.id] ?? 0}`}
              className={clsx("flex flex-col rounded-lg border bg-surface p-5 transition-colors duration-500", r && !r.noVerdict ? (r.blocked ? "refuse border-pass/40" : "border-breach/60") : "border-line")}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="eyebrow">{a.who}</div>
                  <h2 className="mt-1 text-[17px] font-medium leading-snug text-ink">{a.title}</h2>
                </div>
                <Tag tone={r ? (r.noVerdict ? "warn" : r.blocked ? "pass" : "breach") : "neutral"}>
                  {/* on a public chain a verdict is a simulation, said as what would happen; on a dev chain it happened */}
                  {r
                    ? r.noVerdict
                      ? r.skipped
                        ? "Not checked"
                        : live
                          ? "Could not run"
                          : "No verdict"
                      : r.blocked
                        ? live
                          ? "Blocked"
                          : "Would be blocked"
                        : live
                          ? "Got through"
                          : "Would get through"
                    : !live && checking && !NOT_LIVE[a.id]
                      ? "Checking live…"
                      : a.rule}
                </Tag>
              </div>
              <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{a.story}</p>
              {r && (
                <div className="mt-3 border-t border-line">
                  <BeatList beats={r.beats} compact stagger={0.12} />
                  <p className={clsx("mt-2 text-[13px] font-medium", r.noVerdict ? "text-muted" : r.blocked ? "text-pass" : "text-breach")}>{r.summary}</p>
                </div>
              )}
              {!live && !r && NOT_LIVE[a.id] && (
                <p className="mt-3 border-t border-line pt-3 text-[13px] leading-relaxed text-muted">
                  Not checked live. {NOT_LIVE[a.id]}
                  {proofs.length > 0 ? " It was played for real instead: the transactions are below." : ""}
                </p>
              )}
              {proofs.length > 0 && deployment && (
                <div className="mt-3 rounded-md border border-line bg-bg/40 px-3 py-2.5">
                  <span className="eyebrow block text-[10.5px]">Played for real on {netName}</span>
                  <ul className="mt-1.5 space-y-1.5">
                    {proofs.map(({ story, step }) => (
                      <li key={`${story.key}:${step.key}`}>
                        <a href={`${deployment.explorer}/tx/${step.hash}`} target="_blank" rel="noreferrer" className="group flex items-start gap-2.5 text-[12.5px] leading-snug">
                          <span className={clsx("mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full", step.status === "reverted" ? "bg-breach" : "bg-pass")} />
                          <span className="min-w-0">
                            <span className="block text-ink group-hover:underline">
                              {step.title}
                              {step.error && <span className="num text-breach"> · {step.error.split("(")[0]}</span>}
                            </span>
                            <span className="num block truncate text-faint">
                              {story.symbol} · {step.time ? `${day(step.time)} · ` : ""}block {nf.format(step.block)} · {shortHash(step.hash)} ↗
                            </span>
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
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
                ) : r && !r.noVerdict ? (
                  <span title={`Simulated against the live vault${checkBlock ? ` at block ${checkBlock.toLocaleString("en-US")}` : ""}; nothing was sent`}>
                    <Tag tone="accent">Checked live</Tag>
                  </span>
                ) : NOT_LIVE[a.id] && proofs.length ? (
                  <Tag>On record</Tag>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      {ran > 0 && blocked === ran && (live ? ran === ATTACKS.length : !checking) && (
        <div className="mt-8 flex items-center gap-4 rounded-lg border border-pass/40 bg-pass/5 p-5">
          <ShieldCheck className="shrink-0 text-pass" size={28} strokeWidth={1.5} />
          <div>
            <div className="text-[15px] font-medium text-ink">
              {live
                ? `All ${ran} attacks were blocked by the deployed contracts.`
                : `Every attack with a verdict would be blocked: ${ran} simulated live against the deployed contracts${checkBlock ? ` at block ${checkBlock.toLocaleString("en-US")}` : ""}${ATTACKS.length - ran ? `. The other ${ATTACKS.length - ran} say on their cards why they have none` : ""}.`}
            </div>
            <div className="text-[13.5px] text-muted">
              The successful steps inside a card are what an attacker is allowed to do, such as trading or proposing a curator. The step that would have taken value is the one the contract refused, or the
              one that turned out to take nothing.{" "}
              {live ? "Every run happened in a snapshot: the chain is exactly as it was." : "Every check was simulated on top of the chain's head: nothing was sent."}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
