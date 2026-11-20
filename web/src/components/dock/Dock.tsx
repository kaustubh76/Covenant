"use client";

// The rest of the world, on the chain the app is on: move the clock, trade against the vault, fund the account you act
// as, keep a save point, reset. On a dev chain (the local one, the Playground) every control is real and immediate. On
// a public chain the vault is shared, so only small trades that stay inside the guard are offered.
//
// Layout: every group in one row from `xl` up; below that the clock stays in the row (from `md`) and the rest opens
// in a panel above it, so the dock never scrolls sideways. On a phone the panel also carries the role, which the top
// bar has no room for there.

import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { Bookmark, ChevronDown, ChevronUp, Coins, Pickaxe, RotateCcw, SlidersHorizontal, Undo2 } from "lucide-react";
import { type ComponentProps, type ReactNode, useEffect, useState } from "react";
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
import { ROLES, type Role, actorFor, useChain } from "@/store/chain";
import { useRelay } from "@/lib/useRelay";

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
  const setRole = useChain((s) => s.setRole);
  const netKey = useChain((s) => s.netKey);
  const savePoints = useChain((s) => s.savePoints);
  const savePoint = useChain((s) => s.savePoint);
  const backToSavePoint = useChain((s) => s.backToSavePoint);
  const dev = useChain((s) => s.net?.caps.devChain ?? true);
  const wallet = useChain((s) => s.wallet);
  const relayer = useRelay();
  const viaRelay = !wallet && relayer.enabled;
  // No wallet and no relayer (off, or still waking): a trade can only start by connecting one.
  const connectFirst = !wallet && !viaRelay;
  const connect = () => {
    const { wallets, connectWallet } = useChain.getState();
    if (wallets[0]) void connectWallet(wallets[0].id);
    else useChain.getState().record({ actor: "anyone", title: "No wallet in this browser", ok: false, error: { name: "NotSent", args: [], signature: "Not sent", rule: "Other", reason: "Install a browser wallet to trade on Base Sepolia, or open the Playground, which needs none." } }, { toast: true });
  };
  const tradeTitle = viaRelay ? "Sent by Covenant's backend: no wallet needed" : connectFirst ? (relayer.waking ? "Covenant's backend is waking up. Or connect a wallet to trade" : "Connect a wallet to trade") : undefined;
  const [size, setSize] = useState("5");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
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

  const readout = (
    // as tall as a rail of buttons, so every group's name lines up
    <div className="flex h-[32px] items-center gap-2 whitespace-nowrap">
      <span className="num text-[13px] text-ink" title={`block ${view.block}`}>
        T+{duration(Math.max(0, view.time - view.lock.adoptedAt))}
      </span>
      <span className="num text-[13px] text-muted">
        {price(priceAt(view.spot))} {view.quoteSymbol}
      </span>
    </div>
  );

  // A public chain's vault is shared: a trade that moved spot past the guard would hold every curator's and
  // depositor's action until the TWAP caught up. These stay well inside it.
  if (!dev) {
    return (
      <Shell>
        <Bar>
          <Labeled label="Chain">{readout}</Labeled>
          <Divider />
          <Labeled
            // said on the face, not only in a tooltip a touch screen never shows
            label={viaRelay ? "Market · via backend" : "Market"}
            title={`Small on purpose: this vault is shared, and moving spot more than the guard (${view.terms.guardTicks} ticks) from its average would hold everyone's reshapes and deposits until it settles.`}
          >
            <Seg>
              {/* With no wallet, the backend's relayer makes these two small trades when it is on. */}
              <Btn onClick={() => (viaRelay ? void relayer.send("sell", `Market sells 1 ${sym}`) : connectFirst ? connect() : sell(1))} title={tradeTitle}>
                Sell 1
              </Btn>
              <Btn onClick={() => (viaRelay ? void relayer.send("buy", `Market buys ${sym} up 1%`) : connectFirst ? connect() : move(1))} title={tradeTitle}>
                Buy +1%
              </Btn>
            </Seg>
          </Labeled>
        </Bar>
      </Shell>
    );
  }

  const clock = (
    <Seg>
      <Btn onClick={() => wait("A minute passes", 60)}>+1m</Btn>
      <Btn onClick={() => wait(`The TWAP window passes (${duration(twap)})`, twap)} title="One TWAP window: long enough for the average to catch up with spot">
        +{duration(twap)}
      </Btn>
      <Btn onClick={() => wait("An hour passes", 3600)}>+1h</Btn>
      <Btn onClick={() => wait("A day passes", 86400)}>+1d</Btn>
      {ahead.length > 0 && (
        <label className={clsx("relative flex h-7 items-center gap-1 rounded-md pl-2.5 pr-2 text-[12.5px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink", busy && "pointer-events-none opacity-40")}>
          Jump to
          <ChevronDown size={12} strokeWidth={2} className="text-faint" />
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
      <Btn onClick={() => void mine()} title="Mine one block, one second later" aria-label="Mine a block">
        <Pickaxe size={13} strokeWidth={1.8} />
      </Btn>
    </Seg>
  );
  const market = (
    <div className="flex flex-wrap items-center gap-1.5">
      <label className={clsx("flex h-[32px] items-center rounded-lg border bg-bg/50 pr-2.5 transition-colors focus-within:border-muted", sizeOk ? "border-line" : "border-breach/60")}>
        <input
          aria-label={`Trade size in ${sym}`}
          value={size}
          inputMode="decimal"
          onChange={(e) => setSize(e.target.value.replace(/[^0-9.]/g, ""))}
          className="num h-full w-12 bg-transparent pl-2 pr-1.5 text-right text-[12.5px] text-ink outline-none"
        />
        <span className="max-w-[56px] truncate text-[11px] tracking-wide text-faint">{sym}</span>
      </label>
      <Seg>
        <Btn disabled={!sizeOk} onClick={() => sell(n)}>
          Sell
        </Btn>
        <Btn disabled={!sizeOk} onClick={() => buy(n)}>
          Buy
        </Btn>
      </Seg>
      <Seg>
        <Btn onClick={() => move(-20)} title="Sell until spot is 20% lower: a crash">
          −20%
        </Btn>
        <Btn onClick={() => move(-5)}>−5%</Btn>
        <Btn onClick={() => move(5)}>+5%</Btn>
        <Btn onClick={() => move(20)} title="Buy until spot is 20% higher: a pump">
          +20%
        </Btn>
      </Seg>
    </div>
  );
  const accounts = (
    <Seg>
      <Btn onClick={() => void fund()} title={`Give the ${ACTOR_LABEL[actor]} 100 ${view.quoteSymbol} and 1,000 ${sym}`}>
        <Coins size={13} strokeWidth={1.8} /> Fund {ACTOR_LABEL[actor]}
      </Btn>
      <Btn onClick={() => void savePoint()} title="Remember the chain as it is now, to come back to">
        <Bookmark size={13} strokeWidth={1.8} /> Save
      </Btn>
      <Btn
        disabled={!savePoints.length}
        onClick={() => void backToSavePoint()}
        title={savePoints.length ? `Back to the save point at T+${duration(Math.max(0, savePoints[savePoints.length - 1].at - view.lock.adoptedAt))}` : "Take a save point first"}
      >
        {/* not a bare "Back": the Playground's bar has "Back to Base Sepolia" */}
        <Undo2 size={13} strokeWidth={1.8} /> Back to save{savePoints.length > 1 ? ` (${savePoints.length})` : ""}
      </Btn>
    </Seg>
  );
  // The Playground's bar under the top bar has its own reset, beside what the chain is.
  const resetButton =
    netKey === "playground" ? null : (
      <Button size="xs" variant="ghost" disabled={!!busy} onClick={() => void reset()} title="Put the chain back to the freshly seeded launch">
        <RotateCcw size={13} strokeWidth={1.8} /> Reset
      </Button>
    );
  // The top bar shows the role from `sm` up; on a phone it lives here.
  const rolePick = (
    <label className={clsx("relative flex h-[32px] items-center gap-1.5 rounded-lg border border-line bg-bg/50 pl-2.5 pr-7 text-[12.5px] text-ink sm:hidden", busy && "opacity-50")}>
      <span className="text-faint">Acting as</span>
      <span className="font-medium">{ROLES.find((r) => r.key === role)?.name}</span>
      <ChevronDown size={13} className="pointer-events-none absolute right-2 text-faint" />
      <select aria-label="Acting as" value={role} disabled={!!busy} onChange={(e) => setRole(e.target.value as Role)} className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed">
        {ROLES.map((r) => (
          <option key={r.key} value={r.key}>
            {r.name} — {r.does}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <Shell>
      <AnimatePresence>
        {open && (
          <motion.div
            id="dock-panel"
            role="region"
            aria-label="Chain controls"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.18, ease: [0.2, 0.7, 0.2, 1] }}
            className="absolute inset-x-0 bottom-full max-h-[min(70vh,520px)] overflow-y-auto border-t border-line bg-surface shadow-[0_-16px_40px_-24px_rgba(0,0,0,0.6)] xl:hidden"
          >
            <div className="mx-auto grid max-w-[1320px] gap-4 px-4 py-4 md:px-8">
              <Row label="Clock" className="md:hidden">
                {clock}
              </Row>
              <Row label="Market">{market}</Row>
              <Row label="Accounts">
                {rolePick}
                {accounts}
              </Row>
              {resetButton && <Row label="Chain">{resetButton}</Row>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <Bar>
        <Labeled label="Chain">{readout}</Labeled>
        <Divider show="hidden md:block" />
        <Labeled label="Clock" show="hidden md:flex">
          {clock}
        </Labeled>
        <Divider show="hidden xl:block" />
        <Labeled label="Market" show="hidden xl:flex">
          {market}
        </Labeled>
        <Divider show="hidden xl:block" />
        <Labeled label="Accounts" show="hidden xl:flex">
          {accounts}
        </Labeled>
        <div className="ml-auto flex shrink-0 items-center">
          {resetButton && <div className="hidden xl:block">{resetButton}</div>}
          <Button size="sm" variant={open ? "secondary" : "ghost"} className="xl:hidden" aria-expanded={open} aria-controls="dock-panel" onClick={() => setOpen((o) => !o)}>
            <SlidersHorizontal size={14} strokeWidth={1.8} />
            Controls
            <ChevronUp size={14} strokeWidth={1.8} className={clsx("transition-transform duration-200", open && "rotate-180")} />
          </Button>
        </div>
      </Bar>
    </Shell>
  );
}

/** Above the page and the activity pill (z-40), below the toasts (z-50), so an open panel never hides a result. */
function Shell({ children }: { children: ReactNode }) {
  return <div className="fixed inset-x-0 bottom-0 z-[41] border-t border-line bg-surface/95 backdrop-blur">{children}</div>;
}

function Bar({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex h-14 max-w-[1320px] items-center gap-4 px-4 md:px-8">{children}</div>;
}

/** A group in the bar: its name over its controls. `show` sets when it is displayed (it is `flex` when shown). */
function Labeled({ label, title, show = "flex", children }: { label: string; title?: string; show?: string; children: ReactNode }) {
  return (
    <div className={clsx("shrink-0 flex-col justify-center gap-1", show)} title={title}>
      <span className="eyebrow text-[9.5px] leading-none">{label}</span>
      {children}
    </div>
  );
}

/** A group in the panel: its name beside its controls, or over them on a phone. */
function Row({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={clsx("flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4", className)}>
      <span className="eyebrow w-20 shrink-0">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

/** Buttons that belong together, joined in one rail. */
function Seg({ children }: { children: ReactNode }) {
  return <div className="inline-flex items-center gap-px rounded-lg border border-line bg-bg/50 p-[1px]">{children}</div>;
}

/** A dock button: held while anything runs, since each action is asked for against the chain as it is now. */
function Btn({ disabled, ...rest }: ComponentProps<typeof Button>) {
  const busy = useChain((s) => s.busy);
  return <Button size="xs" variant="ghost" disabled={!!busy || disabled} {...rest} />;
}

const Divider = ({ show = "block" }: { show?: string }) => <div className={clsx("h-8 w-px shrink-0 bg-line", show)} />;
