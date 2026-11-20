// The pool's rules with stand-in chains: no Anvil needed.

import { describe, expect, it } from "vitest";
import type { AnvilChain } from "../src/playground/anvil";
import { Playground } from "../src/playground/pool";

/** Stand-in chains that exit when stopped, as Anvil's do. `slow` holds back every start after the first until it settles. */
function chains(slow?: () => Promise<void>) {
  const started: AnvilChain[] = [];
  const stopped: number[] = [];
  const start = async (): Promise<AnvilChain> => {
    const port = 40_000 + started.length;
    let exited = false;
    const c: AnvilChain = {
      port,
      pid: undefined,
      baseHead: 138,
      url: `http://127.0.0.1:${port}`,
      baseline: "0x0",
      get exited() {
        return exited;
      },
      // as Anvil's: stopping a chain that has exited does nothing
      stop: async () => {
        if (exited) return;
        exited = true;
        stopped.push(port);
      },
    };
    started.push(c);
    if (started.length > 1) await slow?.();
    return c;
  };
  return { started, stopped, start };
}

/** A promise and the function that settles it. */
function gate() {
  let open!: () => void;
  const shut = new Promise<void>((r) => (open = r));
  return { shut, open };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("the Playground pool", () => {
  it("restarts a chain from the seed on reset once it holds more memory than a revert would give back", async () => {
    const c = chains();
    const pool = new Playground({ maxChains: 2, chainsPerIp: 2, idleMs: 60_000, evictAfterMs: 60_000, start: c.start, restartAboveMb: 60, memoryOf: () => 80, limits: { height: 3_000, snapshots: 32, memoryMb: 100 } });
    const { session } = await pool.open("1.1.1.1");
    session.usage.held.push(5n, 6n);
    const first = session.chain;
    const after = await pool.reset(session.id);
    expect(c.started).toHaveLength(2);
    expect(c.stopped).toEqual([first.port]);
    expect(after.chain).not.toBe(first);
    // the reset gave back every snapshot the visitor held
    expect(after.usage.held).toEqual([]);
    // and the meter reads the new chain
    expect(pool.meter(after)?.memoryMb?.()).toBe(80);
  });

  it("without limits, limits nothing and still keeps the snapshots a revert is checked against", async () => {
    const c = chains();
    const pool = new Playground({ maxChains: 1, chainsPerIp: 1, idleMs: 60_000, evictAfterMs: 60_000, start: c.start });
    const { session } = await pool.open("1.1.1.1");
    const m = pool.meter(session);
    expect(m.limits).toEqual({ height: Number.POSITIVE_INFINITY, snapshots: Number.POSITIVE_INFINITY });
    expect(m.usage).toBe(session.usage);
    expect(m.exclusive).toBeTypeOf("function");
  });

  it("resets in turn with the visitor's snapshots and reverts, and clears the record a waiting call already holds", async () => {
    const c = chains();
    const pool = new Playground({ maxChains: 1, chainsPerIp: 1, idleMs: 60_000, evictAfterMs: 60_000, start: c.start, restartAboveMb: 60, memoryOf: () => 80 });
    const { session } = await pool.open("1.1.1.1");
    const m = pool.meter(session);
    m.usage.held.push(5n, 6n);
    const g = gate();
    const job = m.exclusive!(async () => {
      await g.shut;
      return "revert done";
    });
    const reset = pool.reset(session.id);
    await tick();
    // the reset waits for the revert under way
    expect(c.started).toHaveLength(1);
    g.open();
    expect(await job).toBe("revert done");
    await reset;
    expect(c.started).toHaveLength(2);
    // the meter taken before the reset reads the cleared record
    expect(m.usage.held).toEqual([]);
    // and a call queued behind the reset runs after it
    expect(await m.exclusive!(async () => session.chain.port)).toBe(c.started[1].port);
  });

  it("keeps a session while its chain restarts, and holds its calls until the new chain is up", async () => {
    const g = gate();
    const c = chains(() => g.shut);
    const pool = new Playground({ maxChains: 1, chainsPerIp: 1, idleMs: 60_000, evictAfterMs: 60_000, start: c.start, restartAboveMb: 60, memoryOf: () => 80 });
    const { session } = await pool.open("1.1.1.1");
    const old = session.chain;
    const reset = pool.reset(session.id);
    await tick();
    // the old process stopped first, so the instance never holds both; the session stays, even through a reap
    expect(c.stopped).toEqual([old.port]);
    await pool.reap();
    expect(pool.get(session.id)).toBe(session);
    // a call made now waits for the new chain
    let landed: number | undefined;
    const call = pool.ready(session.id).then((s) => (landed = s?.chain.port));
    await tick();
    expect(landed).toBeUndefined();
    g.open();
    await reset;
    await call;
    expect(landed).toBe(c.started[1].port);
    expect(pool.get(session.id)?.chain).toBe(c.started[1]);
  });

  it("says so in the log when a restart's new chain will not start, and the session goes with its stopped chain", async () => {
    const lines: string[] = [];
    let n = 0;
    const c = chains();
    const start = () => (n++ === 0 ? c.start() : Promise.reject(new Error("anvil exited while starting: out of memory")));
    const pool = new Playground({ maxChains: 1, chainsPerIp: 1, idleMs: 60_000, evictAfterMs: 60_000, start, restartAboveMb: 60, memoryOf: () => 80, log: (l) => lines.push(l) });
    const { session } = await pool.open("1.1.1.1");
    await expect(pool.reset(session.id)).rejects.toThrow(/out of memory/);
    expect(lines.at(-1)).toBe(`chain ${session.id.slice(0, 6)} could not restart from the seed: anvil exited while starting: out of memory`);
    expect(pool.get(session.id)).toBeUndefined();
    expect(await pool.ready(session.id)).toBeUndefined();
  });

  it("stops the new chain, rather than leaving it running, when the session closes during a restart", async () => {
    const g = gate();
    const c = chains(() => g.shut);
    const pool = new Playground({ maxChains: 1, chainsPerIp: 1, idleMs: 60_000, evictAfterMs: 60_000, start: c.start, restartAboveMb: 60, memoryOf: () => 80 });
    const { session } = await pool.open("1.1.1.1");
    const reset = pool.reset(session.id);
    await tick();
    await pool.close(session.id);
    g.open();
    await expect(reset).rejects.toMatchObject({ status: 410 });
    expect(c.stopped.sort()).toEqual([c.started[0].port, c.started[1].port].sort());
    expect(pool.stats().chains).toBe(0);
  });

  it("reports each chain's memory, and no ids, in its stats; and logs a refusal by the id's first six characters only", async () => {
    const c = chains();
    const lines: string[] = [];
    const pool = new Playground({ maxChains: 2, chainsPerIp: 2, idleMs: 60_000, evictAfterMs: 60_000, start: c.start, memoryOf: () => 42.4, limits: { height: 10, snapshots: 2, memoryMb: 100 }, log: (l) => lines.push(l) });
    const { session } = await pool.open("1.1.1.1");
    expect(pool.stats()).toEqual({ chains: 1, starting: 0, max: 2, mb: [42] });
    pool.meter(session)?.onRefuse?.("anvil_mine: 5 more blocks at height 8, past 10");
    expect(lines.at(-1)).toBe(`chain ${session.id.slice(0, 6)} refused anvil_mine: 5 more blocks at height 8, past 10`);
    expect(lines.join("\n")).not.toContain(session.id);
    // where memory cannot be read, the stats say nothing about it
    const quiet = new Playground({ maxChains: 1, chainsPerIp: 1, idleMs: 60_000, evictAfterMs: 60_000, start: chains().start, memoryOf: () => null });
    await quiet.open("1.1.1.2");
    expect(quiet.stats()).toEqual({ chains: 1, starting: 0, max: 1 });
  });
});
