// Govern's "who can do what" table, checked against CovenantVault.sol's access checks.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { covenantVaultAbi } from "./abi.generated";
import { POWERS } from "./powers";

const SOURCE = readFileSync(join(process.cwd(), "..", "src", "CovenantVault.sol"), "utf8");

/** A function's declaration and body in the vault's source, up to the next function. */
function fnSource(name: string): string {
  const start = SOURCE.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`function ${name} not found in CovenantVault.sol`);
  const next = SOURCE.slice(start + 1).search(/\n\s*function\s/);
  return next < 0 ? SOURCE.slice(start) : SOURCE.slice(start, start + 1 + next);
}

const issuerOnly = (src: string) => /\bonlyIssuer\b/.test(src.slice(0, src.indexOf("{")));
/** The curator alone: a NotCurator check, or a payout of the caller's own accrued curator fees. */
const curatorOnly = (src: string) => /msg\.sender\s*!=\s*curator\)\s*revert\s+NotCurator/.test(src) || /curatorFees0\[msg\.sender\]/.test(src);

describe("Govern's table of powers", () => {
  it("names only functions the vault has", () => {
    const names = new Set((covenantVaultAbi as readonly { type: string; name?: string }[]).filter((x) => x.type === "function").map((x) => x.name));
    for (const p of POWERS) for (const fn of p.fns) expect(names.has(fn), `${fn} (${p.what})`).toBe(true);
  });

  it("gives each power to exactly whom the contract does", () => {
    for (const p of POWERS) {
      for (const fn of p.fns) {
        const src = fnSource(fn);
        const actual = issuerOnly(src) ? "issuer" : curatorOnly(src) ? "curator" : "anyone";
        expect(actual, `${fn}: "${p.what}"`).toBe(p.access);
      }
    }
  });

  it("is right that no function changes the terms: none takes Terms, and none is named for them", () => {
    const writes = (covenantVaultAbi as unknown as readonly { type: string; name?: string; stateMutability?: string; inputs?: readonly { type: string; internalType?: string }[] }[]).filter(
      (x) => x.type === "function" && (x.stateMutability === "nonpayable" || x.stateMutability === "payable"),
    );
    for (const w of writes) {
      expect(/terms/i.test(w.name ?? ""), `${w.name} looks like a terms setter`).toBe(false);
      // the factory sets terms once, at creation (initialize); after that no vault function accepts them
      if (w.name !== "initialize") expect(w.inputs?.some((i) => /Terms/.test(i.internalType ?? "")) ?? false, `${w.name} takes Terms`).toBe(false);
    }
  });
});
