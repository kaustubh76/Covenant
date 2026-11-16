"use client";

import type { Address } from "viem";
import { create } from "zustand";
import { type Actor, actorOf } from "@/chain/accounts";
import type { Beat, BeatInput } from "@/chain/beat";
import { type ChainCtx, createChainCtx } from "@/chain/client";
import { discoverLaunches } from "@/chain/discover";
import { readHistory } from "@/chain/history";
import type { LaunchRecord, Network } from "@/chain/network";
import { type VaultView, readVaultView } from "@/chain/view";

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

export type Status = "connecting" | "offline" | "ready";

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
  connect(): Promise<void>;
  refresh(): Promise<void>;
  setRole(role: Role): void;
  selectVault(vault: Address): Promise<void>;
  run<T>(label: string, job: (ctx: ChainCtx, rec: Recorder) => Promise<T>, opts?: RunOptions): Promise<T | undefined>;
  record(beats: BeatInput | BeatInput[], opts?: { toast?: boolean }): void;
  dismissToast(): void;
  reset(): Promise<boolean>;
}

const VAULT_KEY = "covenant.vault";
const LOG_LIMIT = 200;

let seq = 0;
let refreshSeq = 0;
let quiet = 0;
let queue: Promise<unknown> = Promise.resolve();
let unwatch: (() => void) | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;

const message = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));
function remember(vault: Address) {
  try {
    localStorage.setItem(VAULT_KEY, vault);
  } catch {
    /* private mode */
  }
}
function remembered(): Address | null {
  try {
    return localStorage.getItem(VAULT_KEY) as Address | null;
  } catch {
    return null;
  }
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
  log: [],
  toast: null,
  role: "holder",
  busy: null,

  async connect() {
    if (retry) clearTimeout(retry);
    const res = await fetch("/api/chain", { cache: "no-store" })
      .then((r) => r.json() as Promise<{ state: "ready"; network: Network } | { state: "offline"; reason: string }>)
      .catch(() => ({ state: "offline" as const, reason: "The app server did not answer." }));
    if (res.state !== "ready") {
      set({ status: "offline", reason: res.reason, ctx: null, view: null });
      retry = setTimeout(() => void get().connect(), 3000);
      return;
    }
    const net = res.network;
    const ctx = createChainCtx(net);
    const launches = await discoverLaunches(ctx).catch(() => [] as LaunchRecord[]);
    const saved = remembered();
    const vault = saved && launches.some((l) => l.adopted && l.vault.toLowerCase() === saved.toLowerCase()) ? saved : (net.runtime?.defaultVault ?? launches.find((l) => l.adopted)?.vault ?? null);
    set({ net, ctx, launches, vault, status: "ready", reason: null });
    await get().refresh();
    unwatch?.();
    unwatch = ctx.pub.watchBlockNumber({
      poll: true,
      pollingInterval: 1000,
      onBlockNumber: () => {
        if (!quiet) void get().refresh();
      },
      onError: () => {
        set({ status: "offline", reason: "Lost the local chain." });
        unwatch?.();
        unwatch = null;
        retry = setTimeout(() => void get().connect(), 3000);
      },
    });
  },

  async refresh() {
    const { ctx, vault } = get();
    if (!ctx || !vault) return;
    const mine = ++refreshSeq;
    try {
      const view = await readVaultView(ctx, vault);
      if (mine !== refreshSeq) return;
      set({ view, reason: null });
      const [history, launches] = await Promise.all([readHistory(ctx, view), discoverLaunches(ctx)]);
      if (mine === refreshSeq) set({ history, launches });
    } catch (e) {
      if (mine !== refreshSeq) return;
      // A vault that cannot be read (not adopted yet, or gone after a reset) is not worth staying on.
      const fallback = get().net?.runtime?.defaultVault;
      if (fallback && vault.toLowerCase() !== fallback.toLowerCase()) {
        set({ vault: fallback, view: null, history: [] });
        void get().refresh();
        return;
      }
      set({ reason: message(e) });
    }
  },

  setRole: (role) => set({ role }),

  async selectVault(vault) {
    remember(vault);
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
    const done = await get().run("Resetting the chain", async () => {
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

/** The activity feed: this app's attempts (including refusals) merged with the chain's events, newest first. */
export function feed(log: Beat[], history: Beat[], limit = 50): Beat[] {
  const sent = new Set(log.map((b) => b.hash).filter(Boolean));
  const merged = [...log, ...history.filter((b) => !b.hash || !sent.has(b.hash))];
  merged.sort((a, b) => b.at - a.at || (b.block ?? 0) - (a.block ?? 0));
  return merged.slice(0, limit);
}
