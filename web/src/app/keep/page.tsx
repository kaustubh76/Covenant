"use client";

import { useEffect, useState } from "react";
import { type Abi, formatEther } from "viem";
import { covenantVaultAbi } from "@/chain/abi.generated";
import type { Who } from "@/chain/accounts";
import { beatOf, note } from "@/chain/beat";
import { CRASH_HOLD_MARGIN_S, type CrashSim, findCrash } from "@/chain/crashsim";
import { NEVER } from "@/chain/launch";
import { deepenReserve } from "@/chain/plans";
import { type Preflight, vaultEvents, failedPreflight, preflight } from "@/chain/preflight";
import { LN_BASE } from "@/chain/price";
import { crash, findLapsingCrash, planRestore, restoreCall } from "@/chain/scenarios/restore";
import { type Party, send } from "@/chain/tx";
import { readVaultView } from "@/chain/view";
import { NeedsChain } from "@/components/chain/NeedsChain";
import { RuleRail } from "@/components/covenant/RuleRail";
import { ShapeChart, ShapeLegend } from "@/components/covenant/ShapeChart";
import { Button, PageHeader, Panel, Row, Tag } from "@/components/ui";
import { amt, duration, pct } from "@/lib/format";
import { describeRange } from "@/lib/ranges";
import { useBalances } from "@/lib/useBalances";
import { actorFor, useChain } from "@/store/chain";
import { SendButton } from "@/components/controls/SendButton";
import { FAILURE_LABEL, isFailureKind } from "@/chain/failure";
import { RelayButton } from "@/components/controls/RelayButton";
import { OnRecord } from "@/components/covenant/OnRecord";
import { useRelay } from "@/lib/useRelay";

const fallPct = (ticks: number) => `${((1 - Math.exp(-ticks * LN_BASE)) * 100).toFixed(0)}%`;
/** Who restores in a simulation when no wallet is connected: any address will do, nothing is sent. */
const ANYONE = "0x000000000000000000000000000000000000dEaD";
const eth = (x: unknown) => Number(formatEther((x as bigint) ?? 0n));

export default function KeepPage() {
  const v = useChain((s) => s.view);
  const ctx = useChain((s) => s.ctx);
  const role = useChain((s) => s.role);
  const setRole = useChain((s) => s.setRole);
  const run = useChain((s) => s.run);
  const busy = useChain((s) => s.busy);
  const net = useChain((s) => s.net);
  const wallet = useChain((s) => s.wallet);
  const publicChain = !!net && !net.caps.devChain;
  // Restore and poke are open to anyone. On a public chain that is the connected wallet, whichever role the top bar
  // shows: as the curator or issuer (partyFor), a stranger's wallet would be refused with "only 0x… can send this".
  // On a dev chain, the role chosen sends with its own key.
  const roleActor = actorFor(role, v);
  const actor: Who = publicChain ? "anyone" : roleActor;
  const party: Party = publicChain ? "holder" : roleActor;
  // With no wallet and the relayer on, "Have the backend send it" is the live way to restore: it leads, and the send
  // button (which can only ask for a wallet then) steps back.
  const relayLeads = useRelay().enabled && !wallet;
  // on a public chain every role reads the connected wallet's balance (useBalances)
  const bal = useBalances(roleActor);
  // Each result is kept with the vault it was worked out for: switching vaults never draws one vault's plan on another's
  // ranges, and a simulation's answer goes with it.
  const [planFor, setPlanFor] = useState<{ vault: string; plan: { indices: number[]; pre: Preflight } | null } | null>(null);
  const [simFor, setSimFor] = useState<{ vault: string; state: "running" | { result: CrashSim | null; deepened: boolean; noDeeper?: string; error?: string } } | null>(null);
  const plan = v && planFor?.vault === v.address ? planFor.plan : null;
  const sim = v && simFor?.vault === v.address ? simFor.state : null;
  const setSim = (state: "running" | { result: CrashSim | null; deepened: boolean; noDeeper?: string; error?: string }) => v && setSimFor({ vault: v.address, state });

  useEffect(() => {
    if (!ctx || !v) return;
    let live = true;
    planRestore(ctx, v, party)
      .then((p) => live && setPlanFor({ vault: v.address, plan: p }))
      // A check that could not be made is not "nothing to restore": keep why, and the next block checks again.
      .catch((e: unknown) => live && setPlanFor({ vault: v.address, plan: { indices: [], pre: failedPreflight(e) } }));
    return () => {
      live = false;
    };
  }, [ctx, v, party]);

  if (!v) return <NeedsChain what="the keeper's desk" />;
  const s = v.support;
  const g = v.guard;
  const lapsed = s.have < s.need;
  const after = plan?.pre.ok ? plan.pre.after : undefined;
  const restored = plan?.pre.events.find((e) => e.name === "Restored");
  const bounty = restored ? eth(restored.args.bounty) : Math.min(v.fees.bountyPool, Number(formatEther(v.terms.bounty)));
  const describe = { now: v.time + 1, tokenSymbol: v.tokenSymbol };

  const restore = () =>
    run("Restore support", async (c, rec) => {
      // plan again against the latest state: the price or the vault may have moved since the page rendered
      const latest = await readVaultView(c, v.address);
      const p = await planRestore(c, latest, party);
      const indices = [...(p?.indices ?? [])].sort((a, b) => a - b);
      const o = await send(c, party, restoreCall(latest, indices), { force: true, describe });
      const ev = vaultEvents(o.receipt?.logs as never, v.address).find((e) => e.name === "Restored");
      rec.record(
        beatOf(o, actor, "Restore support", () =>
          ev ? `Support ${pct(Number(ev.args.supportBefore))} → ${pct(Number(ev.args.supportAfter))}. Bounty paid: ${amt(eth(ev.args.bounty))} ETH` : undefined,
        ),
        { toast: true },
      );
    });

  const runCrash = () =>
    run(
      "Looking for a sell-off that strands support",
      async (c, rec) => {
        const depth = await findLapsingCrash(c, v);
        if (depth === null) {
          rec.record(
            note(
              "anyone",
              "No sell-off strands this layout",
              "Every bid sits within one band of the price, so a crash either keeps it in the band or fills it. Give the vault a deeper reserve on the Curate page, then try again.",
            ),
            { toast: true },
          );
          return;
        }
        rec.progress(`Market sells the token down ${fallPct(depth)}`);
        const o = await crash(c, v, depth);
        const later = await readVaultView(c, v.address);
        rec.record(
          [
            beatOf(o, "market", `Market sells the token down ${fallPct(depth)}`, () => `Spot falls ${depth} ticks and holds for ${duration(v.terms.twapWindow + 3600)}`),
            note("anyone", `Support has lapsed to ${pct(later.support.have)}`, `Below the ${pct(later.support.need, 0)} minimum: the reserve now sits under the band`),
          ],
          { toast: true },
        );
      },
      { quiet: true },
    );

  // A public chain has no snapshots to try crashes in, so the crash is simulated instead (crashsim.ts): the sale in the
  // next block, the vault read back a TWAP window later. Tokens to sell come from the issuer's balance. If the layout as
  // it is has no crash that strands support, the curator's deeper reserve is simulated first: the layout restore is for.
  const simulateCrash = async () => {
    if (!ctx || !v) return;
    setSim("running");
    const keeper = wallet?.address ?? ANYONE;
    try {
      let result = await findCrash(ctx, v, v.people.issuer, keeper);
      let deepened = false;
      let noDeeper: string | undefined;
      if (!result) {
        const d = deepenReserve(v);
        // Only a deeper reserve the curator could really place is worth trying: if the reshape itself would be refused
        // (Pace, the guard), say so rather than claim the deeper layout was tried.
        const reshape = { address: v.address, abi: covenantVaultAbi, functionName: "reshape", args: [d.cuts, d.legs, NEVER] } as const;
        const can = await preflight(ctx, v.people.curator, reshape, v).catch(failedPreflight);
        if (can.ok) {
          const prelude = [{ account: v.people.curator, to: v.address, abi: covenantVaultAbi as Abi, functionName: "reshape", args: [d.cuts, d.legs, NEVER] }];
          result = await findCrash(ctx, v, v.people.issuer, keeper, prelude);
          deepened = !!result;
        } else noDeeper = can.error?.reason ?? "the curator's reshape would be refused";
      }
      setSim({ result, deepened, noDeeper });
    } catch (e) {
      setSim({ result: null, deepened: false, error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    }
  };

  const poke = () =>
    run("Sync the Anchor", async (c, rec) => {
      const o = await send(c, party, { address: v.address, abi: covenantVaultAbi, functionName: "poke", args: [] });
      rec.record(beatOf(o, actor, "Anchor synced (poke)", () => "Anyone can call it. It only ever moves the Anchor by the rule"), { toast: true });
    });

  return (
    <>
      <PageHeader
        eyebrow="Keeper"
        title="When a sell-off strands support, anyone can bring it back."
        lead="Support is measured in a band under the time-weighted price. A lasting sell-off drags the band down and can leave the vault's reserve beneath it. Restore is open to every address and pays a bounty, so it never depends on the curator showing up. A rally cannot lapse it: asks the vault sold count as support."
        aside={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {role !== "keeper" && !publicChain && (
              <Button size="sm" onClick={() => setRole("keeper")} disabled={!!busy} title={busy ? "Wait for the action running now to finish" : undefined}>
                Act as keeper
              </Button>
            )}
            <Tag tone={lapsed ? "breach" : "pass"}>{lapsed ? "Support has lapsed" : "Support holding"}</Tag>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-6">
          <Panel eyebrow={after ? "After restore" : "Now"} title={after ? "The stranded quote moves back into the band" : "Where the vault's support sits"}>
            <ShapeChart world={after ?? v} ghost={after ? v : undefined} height={320} />
            <div className="mt-3">
              <ShapeLegend ghost={after ? "Before" : undefined} />
            </div>
          </Panel>
          <RuleRail world={v} />
        </div>

        <div className="space-y-6 lg:sticky lg:top-20 lg:self-start">
          <Panel eyebrow="Restore" title={lapsed ? "Support is below the covenant" : "Nothing to restore"}>
            <div className="flex items-end gap-4">
              <div>
                <div className="eyebrow">Now</div>
                <div className={`num text-[32px] leading-none ${lapsed ? "text-breach" : "text-ink"}`}>{pct(s.have)}</div>
              </div>
              {after && (
                <>
                  <div className="pb-1 text-faint">→</div>
                  <div>
                    <div className="eyebrow">After</div>
                    <div className="num text-[32px] leading-none text-pass">{pct(after.support.have)}</div>
                  </div>
                </>
              )}
              <div className="ml-auto text-right">
                <div className="eyebrow">Required</div>
                <div className="num text-[15px] text-muted">{pct(s.need, 0)}</div>
              </div>
            </div>

            <div className="mt-5">
              {plan?.pre.ok && <Row label="Ranges to move">{plan.indices.map((i) => describeRange(v, i).label).join(", ")}</Row>}
              {/* The exact bounty comes from the restore's pre-flight; until one passes, only its cap is known. A bounty is also
                  capped at a share of the quote the restore moves, so it can be far smaller. */}
              <Row label={restored ? "Bounty for the caller" : "Bounty, at most"}>{amt(bounty)} ETH</Row>
              <Row label="Bounty pool">{amt(v.fees.bountyPool)} ETH</Row>
              <Row label="Your balance">{bal ? `${amt(bal.quote)} ETH` : publicChain && !wallet ? "Connect a wallet" : "…"}</Row>
            </div>

            {plan?.pre.ok && <RelayButton action="restore" title="Restore support" body={{ indices: [...plan.indices].sort((a, b) => a - b) }} className="mt-5 w-full" prominent />}
            <SendButton
              verb="restore"
              gate={!!plan?.pre.ok}
              variant={plan?.pre.ok && !relayLeads ? "primary" : "secondary"}
              className={plan?.pre.ok && relayLeads ? "mt-2 w-full" : "mt-5 w-full"}
              onClick={restore}
              disabled={!!busy || (publicChain && !plan?.pre.ok)}
            >
              {plan?.pre.ok
                ? "Call restore"
                : plan && isFailureKind(plan.pre.error?.name)
                  ? `${FAILURE_LABEL[plan.pre.error.name]}: checking again`
                  : !plan
                    ? "Checking restore…"
                    : publicChain
                      ? lapsed
                        ? !g.ok
                          ? "The guard holds restore"
                          : "Restore would revert"
                        : "Nothing to restore"
                      : "Call restore anyway"}
            </SendButton>
            <p className="mt-2 text-center text-xs text-faint">
              {!g.ok
                ? "The guard is tripped: restore will revert until the price settles."
                : plan?.pre.ok
                  ? "Open to any address. No permission needed."
                  : !plan
                    ? "Checking restore against the vault as it is now…"
                    : (plan.pre.error?.reason ?? "The check found nothing to restore.")}
            </p>
            <OnRecord fn="restore" className="mt-3 text-center" />
          </Panel>

          {!lapsed && publicChain && (
            <Panel eyebrow="Simulate" title="What a crash would do">
              <p className="text-[13px] leading-relaxed text-muted">
                Support lapses only under a sell-off that holds for a full TWAP window. This finds the smallest one that would strand support and runs it on a
                simulated chain: the sale in the next block, the vault read back {duration(v.terms.twapWindow + CRASH_HOLD_MARGIN_S)} later. Nothing is sent.
              </p>
              <Button className="mt-4 w-full" onClick={simulateCrash} disabled={sim === "running"}>
                {sim === "running" ? "Simulating…" : "Simulate a crash"}
              </Button>
              {sim && sim !== "running" && sim.result?.restore?.ok && (
                <div className="mt-4">
                  {sim.deepened && (
                    <p className="mb-2 text-xs text-faint">After the curator spreads half the reserve four bands deep, the layout restore exists for:</p>
                  )}
                  {/* the fall the simulated sale reached (it stops at its price limit, or when the seller runs out) */}
                  <Row label="The market sells">{`${amt(eth(sim.result.sold))} ${v.tokenSymbol}, ${fallPct(v.spotTick - sim.result.after.spotTick)} down`}</Row>
                  <Row label={`Support ${duration(v.terms.twapWindow + CRASH_HOLD_MARGIN_S)} later`}>{`${pct(sim.result.after.support.have)} (needs ${pct(sim.result.after.support.need)})`}</Row>
                  <Row label="A restore by anyone">{`${pct(sim.result.after.support.have)} → ${sim.result.restore.supportAfter !== undefined ? pct(sim.result.restore.supportAfter) : "not read"}`}</Row>
                </div>
              )}
              {sim && sim !== "running" && sim.error && <p className="mt-3 text-xs text-faint">Could not simulate: {sim.error}</p>}
              {sim && sim !== "running" && !sim.error && !sim.result?.restore?.ok && (
                <p className="mt-3 text-xs text-faint">
                  {sim.noDeeper
                    ? `No sell-off of the issuer's tokens strands support with the vault laid out as it is: every bid stays within reach of the price. A deeper reserve could not be tried, because the curator's reshape would be refused now: ${sim.noDeeper}`
                    : "No sell-off of the issuer's tokens strands support here, even with the reserve spread deeper: every bid stays within reach of the price."}
                </p>
              )}
            </Panel>
          )}
          {!lapsed && !publicChain && (
            <Panel eyebrow="Simulate" title="Make support lapse">
              <p className="text-[13px] leading-relaxed text-muted">
                Have the market sell the token down until the vault&apos;s reserve sits under the band, then hold the price there until the time-weighted
                average has followed it. The app finds the smallest sell-off that does this, in a sandbox first.
              </p>
              <Button className="mt-4 w-full" onClick={runCrash} disabled={!!busy}>
                Run a crash
              </Button>
            </Panel>
          )}

          <Panel eyebrow="Anchor" title="Keep the Anchor in sync">
            <p className="text-[13px] leading-relaxed text-muted">
              The Anchor only climbs while someone syncs it, at most one band per epoch. Every vault action syncs it; a keeper can too, for free.
            </p>
            {/* Open to anyone: the connected wallet sends it, or with none the backend's relayer. */}
            <SendButton verb="poke" className="mt-4 w-full" variant={relayLeads ? "ghost" : "secondary"} onClick={poke} disabled={!!busy}>
              Call poke()
            </SendButton>
            <RelayButton action="poke" title="Sync the Anchor (poke)" className="mt-2 w-full" prominent={relayLeads} />
            <OnRecord fn="poke" className="mt-3 text-center" refusal={false} />
          </Panel>
        </div>
      </div>
    </>
  );
}
