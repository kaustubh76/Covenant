"use client";

// The rest of the world, on the chain the app is on: move the clock, trade against the vault, fund the account you act
// as, keep a save point, reset. On a dev chain (the local one, the Playground) every control is real and immediate. On
// a public chain the vault is shared, so only small trades that stay inside the guard are offered.

import clsx from "clsx";
import { Bookmark, Coins, Pickaxe, RotateCcw, Undo2 } from "lucide-react";
import { useState } from "react";
import { parseEther } from "viem";
import { testTokenAbi } from "@/chain/abi.generated";
import { ACTOR_LABEL } from "@/chain/accounts";
import { beatOf, note } from "@/chain/beat";
import { devControls } from "@/chain/client";
import { pushTo, spotOf, swap } from "@/chain/market";
import { milestones } from "@/chain/milestones";
import { priceAt, ticksToPct } from "@/chain/price";
import { advance } from "@/chain/time";
import { must, send } from "@/chain/tx";
import { Button } from "@/components/ui";
import { duration, price } from "@/lib/format";
import { actorFor, useChain } from "@/store/chain";

const moveDetail = (before: number, after: number) => {
  const d = after - before;
  return `Spot moves ${d >= 0 ? "+" : "−"}${Math.abs(Math.round(d))} ticks (${d >= 0 ? "+" : "−"}${Math.abs(ticksToPct(d)).toFixed(1)}%)`;
};
const amount = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 1 ? String(Number(n.toFixed(2))) : n.toPrecision(2));

export function Dock() {
  const view = useChain((s) => s.view);
  const run = useChain((s) => s.run);
  const reset = useChain((s) => s.reset);
  const busy = useChain((s) => s.busy);
  const role = useChain((s) => s.role);
  const savePoints = useChain((s) => s.savePoints);
  const savePoint = useChain((s) => s.savePoint);
  const backToSavePoint = useChain((s) => s.backToSavePoint);
  const dev = useChain((s) => s.net?.caps.devChain ?? true);
  const [size, setSize] = useState("5");
  if (!view) return null;
  const sym = view.tokenSymbol;
  const n = Number(size);
  const sizeOk = Number.isFinite(n) && n > 0 && n <= 1_000_000;
  const ahead = milestones(view);
  const twap = view.terms.twapWindow;
  const actor = actorFor(role, view);

  const wait = (label: string, seconds: number) =>
    run(label, async (ctx, rec) => {
      await advance(ctx, seconds);
      rec.record(note("anyone", label, "Chain time moves forward; the TWAP follows the last price"), { toast: true });
    });
  const mine = () =>
    run("A block is mined", async (ctx, rec) => {
      await devControls(ctx).mine({ blocks: 1 });
      rec.record(note("anyone", "A block is mined", "One more block, one second later"));
    });
  const sell = (tokens: number) =>
    run(`Market sells ${amount(tokens)} ${sym}`, async (ctx, rec) => {
      const before = await spotOf(ctx, view);
      const o = await swap(ctx, view, "market", false, parseEther(tokens.toFixed(18)));
      const after = await spotOf(ctx, view);
      rec.record(beatOf(o, "market", `Market sells ${amount(tokens)} ${sym}`, () => moveDetail(before, after)), { toast: true });
    });
  const buy = (tokens: number) =>
    run(`Market buys about ${amount(tokens)} ${sym}`, async (ctx, rec) => {
      const before = await spotOf(ctx, view);
      // An exact-input buy: pay what the tokens cost at the price now; slippage means a little fewer arrive.
      const eth = tokens * priceAt(before);
      const o = await swap(ctx, view, "market", true, parseEther(eth.toFixed(18)));
      const after = await spotOf(ctx, view);
      rec.record(beatOf(o, "market", `Market buys about ${amount(tokens)} ${sym}`, () => `${moveDetail(before, after)}, for ${amount(eth)} ${view.quoteSymbol}`), { toast: true });
    });
  const move = (pct: number) =>
    run(`Market moves the price ${pct > 0 ? "+" : "−"}${Math.abs(pct)}%`, async (ctx, rec) => {
      const before = await spotOf(ctx, view);
      const target = before + Math.log(1 + pct / 100) / Math.log(1.0001);
      // A budget far beyond what the move needs: the price limit stops the swap at the target, and dev chains mint the
      // tokens a sale needs.
      const o = await pushTo(ctx, view, "market", target, parseEther(pct > 0 ? "5000" : "1000000"));
      const after = await spotOf(ctx, view);
      rec.record(beatOf(o, "market", `Market moves the price ${pct > 0 ? "+" : "−"}${Math.abs(pct)}%`, () => moveDetail(before, after)), { toast: true });
    });
  const fund = () =>
    run(`Funding the ${ACTOR_LABEL[actor]}`, async (ctx, rec) => {
      const who = ctx.address(actor);
      const test = devControls(ctx);
      const eth = await ctx.pub.getBalance({ address: who });
      await test.setBalance({ address: who, value: eth + parseEther("100") });
      must(await send(ctx, actor, { address: view.token, abi: testTokenAbi, functionName: "mint", args: [who, parseEther("1000")] }), "minting");
      rec.record(note(actor, `${ACTOR_LABEL[actor]} funded`, `100 more ${view.quoteSymbol} and 1,000 more ${sym}`), { toast: true });
    });

  // A public chain's vault is shared: a trade that moved spot past the guard would hold every curator's and
  // depositor's action until the TWAP caught up. These stay well inside it.
  const publicMarket = (
    <Group label="Market" title={`Small on purpose: this vault is shared, and moving spot more than the guard (${view.terms.guardTicks} ticks) from its average would hold everyone's reshapes and deposits until it settles.`}>
      <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => sell(1)}>
        Sell 1
      </Button>
      <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => move(1)}>
        Buy +1%
      </Button>
    </Group>
  );

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur">
      <div className="scroll-x mx-auto flex h-12 max-w-[1320px] items-center gap-4 px-4 md:px-8">
        <div className="flex shrink-0 items-baseline gap-2">
          <span className="eyebrow">Chain</span>
          <span className="num text-[13px] text-ink" title={`block ${view.block}`}>
            T+{duration(Math.max(0, view.time - view.lock.adoptedAt))}
          </span>
          <span className="num text-[13px] text-muted">
            {price(priceAt(view.spot))} {view.quoteSymbol}
          </span>
        </div>
        <Divider />
        {dev ? (
          <>
            <Group label="Clock">
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => wait("A minute passes", 60)}>
                +1m
              </Button>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => wait(`The TWAP window passes (${duration(twap)})`, twap)} title="One TWAP window: long enough for the average to catch up with spot">
                +{duration(twap)}
              </Button>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => wait("An hour passes", 3600)}>
                +1h
              </Button>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => wait("A day passes", 86400)}>
                +1d
              </Button>
              {ahead.length > 0 && (
                <label className={clsx("relative flex h-8 items-center rounded-md px-3 text-[13px] text-muted hover:bg-raised hover:text-ink", busy && "pointer-events-none opacity-40")}>
                  Jump to…
                  <select
                    aria-label="Jump the clock to"
                    value=""
                    disabled={!!busy}
                    onChange={(e) => {
                      const m = ahead.find((x) => x.key === e.target.value);
                      if (m) void wait(`Jump: ${m.label.toLowerCase()}`, m.at - view.time + 1);
                    }}
                    className="absolute inset-0 cursor-pointer opacity-0"
                  >
                    <option value="" disabled>
                      Jump to…
                    </option>
                    {ahead.map((m) => (
                      <option key={m.key} value={m.key}>
                        {m.label}, in {duration(m.at - view.time)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void mine()} title="Mine one block, one second later">
                <Pickaxe size={13} />
              </Button>
            </Group>
            <Divider />
            <Group label="Market">
              <input
                aria-label={`Trade size in ${sym}`}
                value={size}
                inputMode="decimal"
                onChange={(e) => setSize(e.target.value.replace(/[^0-9.]/g, ""))}
                className={clsx("num h-8 w-16 rounded-md border bg-transparent px-2 text-right text-[13px] text-ink outline-none", sizeOk ? "border-line-strong" : "border-breach/60")}
              />
              <span className="text-[12px] text-faint">{sym}</span>
              <Button size="sm" variant="ghost" disabled={!!busy || !sizeOk} onClick={() => sell(n)}>
                Sell
              </Button>
              <Button size="sm" variant="ghost" disabled={!!busy || !sizeOk} onClick={() => buy(n)}>
                Buy
              </Button>
              <span className="mx-0.5 h-4 w-px bg-line" />
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => move(-20)} title="Sell until spot is 20% lower: a crash">
                −20%
              </Button>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => move(-5)}>
                −5%
              </Button>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => move(5)}>
                +5%
              </Button>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => move(20)} title="Buy until spot is 20% higher: a pump">
                +20%
              </Button>
            </Group>
            <Divider />
            <Group label="Accounts">
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void fund()} title={`Give the ${ACTOR_LABEL[actor]} 100 ${view.quoteSymbol} and 1,000 ${sym}`}>
                <Coins size={13} /> Fund {ACTOR_LABEL[actor]}
              </Button>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void savePoint()} title="Remember the chain as it is now, to come back to">
                <Bookmark size={13} /> Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!!busy || !savePoints.length}
                onClick={() => void backToSavePoint()}
                title={savePoints.length ? `Back to the save point at T+${duration(Math.max(0, savePoints[savePoints.length - 1].at - view.lock.adoptedAt))}` : "Take a save point first"}
              >
                <Undo2 size={13} /> Back to save{savePoints.length > 1 ? ` (${savePoints.length})` : ""}
              </Button>
            </Group>
            <div className="ml-auto shrink-0">
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void reset()} title="Put the chain back to the freshly seeded launch">
                <RotateCcw size={13} /> Reset
              </Button>
            </div>
          </>
        ) : (
          publicMarket
        )}
      </div>
    </div>
  );
}

function Group({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5" title={title}>
      <span className="eyebrow mr-1">{label}</span>
      {children}
    </div>
  );
}

const Divider = () => <div className="h-5 w-px shrink-0 bg-line" />;
