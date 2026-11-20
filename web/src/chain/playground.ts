// The Playground: a private chain on Covenant's backend (backend/), one per visitor, loaded from the same seed as
// `make demo`. Every dev control works on it: trades of any size, the clock, every role, snapshots, the attack lab.
//
// The backend runs on Render's free plan, which sleeps after 15 idle minutes and takes about a minute to wake, so opening
// a chain waits patiently and says why. A visitor's session id is kept in this browser, so a reload returns to the same
// chain while it is running; one that stopped (idle for ten minutes, or the backend restarted) is replaced by a fresh one.

import type { Hex } from "viem";
import { type Network, type Runtime, parseManifest } from "./network";

const SESSION_KEY = "covenant.playground.session";
/** How long to keep trying while the backend wakes up. */
const WAKE_MS = 150_000;
const ATTEMPT_MS = 25_000;

export interface PlaygroundSession {
  id: string;
  resumed: boolean;
  expired: boolean;
  chainId: number;
  rpcPath: string;
  idleMs: number;
  runtime: { baselineSnapshot?: Hex };
}

export type Opened = { ok: true; net: Network; session: PlaygroundSession } | { ok: false; reason: string; retryMs: number };

// Also kept in memory: with storage blocked (some private windows), Reset still finds this page's chain.
let remembered: string | null = null;
function load(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY) ?? remembered;
  } catch {
    return remembered;
  }
}
function save(id: string | null) {
  remembered = id;
  try {
    if (id) localStorage.setItem(SESSION_KEY, id);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorOf = async (res: Response) => ((await res.json().catch(() => null)) as { error?: string } | null)?.error;

/**
 * Open this browser's Playground chain on `net.backend`: the one it had, if still running, else a new one. `onWait` hears
 * why it is taking long. `stale` stops the wait when the visitor has moved on to another network.
 */
export async function openPlayground(net: Network, onWait: (why: string) => void, stale: () => boolean): Promise<Opened> {
  if (!net.backend) return { ok: false, reason: "This copy of the app has no backend for the Playground.", retryMs: 60_000 };
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    if (stale()) return { ok: false, reason: "", retryMs: 0 };
    let res: Response | null = null;
    try {
      res = await fetch(`${net.backend}/v1/playground/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: load() ?? undefined }),
        signal: AbortSignal.timeout(ATTEMPT_MS),
      });
    } catch {
      res = null; // asleep, waking, or unreachable
    }
    if (res?.ok) {
      const session = (await res.json()) as PlaygroundSession & { manifest?: unknown };
      save(session.id);
      return { ok: true, session, net: { ...net, rpcUrl: `${net.backend}${session.rpcPath}`, ...seededAs(net, session) } };
    }
    if (res && (res.status === 503 || res.status === 429)) {
      const wait = Number(res.headers.get("retry-after")) || 30;
      return { ok: false, reason: (await errorOf(res)) ?? "The Playground is busy.", retryMs: wait * 1000 };
    }
    if (res && res.status < 500) return { ok: false, reason: (await errorOf(res)) ?? `The backend answered ${res.status}.`, retryMs: 30_000 };
    if (Date.now() - started > WAKE_MS) {
      return { ok: false, reason: "The Playground's backend is not answering. It may be redeploying; trying again shortly.", retryMs: 15_000 };
    }
    onWait(
      attempt === 0
        ? "Opening your Playground chain…"
        : `Waking the Playground's backend: it sleeps when nobody has used it for a while and takes about a minute to start (${Math.round((Date.now() - started) / 1000)}s so far).`,
    );
    await sleep(Math.min(5_000, 1_000 * (attempt + 1)));
  }
}

/**
 * The addresses and launches of the chain the backend opened: the records it seeded that chain from. The app's own copy
 * (Vercel's bundle) updates only when the app is redeployed, so after a re-seed on the backend it could name contracts
 * this chain does not have. Records that do not parse leave the app's copy in place.
 */
function seededAs(net: Network, session: PlaygroundSession & { manifest?: unknown }): Pick<Network, "manifest" | "runtime"> {
  let manifest = net.manifest;
  try {
    if (session.manifest) manifest = parseManifest(session.manifest);
  } catch {
    /* keep the app's */
  }
  const theirs = session.runtime as Partial<Runtime> | undefined;
  const baselineSnapshot = theirs?.baselineSnapshot;
  const runtime: Runtime | null =
    theirs?.defaultVault && Array.isArray(theirs.launches)
      ? { rpcUrl: net.runtime?.rpcUrl ?? "", defaultVault: theirs.defaultVault, launches: theirs.launches, seededAt: theirs.seededAt ?? net.runtime?.seededAt ?? 0, baselineSnapshot }
      : net.runtime
        ? { ...net.runtime, baselineSnapshot }
        : null;
  return { manifest, runtime };
}

/** Put this browser's Playground chain back to the seed. Returns the new baseline snapshot. */
export async function resetPlayground(net: Network): Promise<Hex> {
  const id = load();
  if (!net.backend || !id) throw new Error("There is no Playground chain to reset. Reload the page to open one.");
  const res = await fetch(`${net.backend}/v1/playground/sessions/${id}/reset`, { method: "POST", signal: AbortSignal.timeout(60_000) });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; baselineSnapshot?: Hex; error?: string } | null;
  if (!res.ok || !body?.ok || !body.baselineSnapshot) throw new Error(body?.error ?? `The backend answered ${res.status}.`);
  return body.baselineSnapshot;
}

/** Whether `e` says the Playground chain is gone (the backend answers 410 for a stopped session). */
export const chainGone = (e: unknown) => /\b410\b|has stopped/.test(e instanceof Error ? `${e.message} ${(e as { details?: string }).details ?? ""}` : String(e));
