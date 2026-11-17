// The live proof (scripts/lib/proof.ts) end to end, on a fork of Base Sepolia with a deployment and launch of its own:
// every step a real transaction through the app's public-chain code, the TWAP window jumped over. The live run against
// the CVNT vault is recorded in deployments/84532.proof.json; this keeps the runner honest without touching it.

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type Fork, startFork } from "../scripts/lib/forkchain";
import { type ProofRecord, runProof } from "../scripts/lib/proof";

const PORT = 8551;
const RECORDS = "84532-fork-proof-test";

describe.skipIf(inject("forkSkip"))("the live proof, rehearsed on a fork of its own", () => {
  let fork: Fork;
  let proof: ProofRecord;

  beforeAll(async () => {
    fork = await startFork({ port: PORT, blockTime: 1, durationBlocks: 32, records: RECORDS });
    proof = await runProof({
      net: "base-sepolia-fork",
      records: RECORDS,
      rpcUrl: fork.rpcUrl,
      signer: { account: privateKeyToAccount(fork.key) },
      keeper: privateKeyToAccount(generatePrivateKey()),
      warp: true,
      fresh: true,
    });
  }, 600_000);

  afterAll(async () => {
    await fork?.stop();
  });

  it("finds by simulation a sell-off that strands support, before sending anything", () => {
    expect(proof.plan).toBeDefined();
    expect(proof.plan!.supportAfterHold).toBeLessThan(4000);
    expect(proof.plan!.supportAfterRestore).toBeGreaterThanOrEqual(4000);
  });

  it("has the chain itself revert the curator's soft rug, with SupportBroken", () => {
    expect(proof.steps.rug?.status).toBe("reverted");
    expect(proof.steps.rug?.error).toMatch(/^SupportBroken\(/);
  });

  it("settles the honest reshape, the sell-off, the stranger's restore and the fee collection", () => {
    for (const key of ["deepen", "crash", "restore", "fees"] as const) expect(proof.steps[key]?.status, key).toBe("success");
    expect(proof.steps.restore!.detail).toMatch(/→ 100\.0%|→ [4-9]\d\.\d%/);
  });

  it("pays the keeper a bounty and tops the pool back up by the same amount", () => {
    expect(BigInt(proof.steps.restore!.value ?? "0")).toBeGreaterThan(0n);
    expect(proof.steps.refill?.value).toBe(proof.steps.restore!.value);
  });
});
