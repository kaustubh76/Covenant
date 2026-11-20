// Visitors' Playground chains: one private Anvil per session, started on demand, stopped when idle.

import { randomBytes } from "node:crypto";
import { HttpError } from "../http";
import { type AnvilChain, resetChain, rpc, rssMb } from "./anvil";
import type { Meter } from "./rpc";

export interface Session {
  id: string;
  ip: string;
  chain: AnvilChain;
  createdAt: number;
  lastUsed: number;
  /** The snapshots the visitor holds, counted against `limits` and checked before a revert (rpc.ts tracks them). */
  usage: Meter["usage"];
  /** The last of this chain's snapshot, revert and reset jobs, each run after the one before (exclusive). */
  turn: Promise<unknown>;
  /** Set while a reset runs: new calls wait for it (ready), and a chain it is restarting does not count as exited. */
  resetting?: Promise<void>;
}

export interface PoolOptions {
  maxChains: number;
  chainsPerIp: number;
  idleMs: number;
  evictAfterMs: number;
  start: () => Promise<AnvilChain>;
  /** How far past its seed one chain may grow, and how many snapshots it may hold. Unset, nothing is limited (reverts are still checked). */
  limits?: Meter["limits"];
  /** Past this many MB, a reset restarts the chain from the seed, since a revert keeps the memory the chain grew. */
  restartAboveMb?: number;
  /** A chain's memory in MB (default: its Anvil process's, from /proc). */
  memoryOf?: (c: AnvilChain) => number | null;
  now?: () => number;
  log?: (line: string) => void;
}

export const SESSION_ID = /^[0-9a-f]{32}$/;

const STOPPED = "This Playground chain has stopped. Open a new one.";

export class Playground {
  private readonly o: PoolOptions;
  private readonly sessions = new Map<string, Session>();
  private starting = 0;
  /** Opens run one at a time, so two visitors can never both take the last free chain. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(o: PoolOptions) {
    this.o = o;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** A running session, marked as just used. One whose chain exited is gone, unless a reset is restarting it. */
  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (s.chain.exited && !s.resetting) {
      this.sessions.delete(id);
      return undefined;
    }
    s.lastUsed = this.now();
    return s;
  }

  /**
   * The session, once any reset under way is done. A call waits here rather than land between a reset's revert and its
   * new baseline, or reach a chain the reset has stopped.
   */
  async ready(id: string): Promise<Session | undefined> {
    const s = this.get(id);
    if (s?.resetting) await s.resetting;
    return this.get(id);
  }

  /** The session `resumeId` names, if it is still running; otherwise a new chain. */
  open(ip: string, resumeId?: string): Promise<{ session: Session; resumed: boolean; expired: boolean }> {
    const next = this.queue.then(() => this.openNow(ip, resumeId));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async openNow(ip: string, resumeId?: string): Promise<{ session: Session; resumed: boolean; expired: boolean }> {
    if (resumeId) {
      const s = await this.ready(resumeId);
      if (s) return { session: s, resumed: true, expired: false };
    }
    // One address holds at most chainsPerIp chains; opening another replaces its least recently used.
    const mine = [...this.sessions.values()].filter((s) => s.ip === ip).sort((a, b) => a.lastUsed - b.lastUsed);
    while (mine.length >= this.o.chainsPerIp) await this.close(mine.shift()!.id, "replaced by a newer chain from the same address");
    if (this.sessions.size + this.starting >= this.o.maxChains) {
      const t = this.now();
      const idle = [...this.sessions.values()].filter((s) => t - s.lastUsed >= this.o.evictAfterMs).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) throw new HttpError(503, "Every Playground chain is in use right now. Try again in a minute.", { "retry-after": "30" });
      await this.close(idle.id, "handed to a new visitor after sitting idle");
    }
    this.starting++;
    try {
      const chain = await this.o.start();
      const t = this.now();
      const session: Session = { id: randomBytes(16).toString("hex"), ip, chain, createdAt: t, lastUsed: t, usage: { held: [] }, turn: Promise.resolve() };
      this.sessions.set(session.id, session);
      this.o.log?.(`chain ${session.id.slice(0, 6)} up on :${chain.port} (${this.sessions.size}/${this.o.maxChains})`);
      return { session, resumed: false, expired: !!resumeId };
    } finally {
      this.starting--;
    }
  }

  /** Run `job` after every snapshot, revert and reset already under way on this chain. */
  private exclusive<T>(s: Session, job: () => Promise<T>): Promise<T> {
    const next = s.turn.then(job);
    s.turn = next.catch(() => undefined);
    return next;
  }

  /** Back to the seeded state. A chain past restartAboveMb, or whose baseline is gone, is replaced by a fresh one. */
  async reset(id: string): Promise<Session> {
    const s = this.get(id);
    if (!s) throw new HttpError(410, STOPPED);
    // In turn with the visitor's snapshots and reverts, so none lands between the revert and the new baseline.
    return this.exclusive(s, async () => {
      if (this.sessions.get(id) !== s || s.chain.exited) throw new HttpError(410, STOPPED);
      let done!: () => void;
      s.resetting = new Promise<void>((r) => (done = r));
      try {
        const mb = this.memoryOf(s.chain);
        try {
          // A revert keeps the memory a chain grew; a fresh process from the seed gives it back.
          if (mb !== null && this.o.restartAboveMb !== undefined && mb > this.o.restartAboveMb) throw new Error("restart");
          await resetChain(s.chain);
        } catch {
          // The old process stops before the new one starts, so the instance never holds both.
          await s.chain.stop();
          const fresh = await this.o.start().catch((e: unknown) => {
            // the session goes with its stopped chain (get), and the visitor's next call opens a new one
            this.o.log?.(`chain ${id.slice(0, 6)} could not restart from the seed: ${e instanceof Error ? e.message : String(e)}`);
            throw e;
          });
          if (this.sessions.get(id) !== s) {
            // closed while the new chain started
            await fresh.stop();
            throw new HttpError(410, STOPPED);
          }
          s.chain = fresh;
          this.o.log?.(`chain ${id.slice(0, 6)} restarted from the seed${mb !== null ? ` (it held ${Math.round(mb)} MB)` : ""}`);
        }
        // The reset reverted every snapshot the visitor took, and took a new baseline. Cleared in place: a call already
        // waiting its turn holds this same record.
        s.usage.held = [];
        return s;
      } finally {
        s.resetting = undefined;
        done();
      }
    });
  }

  /** What a session's calls are screened against (rpc.ts): its limits, if any, and the snapshots it holds. */
  meter(s: Session): Meter {
    return {
      usage: s.usage,
      limits: this.o.limits ?? { height: Number.POSITIVE_INFINITY, snapshots: Number.POSITIVE_INFINITY },
      exclusive: (job) => this.exclusive(s, job),
      height: async () => Number(await rpc<string>(s.chain.url, "eth_blockNumber", [], 5_000)) - s.chain.baseHead,
      memoryMb: () => this.memoryOf(s.chain),
      // the first six characters only, as every other line here: the whole id is the key to the chain
      onRefuse: (why) => this.o.log?.(`chain ${s.id.slice(0, 6)} refused ${why}`),
    };
  }

  private memoryOf(c: AnvilChain): number | null {
    return (this.o.memoryOf ?? ((x: AnvilChain) => rssMb(x.pid)))(c);
  }

  async close(id: string, why = "closed"): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    await s.chain.stop();
    this.o.log?.(`chain ${id.slice(0, 6)} stopped: ${why}`);
  }

  /** Stop the chains nobody has called for idleMs, and forget the ones that exited on their own. */
  async reap(): Promise<void> {
    const t = this.now();
    for (const s of [...this.sessions.values()]) {
      if (s.resetting) continue;
      if (s.chain.exited) this.sessions.delete(s.id);
      else if (t - s.lastUsed >= this.o.idleMs) await this.close(s.id, "idle");
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id, "shutting down")));
  }

  /** How many chains run, and each one's resident memory in MB where it can be read (Linux): no ids, nothing else. */
  stats(): { chains: number; starting: number; max: number; mb?: number[] } {
    const mb = [...this.sessions.values()].map((s) => this.memoryOf(s.chain)).filter((x): x is number => x !== null).map((x) => Math.round(x));
    return { chains: this.sessions.size, starting: this.starting, max: this.o.maxChains, ...(mb.length ? { mb } : {}) };
  }
}
