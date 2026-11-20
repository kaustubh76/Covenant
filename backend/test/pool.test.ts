// The pool's rules with stand-in chains: no Anvil needed.

import { describe, expect, it } from "vitest";
import type { AnvilChain } from "../src/playground/anvil";
import { Playground } from "../src/playground/pool";

function chains() {
  const started: AnvilChain[] = [];
  const stopped: number[] = [];
  const start = async (): Promise<AnvilChain> => {
    const port = 40_000 + started.length;
    const c: AnvilChain = { port, pid: undefined, baseHead: 138, url: `http://127.0.0.1:${port}`, baseline: "0x0", exited: false, stop: async () => void stopped.push(port) };
    started.push(c);
    return c;
  };
  return { started, stopped, start };
}

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

  it("has no meter without limits", async () => {
    const c = chains();
    const pool = new Playground({ maxChains: 1, chainsPerIp: 1, idleMs: 60_000, evictAfterMs: 60_000, start: c.start });
    const { session } = await pool.open("1.1.1.1");
    expect(pool.meter(session)).toBeUndefined();
  });
});
