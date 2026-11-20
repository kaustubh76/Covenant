// The ledger on record (deployments/84532.ledger.json, `npm run ledger`) must cover everything: each state-changing
// function a person can call has settled on Base Sepolia, every refusal on record is decoded, and each of the attack
// lab's attacks links a transaction that played it. A new function or attack without one fails here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { covenantVaultAbi } from "./abi.generated";
import { CATALOGUE, type Ledger, fnNames } from "./ledger";
import { ATTACKS } from "./scenarios/attacks";
import { ATTACK_TXS } from "./scenarios/onchain";

const ledger = JSON.parse(readFileSync(join(process.cwd(), "..", "deployments", "84532.ledger.json"), "utf8")) as Ledger;
/** The vault's plumbing: called by the factory or the PoolManager, never by a person. */
const INTERNAL = new Set(["initialize", "unlockCallback"]);

describe("the ledger", () => {
  it("lists every state-changing vault function a person can call", () => {
    const listed = new Set(CATALOGUE.filter((c) => c.contract === "CovenantVault").flatMap(fnNames));
    const writes = (covenantVaultAbi as readonly { type: string; name?: string; stateMutability?: string }[])
      .filter((x) => x.type === "function" && (x.stateMutability === "nonpayable" || x.stateMutability === "payable") && !INTERNAL.has(x.name ?? ""))
      .map((x) => x.name);
    for (const fn of writes) expect(listed, `CovenantVault.${fn} is missing from CATALOGUE`).toContain(fn);
  });

  it("has a settled Base Sepolia transaction for every one of them", () => {
    const missing = ledger.coverage.filter((c) => !c.settled.length).map((c) => `${c.contract}.${c.fn}`);
    expect(missing).toEqual([]);
    expect(ledger.coverage.length).toBe(CATALOGUE.length);
  });

  it("decodes every refusal on record", () => {
    for (const t of ledger.txs.filter((x) => x.status === "reverted")) expect(t.error, t.hash).toMatch(/^[A-Z][A-Za-z0-9]*\(/);
  });

  it("links every attack in the lab to a transaction that played it", () => {
    expect(Object.keys(ATTACK_TXS).sort()).toEqual(ATTACKS.map((a) => a.id).sort());
    expect(ledger.cards?.map((c) => c.id).sort()).toEqual(ATTACKS.map((a) => a.id).sort());
    const bare = ATTACKS.filter((a) => !ledger.attacks[a.id]?.length).map((a) => a.id);
    expect(bare).toEqual([]);
    const hashes = new Set(ledger.txs.map((t) => t.hash.toLowerCase()));
    for (const [id, txs] of Object.entries(ledger.attacks)) for (const t of txs) expect(hashes, `${id}: ${t.hash}`).toContain(t.hash.toLowerCase());
  });
});
