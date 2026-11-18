"use client";

import { type Address, BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, custom } from "viem";
import { create } from "zustand";
import { type Actor, actorOf } from "@/chain/accounts";
import { type Beat, type BeatInput, note } from "@/chain/beat";
import { type ChainCtx, createChainCtx } from "@/chain/client";
import { discoverLaunches } from "@/chain/discover";
import { readHistory } from "@/chain/history";
import { forgetScans } from "@/chain/logs";
import { type LaunchRecord, type Network, type NetworkKey, firstChoice, isNetworkKey } from "@/chain/network";
import { openPlayground, resetPlayground } from "@/chain/playground";
import { sanitizeLaunches } from "@/chain/remembered";
import { type Party, isAddressParty } from "@/chain/tx";
import { type VaultView, readVaultView } from "@/chain/view";
import { type DiscoveredWallet, discoverWallets, requestAccount, switchWalletTo, walletChainId, walletMessage, watchWallet } from "@/chain/wallet";

export type Role = "holder" | "issuer" | "curator" | "keeper" | "lp";

export const ROLES: { key: Role; name: string; does: string }[] = [
  { key: "holder", name: "Holder", does: "Watches the vault" },
  { key: "issuer", name: "Issuer", does: "Owns principal, names the curator" },
  { key: "curator", name: "Curator", does: "Reshapes liquidity" },
  { key: "keeper", name: "Keeper", does: "Restores support" },
  { key: "lp", name: "Outside LP", does: "Adds liquidity" },
];

/** The account that signs for a role. Issuer and curator follow the vault: after a curator change the role moves. */
export function actorFor(role: Role, view: VaultView | null): Actor {
  if (role === "curator") return actorOf(view?.people.curator) ?? "curator";
  if (role === "issuer") return actorOf(view?.people.issuer) ?? "issuer";
  return role;
}

/**
 * Who sends for a role. Locally, the dev account behind it (actorFor). On a public chain, the vault's issuer or curator
 * by address: a page's preview then runs as them, and only their own wallet can send. Every other role is open to
 * anyone, so it is the connected wallet.
 */
export function partyFor(role: Role, view: VaultView | null, net: Network | null): Party {
  if (net && !net.caps.devChain && view) {
    if (role === "curator") return view.people.curator;
    if (role === "issuer") return view.people.issuer;
  }
  return actorFor(role, view);
}

/** On a public chain, whether the connected wallet holds `party`'s place; always true locally. */
export function canSendAs(party: Party, net: Network | null, wallet: WalletState | null): boolean {
  if (!net || net.caps.devChain) return true;
  if (!wallet) return false;
  return !isAddressParty(party) || party.toLowerCase() === wallet.address.toLowerCase();
}

export type Status = "connecting" | "offline" | "ready";

/** A network in the switcher: its name and whether it is reachable now. */
export interface NetworkSummary {
  key: NetworkKey;
  name: string;
  state: "ready" | "offline";
  reason?: string;
}

/** The browser wallet that signs on a public chain. */
export interface WalletState {
  id: string;
  name: string;
  address: Address;
  chainId: number;
}

export interface Recorder {
  /** Add beats to the activity log as they happen. The last one can raise the toast. */
  record(beats: BeatInput | BeatInput[], opts?: { toast?: boolean }): void;
  /** Update the label shown while the job runs. */
  progress(label: string): void;
}

export interface RunOptions {
  /** The job runs in a sandbox and reverts: do not refresh the view while it runs. */
  quiet?: boolean;
}

interface ChainState {
  status: Status;
  reason: string | null;
  net: Network | null;
  ctx: ChainCtx | null;
  launches: LaunchRecord[];
  vault: Address | null;
  view: VaultView | null;
  history: Beat[];
  log: Beat[];
  toast: Beat | null;
  role: Role;
  busy: string | null;
  /** The network the app is on, or connecting to. */
  netKey: NetworkKey | null;
  /** Every network the app knows, with whether each is reachable: the switcher's list. */
  networks: NetworkSummary[];
  /** Browser wallets on the page, and the one connected. Only public chains sign with a wallet. */
  wallets: DiscoveredWallet[];
  wallet: WalletState | null;
  walletError: string | null;
  connect(): Promise<void>;
  refresh(): Promise<void>;
  setRole(role: Role): void;
  setNetwork(key: NetworkKey): Promise<void>;
  loadNetworks(): Promise<void>;
  connectWallet(id?: string): Promise<void>;
  disconnectWallet(): void;
  switchWalletChain(): Promise<void>;
  selectVault(vault: Address): Promise<void>;
  run<T>(label: string, job: (ctx: ChainCtx, rec: Recorder) => Promise<T>, opts?: RunOptions): Promise<T | undefined>;
  record(beats: BeatInput | BeatInput[], opts?: { toast?: boolean }): void;
  dismissToast(): void;
  reset(): Promise<boolean>;
}

const NET_KEY = "covenant.net";
const WALLET_KEY = "covenant.wallet";
// The local chain keeps the key it always had, so an existing selection survives.
const vaultKey = (net: NetworkKey) => (net === "local" ? "covenant.vault" : `covenant.vault.${net}`);
/** Public chains: the launches this browser has seen, so one older than the recent log window is still listed. */
const launchesKey = (net: NetworkKey) => `covenant.launches.${net}`;
const LOG_LIMIT = 200;

let seq = 0;
let refreshSeq = 0;
/** Bumped by every connect: one that finds itself superseded after an await stops, so it never commits another network. */
let connectSeq = 0;
let quiet = 0;
let queue: Promise<unknown> = Promise.resolve();
let unwatch: (() => void) | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let unwallets: (() => void) | null = null;
let unwallet: (() => void) | null = null;
let restoring = false;

const message = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));
function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode
  }
}
/** The launches remembered for `net`, as far as they still look like launch records; discovery re-checks each. */
function rememberedLaunches(net: Network): LaunchRecord[] {
  if (net.caps.devChain) return [];
  try {
    return sanitizeLaunches(JSON.parse(load(launchesKey(net.key)) ?? "[]"));
  } catch {
    return [];
  }
}

/** When discovery fails: the launches the records and this browser already know, so a hiccup forgets nothing. */
function knownLaunches(net: Network): LaunchRecord[] {
  const seen = new Set<string>();
  return [...(net.runtime?.launches ?? []), ...rememberedLaunches(net)].filter((l) => !seen.has(l.vault.toLowerCase()) && !!seen.add(l.vault.toLowerCase()));
}

/** Remember the adopted launches not in the runtime records, the latest 20, writing only when that set changes. */
function rememberLaunches(net: Network, launches: LaunchRecord[]) {
  if (net.caps.devChain) return;
  const recorded = new Set((net.runtime?.launches ?? []).map((l) => l.vault.toLowerCase()));
  const mine = launches.filter((l) => l.adopted && !recorded.has(l.vault.toLowerCase())).slice(-20);
  const value = mine.length ? JSON.stringify(mine) : null;
  if (value !== load(launchesKey(net.key))) save(launchesKey(net.key), value);
}

function save(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

/** The network to open: ?net= first (a shared link), then the one last chosen in this browser. */
function chosenNetwork(): NetworkKey | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search).get("net");
  if (isNetworkKey(q)) return q;
  const saved = load(NET_KEY);
  return isNetworkKey(saved) ? saved : null;
}

/** The chain context for `net`: dev keys locally; on a public chain, the wallet signs once it is on the right chain. */
function ctxFor(net: Network, wallet: WalletState | null, wallets: DiscoveredWallet[]): ChainCtx {
  if (net.caps.devChain || !wallet || wallet.chainId !== net.chainId) return createChainCtx(net);
  const provider = wallets.find((w) => w.id === wallet.id)?.provider;
  return provider ? createChainCtx(net, { account: wallet.address, transport: custom(provider) }) : createChainCtx(net);
}

/**
 * The chain with a movable clock this copy of the app offers, for what needs one (the guided demo, the attack lab run
 * for real): the local chain, else the visitor's own Playground on the backend. Null when neither is offered.
 */
export const offeredDevNetwork = (s: Pick<ChainState, "networks">): NetworkKey | null =>
  s.networks.some((n) => n.key === "local") ? "local" : s.networks.some((n) => n.key === "playground" && n.state === "ready") ? "playground" : null;

export const useChain = create<ChainState>((set, get) => ({
  status: "connecting",
  reason: null,
  net: null,
  ctx: null,
  launches: [],
  vault: null,
  view: null,
  history: [],
  log: [],
  toast: null,
  role: "holder",
  busy: null,
  netKey: null,
  networks: [],
  wallets: [],
  wallet: null,
  walletError: null,

  async connect() {
    if (retry) clearTimeout(retry);
    const mine = ++connectSeq;
    if (!unwallets) {
      unwallets = discoverWallets((wallets) => {
        set({ wallets });
        void restoreWallet();
      });
    }
    let key = get().netKey ?? chosenNetwork();
    // A network opened from a ?net= link is the one this browser is now on, after a reload or on another page too.
    if (key && !get().netKey) save(NET_KEY, key);
    if (!key) {
      // Nothing chosen yet: the live deployment on Base Sepolia if it answers, else the first network that is up.
      await get().loadNetworks();
      key = firstChoice(get().networks);
    }
    if (mine !== connectSeq) return;
    set({ netKey: key });
    // Superseded: a later connect (another network chosen, a retry) owns the store now.
    const stale = () => mine !== connectSeq || get().netKey !== key;
    const res = await fetch(`/api/chain?net=${key}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<{ state: "ready"; network: Network } | { state: "offline"; reason: string; unavailable?: boolean }>)
      .catch(() => ({ state: "offline" as const, reason: "The app server did not answer." }));
    if (stale()) return;
    if (res.state !== "ready" && "unavailable" in res && res.unavailable) {
      // This server does not offer that network (a hosted copy offers only Base Sepolia, say), so a stale link or saved
      // choice opens the first network it does offer instead of waiting for one that can never come up.
      await get().loadNetworks();
      const fallback = get().networks.find((n) => n.state === "ready")?.key;
      if (fallback && fallback !== key) return get().setNetwork(fallback);
    }
    if (res.state !== "ready") {
      set({ status: "offline", reason: res.reason, net: null, ctx: null, view: null });
      retry = setTimeout(() => void get().connect(), 3000);
      return;
    }
    let net = res.network;
    let fresh = false;
    if (net.key === "playground") {
      // The visitor's own chain on the backend: the one this browser had, if it is still running, else a new one.
      set({ status: "connecting", reason: "Opening your Playground chain…" });
      const opened = await openPlayground(net, (why) => void (!stale() && set({ reason: why })), stale);
      if (stale()) return;
      if (!opened.ok) {
        set({ status: "offline", reason: opened.reason, net: null, ctx: null, view: null });
        retry = setTimeout(() => void get().connect(), opened.retryMs);
        return;
      }
      net = opened.net;
      fresh = opened.session.expired;
    }
    // Discovery only reads, so it gets a context of its own; the one the app keeps is built last, from the wallet as it
    // is then (one connected while this was loading included).
    const found = await discoverLaunches(ctxFor(net, null, get().wallets), rememberedLaunches(net)).catch(() => null);
    if (stale()) return;
    if (found) rememberLaunches(net, found);
    const launches = found ?? knownLaunches(net);
    const saved = load(vaultKey(key));
    const vault = saved && launches.some((l) => l.adopted && l.vault.toLowerCase() === saved.toLowerCase()) ? (saved as Address) : (net.runtime?.defaultVault ?? launches.find((l) => l.adopted)?.vault ?? null);
    const ctx = ctxFor(net, get().wallet, get().wallets);
    set({ net, ctx, launches, vault, status: "ready", reason: null });
    if (fresh) get().record(note("anyone", "A fresh Playground chain", "Your last one had stopped after sitting idle, so this one starts from the seed again."), { toast: true });
    await get().refresh();
    if (stale()) return;
    unwatch?.();
    unwatch = ctx.pub.watchBlockNumber({
      poll: true,
      pollingInterval: net.caps.pollMs,
      onBlockNumber: () => {
        if (!quiet && !stale()) void get().refresh();
      },
      onError: () => {
        if (stale()) return;
        set({ status: "offline", reason: `Lost ${net.name}.` });
        unwatch?.();
        unwatch = null;
        retry = setTimeout(() => void get().connect(), 3000);
      },
    });
  },

  async setNetwork(key) {
    if (key === get().netKey && get().status === "ready") return;
    const left = get().netKey;
    save(NET_KEY, key);
    if (retry) clearTimeout(retry);
    unwatch?.();
    unwatch = null;
    // A refresh still in flight for the network being left drops its result, and that network's cached scans go: coming
    // back reads its recent window afresh (a restarted fork shares nothing with the one before).
    refreshSeq++;
    if (left && left !== key) forgetScans(left);
    set({ netKey: key, status: "connecting", reason: null, net: null, ctx: null, view: null, launches: [], vault: null, history: [], log: [], toast: null });
    // Keep ?net= in step, so a copied link opens the same network.
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("net", key);
      window.history.replaceState(window.history.state, "", url);
    } catch {
      /* not in a browser */
    }
    await get().connect();
  },

  async loadNetworks() {
    const networks = await fetch("/api/chain/networks", { cache: "no-store" })
      .then((r) => r.json() as Promise<NetworkSummary[]>)
      .catch(() => [] as NetworkSummary[]);
    set({ networks });
  },

  async connectWallet(id) {
    const { wallets, net } = get();
    const w = (id ? wallets.find((x) => x.id === id) : undefined) ?? wallets[0];
    if (!w) {
      set({ walletError: "No browser wallet found. Install one (MetaMask, Rabby or Coinbase Wallet) to sign on Base Sepolia." });
      return;
    }
    try {
      const address = await requestAccount(w.provider);
      let chainId = await walletChainId(w.provider);
      if (net && !net.caps.devChain && chainId !== net.chainId) {
        await switchWalletTo(w.provider, net);
        chainId = await walletChainId(w.provider);
      }
      follow(w);
      save(WALLET_KEY, w.rdns ?? w.id);
      setWallet({ id: w.id, name: w.name, address, chainId });
      set({ walletError: null });
    } catch (e) {
      set({ walletError: walletMessage(e) });
    }
  },

  disconnectWallet() {
    unwallet?.();
    unwallet = null;
    save(WALLET_KEY, null);
    setWallet(null);
  },

  async switchWalletChain() {
    const { wallet, wallets, net } = get();
    const provider = wallets.find((w) => w.id === wallet?.id)?.provider;
    if (!provider || !net) return;
    try {
      await switchWalletTo(provider, net);
    } catch (e) {
      set({ walletError: walletMessage(e) });
    }
  },

  async refresh() {
    const { ctx, vault } = get();
    if (!ctx || !vault) return;
    const mine = ++refreshSeq;
    let view: VaultView;
    try {
      view = await readVaultView(ctx, vault);
    } catch (e) {
      if (mine !== refreshSeq) return;
      // A vault that is not there to read (no code after a reset, or reverting) is not worth staying on. A transient RPC
      // error is: it is shown, and the next block tries again.
      const gone = e instanceof BaseError && !!e.walk((x) => x instanceof ContractFunctionRevertedError || x instanceof ContractFunctionZeroDataError);
      const fallback = get().net?.runtime?.defaultVault;
      if (gone && fallback && vault.toLowerCase() !== fallback.toLowerCase()) {
        set({ vault: fallback, view: null, history: [] });
        void get().refresh();
        return;
      }
      set({ reason: message(e) });
      return;
    }
    if (mine !== refreshSeq) return;
    set({ view, reason: null });
    try {
      const [history, launches] = await Promise.all([readHistory(ctx, view), discoverLaunches(ctx, rememberedLaunches(ctx.net))]);
      if (mine === refreshSeq) {
        set({ history, launches });
        rememberLaunches(ctx.net, launches);
      }
    } catch (e) {
      if (mine === refreshSeq) set({ reason: message(e) });
    }
  },

  setRole: (role) => set({ role }),

  async selectVault(vault) {
    const key = get().netKey;
    if (key) save(vaultKey(key), vault);
    set({ vault, view: null, history: [] });
    await get().refresh();
  },

  run(label, job, opts = {}) {
    const next = queue.then(async () => {
      const { ctx } = get();
      if (!ctx) return undefined;
      if (opts.quiet) quiet++;
      set({ busy: label });
      const rec: Recorder = { record: (b, o) => get().record(b, o), progress: (l) => set({ busy: l }) };
      try {
        return await job(ctx, rec);
      } catch (e) {
        get().record({ actor: "anyone", title: label, ok: false, error: { name: "Error", args: [], signature: message(e), rule: "Other", reason: message(e) } }, { toast: true });
        return undefined;
      } finally {
        if (opts.quiet) quiet--;
        set({ busy: null });
        await get().refresh();
      }
    });
    queue = next.catch(() => undefined);
    return next;
  },

  record(beats, opts = {}) {
    const list = (Array.isArray(beats) ? beats : [beats]).map(
      (b): Beat => ({ ...b, id: `app-${++seq}`, at: b.at ?? get().view?.time ?? 0, source: "app" }),
    );
    if (!list.length) return;
    set((s) => ({ log: [...list.reverse(), ...s.log].slice(0, LOG_LIMIT), toast: opts.toast ? list[0] : s.toast }));
  },

  dismissToast: () => set({ toast: null }),

  async reset() {
    // Only the local chain can be rewound; a public chain's history is final.
    if (!get().net?.caps.devChain) return false;
    const done = await get().run("Resetting the chain", async () => {
      const playground = get().net;
      if (playground?.key === "playground") {
        // The visitor's own chain on the backend goes back to the seed there.
        const baselineSnapshot = await resetPlayground(playground);
        if (playground.runtime) set({ net: { ...playground, runtime: { ...playground.runtime, baselineSnapshot } } });
        return true;
      }
      const r = await fetch("/api/chain/reset", { method: "POST" }).then((x) => x.json() as Promise<{ ok: boolean; reason?: string }>);
      if (!r.ok) throw new Error(r.reason ?? "reset failed");
      return true;
    });
    if (done) {
      const net = get().net;
      set({ log: [], history: [], toast: null });
      if (net?.runtime) await get().selectVault(net.runtime.defaultVault);
    }
    return !!done;
  },
}));

/** Set the wallet and rebuild the chain context around it, then read the vault again (balances, shares, roles). */
function setWallet(wallet: WalletState | null) {
  const { net, wallets } = useChain.getState();
  useChain.setState({ wallet, ...(net ? { ctx: ctxFor(net, wallet, wallets) } : {}) });
  void useChain.getState().refresh();
}

/** Follow the connected wallet's account and chain as the user changes them in the wallet itself. */
function follow(w: DiscoveredWallet) {
  unwallet?.();
  unwallet = watchWallet(w.provider, {
    accounts: (a) => {
      const cur = useChain.getState().wallet;
      if (!a.length) useChain.getState().disconnectWallet();
      else if (cur) setWallet({ ...cur, address: a[0] });
    },
    chain: (chainId) => {
      const cur = useChain.getState().wallet;
      if (cur) setWallet({ ...cur, chainId });
    },
  });
}

/** Reconnect, without a prompt, the wallet this browser connected last time, if it still shares its account. */
async function restoreWallet() {
  const { wallet, wallets } = useChain.getState();
  const want = load(WALLET_KEY);
  if (wallet || restoring || !want) return;
  const w = wallets.find((x) => (x.rdns ?? x.id) === want);
  if (!w) return;
  restoring = true;
  try {
    const accounts = (await w.provider.request({ method: "eth_accounts" })) as Address[];
    if (accounts[0] && !useChain.getState().wallet) {
      follow(w);
      setWallet({ id: w.id, name: w.name, address: accounts[0], chainId: await walletChainId(w.provider) });
    }
  } catch {
    /* the wallet will be asked when the user connects */
  } finally {
    restoring = false;
  }
}

/** The activity feed: this app's attempts (including refusals) merged with the chain's events, newest first. */
export function feed(log: Beat[], history: Beat[], limit = 50): Beat[] {
  const sent = new Set(log.map((b) => b.hash).filter(Boolean));
  const merged = [...log, ...history.filter((b) => !b.hash || !sent.has(b.hash))];
  merged.sort((a, b) => b.at - a.at || (b.block ?? 0) - (a.block ?? 0));
  return merged.slice(0, limit);
}
