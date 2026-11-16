"use client";

import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { covenantVaultAbi } from "@/chain/abi.generated";
import { beatOf, note } from "@/chain/beat";
import { type Preflight, vaultEvents } from "@/chain/preflight";
import { LN_BASE } from "@/chain/price";
import { crash, findLapsingCrash, planRestore, restoreCall } from "@/chain/scenarios/restore";
import { send } from "@/chain/tx";
import { readVaultView } from "@/chain/view";
import { NeedsChain } from "@/components/chain/NeedsChain";
import { RuleRail } from "@/components/covenant/RuleRail";
import { ShapeChart, ShapeLegend } from "@/components/covenant/ShapeChart";
import { Button, PageHeader, Panel, Row, Tag } from "@/components/ui";
import { amt, duration, pct } from "@/lib/format";
import { describeRange } from "@/lib/ranges";
import { useBalances } from "@/lib/useBalances";
import { actorFor, useChain } from "@/store/chain";

const fallPct = (ticks: number) => `${((1 - Math.exp(-ticks * LN_BASE)) * 100).toFixed(0)}%`;
const eth = (x: unknown) => Number(formatEther((x as bigint) ?? 0n));

export default function KeepPage() {
  const v = useChain((s) => s.view);
  const ctx = useChain((s) => s.ctx);
  const role = useChain((s) => s.role);
  const run = useChain((s) => s.run);
  const busy = useChain((s) => s.busy);
  const actor = actorFor(role, v);
  const bal = useBalances(actor);
  const [plan, setPlan] = useState<{ indices: number[]; pre: Preflight } | null>(null);

  useEffect(() => {
    if (!ctx || !v) return;
    let live = true;
    planRestore(ctx, v, actor)
      .then((p) => live && setPlan(p))
      .catch(() => live && setPlan(null));
    return () => {
      live = false;
    };
  }, [ctx, v, actor]);

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
      const p = await planRestore(c, latest, actor);
      const indices = [...(p?.indices ?? [])].sort((a, b) => a - b);
      const o = await send(c, actor, restoreCall(latest, indices), { force: true, describe });
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

  const poke = () =>
    run("Sync the Anchor", async (c, rec) => {
      const o = await send(c, actor, { address: v.address, abi: covenantVaultAbi, functionName: "poke", args: [] });
      rec.record(beatOf(o, actor, "Anchor synced (poke)", () => "Anyone can call it. It only ever moves the Anchor by the rule"), { toast: true });
    });

  return (
    <>
      <PageHeader
        eyebrow="Keeper"
        title="When a sell-off strands support, anyone can bring it back."
        lead="Support is measured in a band under the time-weighted price. A lasting sell-off drags the band down and can leave the vault's reserve beneath it. Restore is open to every address and pays a bounty, so it never depends on the curator showing up. A rally cannot lapse it: asks the vault sold count as support."
        aside={<Tag tone={lapsed ? "breach" : "pass"}>{lapsed ? "Support has lapsed" : "Support holding"}</Tag>}
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
              <Row label="Bounty for the caller">{amt(bounty)} ETH</Row>
              <Row label="Bounty pool">{amt(v.fees.bountyPool)} ETH</Row>
              <Row label="Your balance">{bal ? `${amt(bal.quote)} ETH` : "…"}</Row>
            </div>

            <Button variant={plan?.pre.ok ? "primary" : "secondary"} className="mt-5 w-full" onClick={restore} disabled={!!busy}>
              {plan?.pre.ok ? "Call restore" : "Call restore anyway"}
            </Button>
            <p className="mt-2 text-center text-xs text-faint">
              {!g.ok
                ? "The guard is tripped: restore will revert until the price settles."
                : plan?.pre.ok
                  ? "Open to any address. No permission needed."
                  : (plan?.pre.error?.reason ?? "It will revert and pay nothing. The bounty cannot be farmed.")}
            </p>
          </Panel>

          {!lapsed && (
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
            <Button className="mt-4 w-full" variant="ghost" onClick={poke} disabled={!!busy}>
              Call poke()
            </Button>
          </Panel>
        </div>
      </div>
    </>
  );
}
