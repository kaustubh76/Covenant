"use client";

import clsx from "clsx";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { ChevronDown, Droplet, Loader2, Moon, Sun, Wallet, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { parseEther } from "viem";
import { shortAddress } from "@/chain/accounts";
import { FAILURE_LABEL, isFailureKind } from "@/chain/failure";
import { NETWORKS, type NetworkKey, explorerTx, isNetworkKey } from "@/chain/network";
import { Button, Dot, Tag } from "@/components/ui";
import { ROLES, type Role, useChain } from "@/store/chain";
import { Dock } from "@/components/dock/Dock";
import { ActivityDrawer } from "./ActivityDrawer";
import { PlaygroundBar } from "./PlaygroundBar";
import { keepsSent, rememberSent } from "@/lib/sentTxs";
import { useRelay } from "@/lib/useRelay";

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
  const busy = useChain((s) => s.busy);
  const mine = (r: Role) => {
    if (!net || net.caps.devChain) return null;
    if (r !== "issuer" && r !== "curator") return "open to anyone";
    // who holds the role is read from the vault: until it is, the menu says so rather than guess
    const holder = r === "issuer" ? view?.people.issuer : view?.people.curator;
    if (!holder) return "loading…";
    return wallet && holder.toLowerCase() === wallet.address.toLowerCase() ? "your wallet" : `${shortAddress(holder)} only`;
  };
  return (
    <label className={clsx("relative flex h-9 items-center gap-2 rounded-md border border-line-strong pl-3 pr-8 text-[13px] text-ink hover:border-muted", busy && "opacity-50")} title={`Acting as ${ROLES.find((r) => r.key === role)?.name ?? role}`}>
      {/* The prefix only from lg to xl: the nav sits in the tab row there, and the bar has room for it beside a wallet
          and an action's label. Narrower, or from xl where the bar also holds the nav, the title says it. */}
      <span className="hidden text-faint lg:inline xl:hidden">Acting as</span>
      <span className="font-medium">{ROLES.find((r) => r.key === role)?.name}</span>
      <ChevronDown size={14} className="pointer-events-none absolute right-2.5 text-faint" />
      {/* Not while an action runs: the action was asked for as the role chosen when it was clicked. */}
      <select aria-label="Acting as" value={role} disabled={!!busy} onChange={(e) => setRole(e.target.value as Role)} className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed">
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
  const busy = useChain((s) => s.busy);
  useEffect(() => {
    void loadNetworks();
    // kept current while the page is open: a backend that went to sleep, or a chain that stopped, shows as such
    const t = setInterval(() => document.visibilityState === "visible" && void loadNetworks(), 60_000);
    return () => clearInterval(t);
  }, [loadNetworks]);
  const current = networks.find((n) => n.key === netKey);
  return (
    <label className={clsx("relative flex h-9 items-center gap-2 rounded-md border border-line-strong pl-3 pr-8 text-[13px] text-ink hover:border-muted", busy && "opacity-50")} title={busy ? `Waiting for: ${busy}` : current?.reason}>
      <Dot tone={current?.state === "ready" ? "pass" : current ? "breach" : "neutral"} />
      {/* On a phone the dot says it: there is room for the wordmark and the wallet, not for the name too. */}
      <span className="hidden max-w-[130px] truncate font-medium sm:inline">{current?.name ?? "Network"}</span>
      <ChevronDown size={14} className="pointer-events-none absolute right-2.5 text-faint" />
      <select
        aria-label="Network"
        value={netKey ?? "local"}
        // Not while an action runs: its result belongs to the network it was sent on.
        disabled={!!busy}
        onFocus={() => void loadNetworks()}
        onChange={(e) => void setNetwork(e.target.value as NetworkKey)}
        className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
      >
        {networks.map((n) => (
          <option key={n.key} value={n.key}>
            {n.name} — {n.state !== "ready" ? "offline" : n.reason ? "waking up" : "live"}
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
  const ctx = useChain((s) => s.ctx);
  const busy = useChain((s) => s.busy);
  const relay = useRelay();
  // A wallet that could not connect or switch says why where everyone sees it, a phone included: a hover title alone
  // reads as a button that does nothing.
  useEffect(() => {
    if (!walletError) return;
    useChain.getState().record({ actor: "anyone", title: "The wallet did not connect", ok: false, error: { name: "NotSent", args: [], signature: "Not connected", rule: "Other", reason: walletError } }, { toast: true });
  }, [walletError]);
  const connect = () => {
    if (wallets[0]) return void connectWallet(wallets[0].id);
    useChain.getState().record(
      { actor: "anyone", title: "No wallet in this browser", ok: false, error: { name: "NotSent", args: [], signature: "Not connected", rule: "Other", reason: "Install a browser wallet (MetaMask, Rabby or Coinbase Wallet) to sign on Base Sepolia, or open the Playground, which needs none." } },
      { toast: true },
    );
  };
  // A wallet on Base Sepolia with almost no ETH can ask the backend for test funds (the relayer's drip).
  const [low, setLow] = useState(false);
  useEffect(() => {
    if (!wallet || !ctx || net?.key !== "base-sepolia" || wallet.chainId !== net.chainId) {
      setLow(false);
      return;
    }
    let live = true;
    ctx.pub
      .getBalance({ address: wallet.address })
      .then((b) => live && setLow(b < parseEther("0.002")))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [wallet, ctx, net]);
  // Dev chains (the local one, the Playground) sign with their own keys: there is no wallet to connect.
  if (!netKey || NETWORKS[netKey].caps.devChain) return null;
  if (!wallet) {
    return (
      <Button size="sm" variant="secondary" onClick={connect} title={walletError ?? (wallets.length ? `Connect ${wallets.map((w) => w.name).join(" or ")}` : "No browser wallet found")}>
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
    <>
      {low && relay.enabled && (
        <Button
          size="sm"
          variant="secondary"
          disabled={!!busy}
          // hidden only once the funds have landed: a refused drip (one a day) leaves the offer, and its toast says why
          onClick={() => void relay.send("drip", "Test funds for your wallet", { to: wallet.address }).then((sent) => sent && setLow(false))}
          title="Covenant's backend sends this wallet a little Base Sepolia ETH and some of the vault's token, once a day"
          aria-label="Get test funds"
        >
          {/* Icon only at every width: the top bar stops widening at 1320 px, and beside the network, the wallet and the
              role the words would push the last nav links out of it. The title and aria-label say what it does. */}
          <Droplet size={14} strokeWidth={1.8} className="text-accent" />
        </Button>
      )}
    <button
      onClick={disconnectWallet}
      title={`${wallet.name} · ${wallet.address}. Click to disconnect.`}
      className="num flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-md border border-line-strong px-3 text-[13px] text-ink hover:border-muted"
    >
      <Dot tone="pass" />
      {shortAddress(wallet.address)}
    </button>
    </>
  );
}

/** What the app is doing right now, and when it has no chain, why. Live is the switcher's green dot beside it. */
function ChainStatus() {
  const status = useChain((s) => s.status);
  const reason = useChain((s) => s.reason);
  const busy = useChain((s) => s.busy);
  // set while the reads after the view on screen keep failing: the numbers are from that block, and the bar says so
  const staleSince = useChain((s) => s.staleSince);
  const readError = useChain((s) => s.readError);
  // Words only from lg to xl, where the nav sits in the tab row and the bar has room. Narrower, the network, the wallet
  // and the role fill the bar; from xl the nav shares it, and a label (up to 220 px while an action runs) would push its
  // last links out. There the badge is its icon, and the words are in its title and for screen readers.
  const words = (text: string) => (
    <span className="sr-only lg:not-sr-only xl:sr-only">
      <span className="block max-w-[220px] truncate">{text}</span>
    </span>
  );
  // From a phone up: below sm only the icon, so a greyed-out page still shows that an action is running.
  if (busy) {
    return (
      <span className="flex items-center gap-1.5 text-[12px] text-muted" aria-live="polite" title={busy}>
        <Loader2 size={13} className="shrink-0 animate-spin" />
        {words(busy)}
      </span>
    );
  }
  if (status === "ready" && staleSince !== null) {
    return (
      <span className="inline-flex" title={`The latest read failed${readError ? `: ${readError}` : ""}. The figures on this page are from block ${staleSince.toLocaleString("en-US")}; the next block tries again.`}>
        <Tag tone="warn">
          <Dot tone="warn" />
          {words(`As of block ${staleSince.toLocaleString("en-US")}`)}
        </Tag>
      </span>
    );
  }
  if (status === "ready") return null;
  if (status !== "offline") {
    return (
      <span className="hidden items-center gap-1.5 text-[12px] text-muted sm:flex" title={reason ?? "Connecting to the chain"}>
        <Loader2 size={13} className="shrink-0 animate-spin" />
        {words("Connecting")}
      </span>
    );
  }
  return (
    <span className="inline-flex" title={reason ?? "Offline"}>
      <Tag tone="breach">
        <Dot tone="breach" />
        {words("Offline")}
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
        {/* From xl: below it, with a wallet connected, the network, the wallet and the role leave the nav too little room. */}
        <nav className="scroll-x hidden min-w-0 flex-1 items-center gap-1 xl:flex" aria-label="Main">
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
      <nav className="scroll-x flex items-center gap-1 border-t border-line px-3 py-1.5 xl:hidden" aria-label="Main">
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

function Toast() {
  const toast = useChain((s) => s.toast);
  const dismiss = useChain((s) => s.dismissToast);
  const net = useChain((s) => s.net);
  useEffect(() => {
    if (!toast) return;
    // A settled transaction's toast carries its link: long enough to click. The activity drawer keeps it after that.
    const t = setTimeout(dismiss, toast.ok ? (toast.hash ? 6500 : 3200) : 7000);
    return () => clearTimeout(t);
  }, [toast, dismiss]);
  // Only the contract's own refusal is "Reverted". A declined wallet request, a wallet on another network, a node that
  // did not answer or a transaction not mined yet each say what they are (chain/failure.ts).
  const kind = toast?.error && isFailureKind(toast.error.name) ? toast.error.name : null;
  const item = toast
    ? { key: toast.id, title: toast.title, ok: toast.ok, detail: toast.detail, signature: toast.error?.signature, reason: toast.error?.reason, hash: toast.hash, kind, unknown: toast.error?.name === "Error", shown: toast.error?.signature !== "Not an ETH vault" }
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
              <div className="flex shrink-0 items-center gap-1.5">
                {/* Settled means a transaction settled: a note that sent nothing (a save point, a fresh chain, a finding) says Note */}
                <Tag tone={item.ok ? (item.hash ? "pass" : "neutral") : item.kind ? "warn" : "breach"}>
                  {item.ok ? (item.hash ? "Settled" : "Note") : !item.shown ? "Not shown" : item.kind ? FAILURE_LABEL[item.kind] : item.unknown ? "Failed" : "Reverted"}
                </Tag>
                <button onClick={dismiss} aria-label="Dismiss" className="-mr-1 rounded p-1 text-faint transition-colors hover:bg-bg hover:text-ink">
                  <X size={14} strokeWidth={1.8} />
                </button>
              </div>
            </div>
            {item.ok ? (
              item.detail && <p className="mt-1.5 text-[13px] text-muted">{item.detail}</p>
            ) : (
              <>
                {item.signature && !item.kind && <p className="num mt-2 break-words text-[13px] text-breach">{item.signature}</p>}
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
  // A link within the app can carry ?net= (the landing's "Open a Playground", a shared /vault?net=… link followed
  // in-app). The store reads it only on the first connect, so follow it here on every page change, as a fresh visit would.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("net");
    const { netKey, setNetwork } = useChain.getState();
    if (netKey && isNetworkKey(wanted) && wanted !== netKey) void setNetwork(wanted);
  }, [path]);
  // What this browser sends on a public chain is kept, with its hash, beyond this visit (the ledger's "Yours"). Not the
  // rehearsal fork's: it has no explorer to link to, and its chain id is Base Sepolia's.
  useEffect(
    () =>
      useChain.subscribe((s, prev) => {
        if (s.log === prev.log || !s.net || !keepsSent(s.net.caps)) return;
        const before = new Set(prev.log.map((b) => b.id));
        rememberSent(s.net.chainId, s.log.filter((b) => !before.has(b.id)));
      }),
    [],
  );
  // Not on the landing (recorded data), nor the guided demo and the attack lab, which keep their own snapshots, nor the
  // ledger, which is the record rather than a place to act.
  const showDock = path !== "/" && path !== "/demo" && path !== "/attacks" && path !== "/ledger";
  return (
    <MotionConfig reducedMotion="user">
      <TopBar />
      {path !== "/" && <PlaygroundBar />}
      {path === "/" ? <main>{children}</main> : <main className={clsx("mx-auto max-w-[1320px] px-4 md:px-8", showDock ? "pb-28" : "pb-20")}>{children}</main>}
      {showDock && <Dock />}
      {/* the vault page shows the feed in place; the landing reads recorded data */}
      {path !== "/" && path !== "/vault" && <ActivityDrawer raised={showDock} />}
      <Toast />
    </MotionConfig>
  );
}
