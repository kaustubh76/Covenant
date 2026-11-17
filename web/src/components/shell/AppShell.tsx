"use client";

import clsx from "clsx";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { ChevronDown, Loader2, Moon, RotateCcw, Sun, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { parseEther } from "viem";
import { shortAddress } from "@/chain/accounts";
import { beatOf, note } from "@/chain/beat";
import { type NetworkKey, explorerTx } from "@/chain/network";
import { pushTo, spotOf, swap } from "@/chain/market";
import { priceAt, ticksToPct } from "@/chain/price";
import { advance } from "@/chain/time";
import { Button, Dot, Tag } from "@/components/ui";
import { duration, price } from "@/lib/format";
import { ROLES, type Role, useChain } from "@/store/chain";

const NAV = [
  { href: "/vault", label: "Vault" },
  { href: "/launch", label: "Launch" },
  { href: "/curate", label: "Curate" },
  { href: "/keep", label: "Keep" },
  { href: "/provide", label: "Provide" },
  { href: "/govern", label: "Govern" },
  { href: "/attacks", label: "Attack lab" },
  { href: "/demo", label: "Guided demo" },
];

export function Seal({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="12" cy="12" r="10.2" />
      <path d="M7 16V9.5a5 5 0 0 1 10 0V16" strokeLinecap="round" />
      <path d="M5.5 16h13" strokeLinecap="round" />
    </svg>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }, []);
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("covenant-theme", next);
    } catch {
      /* private mode */
    }
    setTheme(next);
  };
  return (
    <button onClick={flip} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} className="grid h-9 w-9 place-items-center rounded-md text-muted transition-colors hover:bg-raised hover:text-ink">
      {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

/**
 * Which party the pages act as. Locally each role signs with its own dev account. On a public chain the connected wallet
 * signs everything, so the list says which roles are really yours: anyone can keep or provide, but only the vault's
 * issuer and curator can act as them (the pages still preview what they could do).
 */
function RoleSwitcher() {
  const role = useChain((s) => s.role);
  const setRole = useChain((s) => s.setRole);
  const net = useChain((s) => s.net);
  const view = useChain((s) => s.view);
  const wallet = useChain((s) => s.wallet);
  const mine = (r: Role) => {
    if (!net || net.caps.devChain) return null;
    const holder = r === "issuer" ? view?.people.issuer : r === "curator" ? view?.people.curator : null;
    if (!holder) return "open to anyone";
    return wallet && holder.toLowerCase() === wallet.address.toLowerCase() ? "your wallet" : `${shortAddress(holder)} only`;
  };
  return (
    <label className="relative flex h-9 items-center gap-2 rounded-md border border-line-strong pl-3 pr-8 text-[13px] text-ink hover:border-muted">
      <span className="hidden text-faint sm:inline">Acting as</span>
      <span className="font-medium">{ROLES.find((r) => r.key === role)?.name}</span>
      <ChevronDown size={14} className="pointer-events-none absolute right-2.5 text-faint" />
      <select aria-label="Acting as" value={role} onChange={(e) => setRole(e.target.value as Role)} className="absolute inset-0 cursor-pointer opacity-0">
        {ROLES.map((r) => (
          <option key={r.key} value={r.key}>
            {r.name} — {mine(r.key) ?? r.does}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Which chain the app reads and signs on: the local chain, Base Sepolia, or the rehearsal fork of it. */
function NetworkSwitcher() {
  const netKey = useChain((s) => s.netKey);
  const networks = useChain((s) => s.networks);
  const setNetwork = useChain((s) => s.setNetwork);
  const loadNetworks = useChain((s) => s.loadNetworks);
  useEffect(() => {
    void loadNetworks();
  }, [loadNetworks]);
  const current = networks.find((n) => n.key === netKey);
  return (
    <label className="relative flex h-9 items-center gap-2 rounded-md border border-line-strong pl-3 pr-8 text-[13px] text-ink hover:border-muted" title={current?.reason}>
      <Dot tone={current?.state === "ready" ? "pass" : current ? "breach" : "neutral"} />
      {/* On a phone the dot says it: there is room for the wordmark and the wallet, not for the name too. */}
      <span className="hidden max-w-[130px] truncate font-medium sm:inline">{current?.name ?? "Network"}</span>
      <ChevronDown size={14} className="pointer-events-none absolute right-2.5 text-faint" />
      <select
        aria-label="Network"
        value={netKey ?? "local"}
        onFocus={() => void loadNetworks()}
        onChange={(e) => void setNetwork(e.target.value as NetworkKey)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {networks.map((n) => (
          <option key={n.key} value={n.key}>
            {n.name} — {n.state === "ready" ? "live" : "offline"}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The browser wallet that signs on a public chain: connect it, put it on the right chain, or let it go. */
function WalletControl() {
  const net = useChain((s) => s.net);
  const netKey = useChain((s) => s.netKey);
  const wallet = useChain((s) => s.wallet);
  const wallets = useChain((s) => s.wallets);
  const walletError = useChain((s) => s.walletError);
  const connectWallet = useChain((s) => s.connectWallet);
  const disconnectWallet = useChain((s) => s.disconnectWallet);
  const switchWalletChain = useChain((s) => s.switchWalletChain);
  if (!netKey || netKey === "local") return null;
  if (!wallet) {
    return (
      <Button size="sm" variant="secondary" onClick={() => void connectWallet(wallets[0]?.id)} title={walletError ?? (wallets.length ? `Connect ${wallets.map((w) => w.name).join(" or ")}` : "No browser wallet found")}>
        <Wallet size={14} /> Connect wallet
      </Button>
    );
  }
  if (net && wallet.chainId !== net.chainId) {
    return (
      <Button size="sm" variant="danger" onClick={() => void switchWalletChain()} title={`${wallet.name} is on chain ${wallet.chainId}`}>
        <span className="sm:hidden">Switch network</span>
        <span className="hidden sm:inline">Switch to {net.name}</span>
      </Button>
    );
  }
  return (
    <button
      onClick={disconnectWallet}
      title={`${wallet.name} · ${wallet.address}. Click to disconnect.`}
      className="num flex h-9 items-center gap-2 rounded-md border border-line-strong px-3 text-[13px] text-ink hover:border-muted"
    >
      <Dot tone="pass" />
      {shortAddress(wallet.address)}
    </button>
  );
}

/** What the app is doing right now, and when it has no chain, why. Live is the switcher's green dot beside it. */
function ChainStatus() {
  const status = useChain((s) => s.status);
  const reason = useChain((s) => s.reason);
  const busy = useChain((s) => s.busy);
  if (busy) {
    return (
      <span className="hidden items-center gap-1.5 text-[12px] text-muted sm:flex" aria-live="polite">
        <Loader2 size={13} className="animate-spin" />
        <span className="max-w-[220px] truncate">{busy}</span>
      </span>
    );
  }
  if (status === "ready") return null;
  const tone = status === "offline" ? "breach" : "neutral";
  return (
    <span className="hidden sm:inline-flex" title={reason ?? undefined}>
      <Tag tone={tone}>
        <Dot tone={tone} />
        {status === "offline" ? "Offline" : "Connecting"}
      </Tag>
    </span>
  );
}

function TopBar() {
  const path = usePathname();
  // over the landing hero the bar is clear, and becomes solid once the page scrolls
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  const clear = path === "/" && !scrolled;
  return (
    <header className={clsx("sticky top-0 z-40 border-b transition-colors duration-300", clear ? "border-transparent bg-transparent" : "border-line bg-bg/85 backdrop-blur-md")}>
      <div className="mx-auto flex h-14 max-w-[1320px] items-center gap-3 px-4 sm:gap-6 md:px-8">
        <Link href="/" className="flex items-center gap-2.5 text-ink">
          <Seal className="h-[22px] w-[22px] text-accent" />
          <span className="display text-[22px] leading-none">Covenant</span>
        </Link>
        <nav className="scroll-x hidden min-w-0 flex-1 items-center gap-1 lg:flex" aria-label="Main">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={path === n.href ? "page" : undefined}
              className={clsx("whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px] transition-colors", path === n.href ? "bg-raised text-ink" : "text-muted hover:text-ink")}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ChainStatus />
          <NetworkSwitcher />
          <WalletControl />
          {/* Not on a phone: Curate, Provide and Govern each have their own "Act as" button, and the theme follows the system. */}
          <div className="hidden items-center gap-2 sm:flex">
            <RoleSwitcher />
            <ThemeToggle />
          </div>
        </div>
      </div>
      <nav className="scroll-x flex items-center gap-1 border-t border-line px-3 py-1.5 lg:hidden" aria-label="Main">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-current={path === n.href ? "page" : undefined}
            className={clsx("whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px]", path === n.href ? "bg-raised text-ink" : "text-muted")}
          >
            {n.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

const moveDetail = (before: number, after: number) => {
  const d = after - before;
  return `Spot moves ${d >= 0 ? "+" : "−"}${Math.abs(Math.round(d))} ticks (${d >= 0 ? "+" : "−"}${Math.abs(ticksToPct(d)).toFixed(1)}%)`;
};

/** The rest of the world, on the real chain: move the clock, trade against the vault, or reset to the seeded launch. */
function LiveDock() {
  const view = useChain((s) => s.view);
  const run = useChain((s) => s.run);
  const reset = useChain((s) => s.reset);
  const busy = useChain((s) => s.busy);
  const dev = useChain((s) => s.net?.caps.devChain ?? true);
  if (!view) return null;
  const sym = view.tokenSymbol;
  const toMidVest = view.lock.unlockStartsAt + (view.lock.fullyVestedAt - view.lock.unlockStartsAt) / 2 - view.time;

  const wait = (label: string, seconds: number) =>
    run(label, async (ctx, rec) => {
      await advance(ctx, seconds);
      rec.record(note("anyone", label, "Chain time moves forward; the TWAP follows the last price"));
    });
  const sell = (n: number) =>
    run(`Market sells ${n} ${sym}`, async (ctx, rec) => {
      const before = await spotOf(ctx, view);
      const o = await swap(ctx, view, "market", false, parseEther(String(n)));
      const after = await spotOf(ctx, view);
      rec.record(beatOf(o, "market", `Market sells ${n} ${sym}`, () => moveDetail(before, after)), { toast: true });
    });
  const lift = (pctUp: number) =>
    run(`Market buys ${sym} up ${pctUp}%`, async (ctx, rec) => {
      const before = await spotOf(ctx, view);
      const target = before + Math.log(1 + pctUp / 100) / Math.log(1.0001);
      const o = await pushTo(ctx, view, "market", target, parseEther("5000"));
      const after = await spotOf(ctx, view);
      rec.record(beatOf(o, "market", `Market buys ${sym} up ${pctUp}%`, () => moveDetail(before, after)), { toast: true });
    });

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
        <div className="h-5 w-px shrink-0 bg-line" />
        {/* Only the local chain's clock can be moved; a public chain's runs on its own. */}
        <div className={clsx("flex shrink-0 items-center gap-1.5", !dev && "hidden")}>
          <span className="eyebrow mr-1">Clock</span>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => wait("1 hour passes", 3600)}>
            +1h
          </Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => wait("1 day passes", 86400)}>
            +1d
          </Button>
          <Button size="sm" variant="ghost" disabled={!!busy || toMidVest <= 0} onClick={() => wait(`${duration(toMidVest)} pass`, toMidVest)}>
            To mid-vest
          </Button>
        </div>
        <div className={clsx("h-5 w-px shrink-0 bg-line", !dev && "hidden")} />
        {dev ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="eyebrow mr-1">Market</span>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => sell(5)}>
              Sell 5
            </Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => sell(40)}>
              Dump 40
            </Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => lift(10)}>
              Buy +10%
            </Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => lift(25)}>
              Buy +25%
            </Button>
          </div>
        ) : (
          // A public chain's vault is shared: a trade that moved spot past the guard would hold every curator's and
          // depositor's action until the TWAP caught up. These stay well inside it.
          <div className="flex shrink-0 items-center gap-1.5" title={`Small on purpose: this vault is shared, and moving spot more than the guard (${view.terms.guardTicks} ticks) from its average would hold everyone's reshapes and deposits until it settles.`}>
            <span className="eyebrow mr-1">Market</span>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => sell(1)}>
              Sell 1
            </Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => lift(1)}>
              Buy +1%
            </Button>
          </div>
        )}
        <div className={clsx("ml-auto shrink-0", !dev && "hidden")}>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void reset()} title="Revert the chain to the freshly seeded launch">
            <RotateCcw size={13} /> Reset
          </Button>
        </div>
      </div>
    </div>
  );
}

function Toast() {
  const toast = useChain((s) => s.toast);
  const dismiss = useChain((s) => s.dismissToast);
  const net = useChain((s) => s.net);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(dismiss, toast.ok ? 3200 : 7000);
    return () => clearTimeout(t);
  }, [toast, dismiss]);
  const item = toast
    ? { key: toast.id, title: toast.title, ok: toast.ok, detail: toast.detail, signature: toast.error?.signature, reason: toast.error?.reason, hash: toast.hash, notSent: toast.error?.name === "NotSent" }
    : null;
  return (
    <div className="pointer-events-none fixed bottom-16 right-4 z-50 w-[min(380px,calc(100vw-2rem))]" aria-live="polite">
      <AnimatePresence>
        {item && (
          <motion.div
            key={item.key}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.18 }}
            className={clsx("pointer-events-auto rounded-lg border bg-raised p-4 shadow-lg", item.ok ? "border-line-strong" : "refuse border-breach/60")}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-ink">{item.title}</span>
              {/* "Not sent": the pre-flight passed, but the connected wallet cannot sign for this role */}
              <Tag tone={item.ok ? "pass" : item.notSent ? "warn" : "breach"}>{item.ok ? "Settled" : item.notSent ? "Not sent" : "Reverted"}</Tag>
            </div>
            {item.ok ? (
              item.detail && <p className="mt-1.5 text-[13px] text-muted">{item.detail}</p>
            ) : (
              <>
                {item.signature && !item.notSent && <p className="num mt-2 break-words text-[13px] text-breach">{item.signature}</p>}
                {item.reason && <p className="mt-1 text-[13px] leading-relaxed text-muted">{item.reason}</p>}
              </>
            )}
            {item.hash &&
              (net && explorerTx(net, item.hash) ? (
                <a href={explorerTx(net, item.hash)} target="_blank" rel="noreferrer" className="num mt-2 block truncate text-[11px] text-faint underline-offset-2 hover:text-ink hover:underline">
                  tx {item.hash} ↗
                </a>
              ) : (
                <p className="num mt-2 truncate text-[11px] text-faint">tx {item.hash}</p>
              ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  useEffect(() => {
    void useChain.getState().connect();
  }, []);
  const showDock = path !== "/" && path !== "/demo" && path !== "/attacks" && path !== "/launch";
  return (
    <MotionConfig reducedMotion="user">
      <TopBar />
      {path === "/" ? <main>{children}</main> : <main className={clsx("mx-auto max-w-[1320px] px-4 md:px-8", showDock ? "pb-28" : "pb-20")}>{children}</main>}
      {showDock && <LiveDock />}
      <Toast />
    </MotionConfig>
  );
}
