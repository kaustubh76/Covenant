"use client";

import { type Address, BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, type Hex, custom } from "viem";
import { create } from "zustand";
import { type Actor, actorOf } from "@/chain/accounts";
import { type Beat, type BeatInput, note } from "@/chain/beat";
import { classify } from "@/chain/failure";
import { type ChainCtx, createChainCtx } from "@/chain/client";
import { discoverLaunches } from "@/chain/discover";
import { type Seen, readActivity } from "@/chain/history";
import { forgetScans } from "@/chain/logs";
import { type LaunchRecord, type Network, type NetworkKey, firstChoice, isNetworkKey } from "@/chain/network";
import { openPlayground, resetPlayground } from "@/chain/playground";
import { sanitizeLaunches } from "@/chain/remembered";
import { type Party, StepFailed, isAddressParty } from "@/chain/tx";
import { type VaultView, readVaultView } from "@/chain/view";
import { type DiscoveredWallet, discoverWallets, requestAccount, switchWalletTo, walletChainId, walletMessage, watchWallet } from "@/chain/wallet";
import { type SavePoint, type SnapRecord, type StoredSavePoints, afterRevert, sanitizeStored, snapshotId, stillListed } from "@/chain/snapguard";
import { type Gone, SnapshotGone, chainSnapshots, onReverted, revertTo, takeSnapshot } from "@/chain/time";

export type Role = "holder" | "issuer" | "curator" | "keeper" | "lp";

/** A save point as the store holds it: its snapshot, the chain's clock then, and the record a revert is checked by. */
export interface StorePoint {
  id: Hex;
  at: number;
  record: SnapRecord | null;
}

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

/**
 * Whether `party`'s action can be sent from here. On a public chain, when the connected wallet holds its place; on a dev
 * chain, when a dev key signs for it: every role has one, an address only if it is one of the dev accounts.
 */
export function canSendAs(party: Party, net: Network | null, wallet: WalletState | null): boolean {
  if (!net) return true;
  if (net.caps.devChain) return !isAddressParty(party) || actorOf(party) !== undefined;
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
  /** Who the current vault's logs name (curators, depositors), read with `history`. Checked against `vault` before use. */
  seen: Seen | null;
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
  /**
   * Save points on a dev chain, newest last: snapshots to come back to, clock and all. Kept in this browser per network
   * and per chain (`record` says which), so a reload, another tab or a trip to another network keeps them; `record` is
   * null only on a chain that does not say what snapshots it holds, where they last as long as the page.
   */
  savePoints: StorePoint[];
  /**
   * Bumped whenever the chain behind the app is not the one it was: another network, a reset, a fresh Playground chain
   * after the last one stopped, a return to a save point. A page that keeps chain state of its own (the launch desk)
   * starts over when it changes, rather than act on blocks and contracts that are not there.
   */
  chainEpoch: number;
  savePoint(): Promise<void>;
  backToSavePoint(): Promise<void>;
}

const NET_KEY = "covenant.net";
const ROLE_KEY = "covenant.role";
const WALLET_KEY = "covenant.wallet";
// The local chain keeps the key it always had, so an existing selection survives.
const vaultKey = (net: NetworkKey) => (net === "local" ? "covenant.vault" : `covenant.vault.${net}`);
/** Public chains: the launches this browser has seen, so one older than the recent log window is still listed. */
const launchesKey = (net: NetworkKey) => `covenant.launches.${net}`;
/** Dev chains: the save points this browser keeps, all on one chain (Anvil's instance id says which). */
const savePointsKey = (net: NetworkKey) => `covenant.savepoints.v1.${net}`;
const LOG_LIMIT = 200;

let seq = 0;
let refreshSeq = 0;
/** Bumped by every connect: one that finds itself superseded after an await stops, so it never commits another network. */
let connectSeq = 0;
let quiet = 0;
/** Actions asked for and not yet finished, including the one running: busy stays set until the last one ends. */
let queued = 0;
let queue: Promise<unknown> = Promise.resolve();
let unwatch: (() => void) | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let networksRetry: ReturnType<typeof setTimeout> | null = null;
let unwallets: (() => void) | null = null;
let unwallet: (() => void) | null = null;
let restoring = false;
/** The chain the save points on screen belong to: the stored ones for `net` are read and written under `instance`. */
let pointsOn: { net: NetworkKey; url: string; instance: Hex } | null = null;
/** The save points could not be read back at connect (no answer): try again on the next block. */
let restorePending = false;
let mirroring = false;

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

/** The save points stored for `net`, on chain `instance`; none when the record is another chain's, or unreadable. */
function storedPoints(net: NetworkKey, instance: Hex): StorePoint[] {
  const kept = readStored(net);
  if (!kept || kept.instance !== instance.toLowerCase()) return [];
  return kept.points.map(({ at, ...record }) => ({ id: record.id, at, record }));
}

/** The save point record stored for `net`, as far as it still reads as one. */
function readStored(net: NetworkKey): StoredSavePoints | null {
  try {
    return sanitizeStored(JSON.parse(load(savePointsKey(net)) ?? "null"));
  } catch {
    return null;
  }
}

/** Store `points` as `net`'s save points on chain `instance` (only those taken there), or clear the record. */
function storePoints(net: NetworkKey, instance: Hex, points: StorePoint[]) {
  const mine: SavePoint[] = points.flatMap((p) => (p.record && p.record.instance === instance.toLowerCase() ? [{ ...p.record, at: p.at }] : []));
  save(savePointsKey(net), mine.length ? JSON.stringify({ instance: instance.toLowerCase(), points: mine }) : null);
}

/**
 * Read the save points back for the chain the app is on: the ones stored for it that the chain still holds (snapguard.ts
 * says how that is told). A record of another chain (the local chain restarted, a fresh Playground chain) is dropped.
 */
export async function restoreSavePoints(ctx: ChainCtx, stale: () => boolean = () => false): Promise<void> {
  const now = await chainSnapshots(ctx).catch(() => undefined);
  if (stale()) return;
  restorePending = now === undefined;
  if (!now) return; // no answer (tried again on the next block), or a chain that does not say: memory only, as before
  const net = ctx.net.key;
  pointsOn = { net, url: ctx.net.rpcUrl, instance: now.instance };
  const stored = readStored(net);
  const points = storedPoints(net, now.instance).filter((p) => p.record && stillListed(p.record, now).ok);
  if (stored && (stored.instance !== now.instance || stored.points.length !== points.length)) storePoints(net, now.instance, points);
  useChain.setState({ savePoints: points });
  if (!mirroring && typeof window !== "undefined") {
    mirroring = true;
    // Another tab took, used or dropped a save point on the same chain: show the same list.
    window.addEventListener("storage", (e) => {
      const on = pointsOn;
      if (on && e.key === savePointsKey(on.net) && useChain.getState().netKey === on.net) useChain.setState({ savePoints: storedPoints(on.net, on.instance) });
    });
  }
}

/**
 * After a revert sent from this page (a save point, the guided demo, the attack lab, a sandbox): drop the save points it
 * took with it. Anvil drops every snapshot from the reverted id on, whatever it answers.
 */
function dropReverted(url: string, id: Hex, gone: Gone) {
  const s = useChain.getState();
  if (!s.net?.caps.devChain || s.net.rpcUrl !== url) return;
  const r = snapshotId(id);
  const rule = (list: StorePoint[]) => (gone === "all" ? [] : gone === "one" ? list.filter((p) => snapshotId(p.id) !== r) : afterRevert(list, id));
  const on = pointsOn;
  if (on && on.url === url) {
    const kept = rule(storedPoints(on.net, on.instance));
    storePoints(on.net, on.instance, kept);
    useChain.setState({ savePoints: kept });
  } else {
    useChain.setState({ savePoints: rule(s.savePoints) });
  }
}
onReverted(dropReverted);

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
  if (net.caps.devChain || !wallet) return createChainCtx(net);
  // A wallet on another network signs nothing here, and a send says to switch it (not to connect one).
  if (wallet.chainId !== net.chainId) return createChainCtx(net, undefined, { walletChainId: wallet.chainId });
  const provider = wallets.find((w) => w.id === wallet.id)?.provider;
  return provider ? createChainCtx(net, { account: wallet.address, transport: custom(provider) }) : createChainCtx(net);
}

/**
 * The chain with a movable clock this copy of the app offers, for what needs one (the guided demo, the attack lab run
 * for real): the local chain, else the visitor's own Playground on the backend. Null when neither is offered.
 */
export function offeredDevNetwork(s: Pick<ChainState, "networks">): NetworkKey | null {
  const ready = (k: NetworkKey) => s.networks.some((n) => n.key === k && n.state === "ready");
  if (ready("local")) return "local";
  if (ready("playground")) return "playground";
  // Listed but not running: still the one to point a developer at, since its offline page says how to start it.
  return s.networks.some((n) => n.key === "local") ? "local" : null;
}

/**
 * Whether this copy of the app is a hosted one (no local chain to start), where a visitor should never be shown deploy
 * commands. The server's network list says so; when that list could not be fetched, the page's own address does, since
 * only a copy served from this machine offers the local chain.
 */
export function isHostedCopy(networks: Pick<NetworkSummary, "key">[], hostname: string | null): boolean {
  if (networks.length) return !networks.some((n) => n.key === "local");
  return hostname !== null && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(hostname);
}

export const useChain = create<ChainState>((set, get) => ({
  status: "connecting",
  reason: null,
  net: null,
  ctx: null,
  launches: [],
  vault: null,
  view: null,
  history: [],
  seen: null,
  log: [],
  toast: null,
  role: "holder",
  busy: null,
  netKey: null,
  networks: [],
  wallets: [],
  wallet: null,
  walletError: null,
  savePoints: [],
  chainEpoch: 0,

  async connect() {
    if (retry) clearTimeout(retry);
    // The role this browser last acted as (restored here, after mount, so the server's first render still matches).
    const savedRole = load(ROLE_KEY);
    if (savedRole && savedRole !== get().role && ROLES.some((r) => r.key === savedRole)) set({ role: savedRole as Role });
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
    // A fresh Playground chain replaced one that had stopped: the save points were snapshots of the old one.
    set({ net, ctx, launches, vault, status: "ready", reason: null, ...(fresh ? { savePoints: [], chainEpoch: get().chainEpoch + 1 } : {}) });
    if (fresh) get().record(note("anyone", "A fresh Playground chain", "Your last one had stopped (it sat idle, or the backend restarted), so this one starts from the seed again."), { toast: true });
    // The save points this browser kept on this chain, the ones it still holds (none on another chain).
    if (net.caps.devChain) void restoreSavePoints(ctx, stale);
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
        // one reconnect at a time, however many errors arrive before it starts
        if (retry) clearTimeout(retry);
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
    pointsOn = null;
    restorePending = false;
    set({
      netKey: key,
      status: "connecting",
      reason: null,
      net: null,
      ctx: null,
      view: null,
      launches: [],
      vault: null,
      history: [],
      seen: null,
      log: [],
      toast: null,
      savePoints: [],
      chainEpoch: get().chainEpoch + 1,
    });
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
    const fetched = await fetch("/api/chain/networks", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
      .catch(() => null);
    if (Array.isArray(fetched)) {
      set({ networks: fetched as NetworkSummary[] });
      return;
    }
    // A blip keeps the list already shown, rather than hiding the network menu and the Playground's offer. With no
    // list yet, try again shortly, as connect() does.
    if (!get().networks.length && !networksRetry) {
      networksRetry = setTimeout(() => {
        networksRetry = null;
        void get().loadNetworks();
      }, 3000);
    }
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
    if (!provider || !net) {
      set({ walletError: !net ? "Pick a network first." : "The connected wallet is no longer on this page: connect it again." });
      return;
    }
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
        set({ vault: fallback, view: null, history: [], seen: null });
        void get().refresh();
        return;
      }
      set({ reason: message(e) });
      return;
    }
    if (mine !== refreshSeq) return;
    set({ view, reason: null });
    if (restorePending && ctx.net.caps.devChain) {
      restorePending = false;
      void restoreSavePoints(ctx, () => get().ctx !== ctx);
    }
    try {
      const [activity, launches] = await Promise.all([readActivity(ctx, view), discoverLaunches(ctx, rememberedLaunches(ctx.net))]);
      if (mine === refreshSeq) {
        set({ history: activity.beats, seen: activity.seen, launches });
        rememberLaunches(ctx.net, launches);
      }
    } catch (e) {
      if (mine === refreshSeq) set({ reason: message(e) });
    }
  },

  setRole: (role) => {
    save(ROLE_KEY, role);
    set({ role });
  },

  async selectVault(vault) {
    const key = get().netKey;
    if (key) save(vaultKey(key), vault);
    set({ vault, view: null, history: [], seen: null });
    await get().refresh();
  },

  run(label, job, opts = {}) {
    // Busy from the moment the action is asked for, not only once its turn in the queue comes: the buttons that started
    // it are disabled at once, so a second click cannot queue a duplicate.
    queued++;
    if (!get().busy) set({ busy: label });
    const next = queue.then(async () => {
      const { ctx, status, net } = get();
      try {
        if (!ctx) return undefined;
        // A chain that stopped answering (a Playground chain evicted or stopped, a node gone) keeps the last numbers on
        // screen while the app reconnects, so its buttons still look live: say so, rather than send into nothing.
        if (status !== "ready") {
          const error = {
            name: "NoAnswer",
            args: [],
            signature: "Reconnecting",
            rule: "Other" as const,
            reason: `${net?.name ?? "The chain"} is not answering right now, so nothing was sent. The app is reconnecting: try again in a moment.`,
          };
          get().record({ actor: "anyone", title: label, ok: false, error }, { toast: true });
          return undefined;
        }
        if (opts.quiet) quiet++;
        set({ busy: label });
        const rec: Recorder = { record: (b, o) => get().record(b, o), progress: (l) => set({ busy: l }) };
        try {
          return await job(ctx, rec);
        } catch (e) {
          // A step that had to succeed (must) carries what the contract or the wallet said. A declined wallet request, a
          // wallet on another network or a node that did not answer is said as such; only what nobody here recognises
          // is shown as the error's own message.
          const error = (e instanceof StepFailed ? e.outcome.error : undefined) ?? classify(e) ?? { name: "Error", args: [], signature: message(e), rule: "Other" as const, reason: message(e) };
          get().record({ actor: "anyone", title: label, ok: false, error }, { toast: true });
          return undefined;
        } finally {
          if (opts.quiet) quiet--;
          // Read the chain again before the buttons come back, so they never act on the numbers from before the action.
          // Capped, so a slow node cannot leave the app busy.
          await Promise.race([get().refresh(), new Promise((r) => setTimeout(r, 10_000))]);
        }
      } finally {
        if (--queued === 0) set({ busy: null });
      }
    });
    queue = next.catch(() => undefined);
    return next;
  },

  record(beats, opts = {}) {
    const vault = get().vault ?? undefined;
    const list = (Array.isArray(beats) ? beats : [beats]).map(
      (b): Beat => ({ ...b, id: `app-${++seq}`, at: b.at ?? get().view?.time ?? 0, source: "app", vault }),
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
      const r = await fetch("/api/chain/reset", { method: "POST" }).then((x) => x.json() as Promise<{ ok: boolean; reason?: string; baselineSnapshot?: Hex }>);
      if (!r.ok) throw new Error(r.reason ?? "reset failed");
      // The new baseline, as the Playground's above: the guided demo keys its snapshots on it, so it starts over.
      const local = get().net;
      if (local?.runtime && r.baselineSnapshot) set({ net: { ...local, runtime: { ...local.runtime, baselineSnapshot: r.baselineSnapshot } } });
      return true;
    });
    if (done) {
      const net = get().net;
      // Every save point went with the reset (it reverted to the baseline, taken before them all).
      if (net) save(savePointsKey(net.key), null);
      pointsOn = null;
      set({ log: [], history: [], seen: null, toast: null, savePoints: [], chainEpoch: get().chainEpoch + 1 });
      if (net?.runtime) await get().selectVault(net.runtime.defaultVault);
    }
    return !!done;
  },

  async savePoint() {
    if (!get().net?.caps.devChain) return;
    await get().run("Taking a save point", async (ctx, rec) => {
      const { id, record } = await takeSnapshot(ctx);
      keepPoint(ctx, { id, at: get().view?.time ?? 0, record });
      rec.record(note("anyone", "Save point taken", "Back to it returns the chain exactly here, clock included"), { toast: true });
    });
  },

  async backToSavePoint() {
    const top = get().savePoints.at(-1);
    if (!top || !get().net?.caps.devChain) return;
    await get().run("Going back to the save point", async (ctx, rec) => {
      try {
        await revertTo(ctx, top.id, top.record);
      } catch (e) {
        if (!(e instanceof SnapshotGone)) throw e;
        // Nothing was sent (gone, restarted), or the revert did not finish cleanly (torn). The ones the chain no longer
        // holds are dropped; the rest stay, newest last.
        const left = await recheckPoints(ctx);
        const more = left ? ` ${left} earlier save point${left === 1 ? " is" : "s are"} still there.` : "";
        const error = e.why === "torn" ? { name: "Error", signature: "Went back partway" } : { name: "NotSent", signature: "Save point gone" };
        rec.record({ actor: "anyone", title: "Back to the save point", ok: false, error: { ...error, args: [], rule: "Other", reason: e.message + more } }, { toast: true });
        return;
      }
      // Anvil uses a snapshot up when it goes back to it: take it again, so the same point can be returned to.
      const again = await takeSnapshot(ctx);
      keepPoint(ctx, { id: again.id, at: top.at, record: again.record });
      set({ chainEpoch: get().chainEpoch + 1 });
      rec.record(note("anyone", "Back at the save point", "The chain is as it was when the point was taken"), { toast: true });
    });
  },
}));

/**
 * Add a save point. On a chain that says what it holds, the stored list is the truth (another tab may have added or
 * dropped points): it is appended to and shown; elsewhere the point lives in this page only.
 */
function keepPoint(ctx: ChainCtx, point: StorePoint) {
  const { record } = point;
  if (!record) {
    useChain.setState({ savePoints: [...useChain.getState().savePoints, point] });
    return;
  }
  pointsOn = { net: ctx.net.key, url: ctx.net.rpcUrl, instance: record.instance };
  const points = [...storedPoints(ctx.net.key, record.instance).filter((p) => p.id !== point.id), point];
  storePoints(ctx.net.key, record.instance, points);
  useChain.setState({ savePoints: points });
}

/** Keep only the save points the chain still holds; how many are left. */
async function recheckPoints(ctx: ChainCtx): Promise<number> {
  const now = await chainSnapshots(ctx).catch(() => null);
  const on = pointsOn;
  if (!now || !on || on.url !== ctx.net.rpcUrl) return useChain.getState().savePoints.length;
  const points = storedPoints(on.net, now.instance).filter((p) => p.record && stillListed(p.record, now).ok);
  storePoints(on.net, now.instance, points);
  pointsOn = { ...on, instance: now.instance };
  useChain.setState({ savePoints: points });
  return points.length;
}

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

/**
 * The activity feed: this app's attempts (including refusals) merged with the chain's events, newest first. An attempt
 * belongs to the vault it was made on, so another vault's feed does not list it. A transaction the chain shows landed
 * replaces an app line that had given up on it ("Still pending"); otherwise the app's line, with its detail, is kept.
 */
export function feed(log: Beat[], history: Beat[], limit = 50, vault: string | null = useChain.getState().vault): Beat[] {
  const here = vault ? log.filter((b) => !b.vault || b.vault.toLowerCase() === vault.toLowerCase()) : log;
  const landed = new Set(history.map((b) => b.hash).filter(Boolean));
  const app = here.filter((b) => b.ok || !b.hash || !landed.has(b.hash));
  const sent = new Set(app.map((b) => b.hash).filter(Boolean));
  const merged = [...app, ...history.filter((b) => !b.hash || !sent.has(b.hash))];
  merged.sort((a, b) => b.at - a.at || (b.block ?? 0) - (a.block ?? 0));
  return merged.slice(0, limit);
}
