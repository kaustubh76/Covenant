// What the vault page states about the curator, "it can take out fees only", checked against the contract's source:
// a change to who may call what, or to where the vault pays out, fails here before the page goes on saying it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "..", "src");
const vault = readFileSync(join(SRC, "CovenantVault.sol"), "utf8");

/** The source of each function in the vault, by name (overloads are not used there). */
function functions(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /function\s+(\w+)\s*\(/g;
  const starts = [...source.matchAll(re)].map((m) => ({ name: m[1], at: m.index! }));
  starts.forEach((f, i) => out.set(f.name, source.slice(f.at, starts[i + 1]?.at ?? source.length)));
  return out;
}

describe("the curator, as the vault page describes it", () => {
  const fns = functions(vault);

  it("may call one function only the curator can: reshape, which moves value between ranges", () => {
    const gated = [...fns].filter(([, body]) => /revert NotCurator\(\)/.test(body)).map(([name]) => name);
    expect(gated).toEqual(["reshape"]);
  });

  it("is paid only its own fee balance: claimCuratorFees sends curatorFees[msg.sender], nothing else", () => {
    const claim = fns.get("claimCuratorFees") ?? "";
    expect(claim).toMatch(/amount0 = curatorFees0\[msg\.sender\]/);
    expect(claim).toMatch(/amount1 = curatorFees1\[msg\.sender\]/);
    // every transfer out of the vault: the curator's own fees, the bounty to whoever restores, exits to share holders, and
    // each account's own fees (_payFees: a holder's to itself, the principal's to the treasury)
    const senders = [...fns].filter(([, body]) => /\.transfer\(/.test(body)).map(([name]) => name);
    expect(senders.sort()).toEqual(["_exit", "_payFees", "claimCuratorFees", "restore"].sort());
  });

  it("is pinned by the Solidity suite too: the curator cannot withdraw principal or shares", () => {
    const suite = readFileSync(join(process.cwd(), "..", "test", "attacks", "AttackCatalogue.t.sol"), "utf8");
    expect(suite).toMatch(/function test_13_2_01_curatorCannotWithdrawPrincipal\(\)/);
  });
});
