// The live proof (scripts/lib/proof.ts) end to end, on a fork of Base Sepolia with a deployment and launch of its own:
// every step a real transaction through the app's public-chain code, the TWAP window jumped over. The live run against
// the CVNT vault is recorded in deployments/84532.proof.json; this keeps the runner honest without touching it.

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type Fork, startFork } from "../scripts/lib/forkchain";
import { type LpProofRecord, runLpProof } from "../scripts/lib/lpproof";
import { type ManageProofRecord, runManageProof } from "../scripts/lib/manageproof";
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

// The LP and management proofs (scripts/lib/lpproof.ts, manageproof.ts) on a launch of their own with the contract's
// minimum one-hour epoch, as CVLP was launched on Base Sepolia: the setup epoch jumped over, then every step a real
// transaction, the LP proof first and the management proof after it, on the same vault.
describe.skipIf(inject("forkSkip"))("the LP and management proofs, rehearsed on a fork of their own", () => {
  let fork: Fork;
  let proof: LpProofRecord;
  let manage: ManageProofRecord;

  beforeAll(async () => {
    fork = await startFork({ port: PORT + 1, blockTime: 1, durationBlocks: 32, epochLength: 3600, records: `${RECORDS}-lp` });
    proof = await runLpProof({
      net: "base-sepolia-fork",
      records: `${RECORDS}-lp`,
      rpcUrl: fork.rpcUrl,
      signer: { account: privateKeyToAccount(fork.key) },
      lp: privateKeyToAccount(generatePrivateKey()),
      warp: true,
      fresh: true,
    });
    manage = await runManageProof({
      net: "base-sepolia-fork",
      records: `${RECORDS}-lp`,
      rpcUrl: fork.rpcUrl,
      signer: { account: privateKeyToAccount(fork.key) },
      warp: true,
      fresh: true,
    });
  }, 600_000);

  afterAll(async () => {
    await fork?.stop();
  });

  it("waits out the setup epoch, then the LP joins in kind for a tenth of the shares", () => {
    expect(proof.steps.join?.status).toBe("success");
    expect(proof.steps.join?.detail).toMatch(/ETH and .* for 9\.1% of the vault's shares/);
  });

  it("collects the trades' fees and pays the LP its share", () => {
    for (const key of ["buy", "sell", "collect", "claim"] as const) expect(proof.steps[key]?.status, key).toBe("success");
  });

  it("lets the LP leave with every share it was given, in kind", () => {
    expect(proof.steps.leave?.status).toBe("success");
    expect(proof.steps.leave?.value).toBe(proof.steps.join?.value);
  });

  it("has the chain refuse the curator's chase above the Anchor, with BidAboveCeiling", () => {
    expect(manage.steps.pump?.status).toBe("success");
    expect(manage.steps.chase?.status).toBe("reverted");
    expect(manage.steps.chase?.error).toMatch(/^BidAboveCeiling\(/);
    expect(manage.steps.chase?.detail).toMatch(/a bid up to [\d.]+ ETH, over the Anchor ceiling at [\d.]+$/);
  });

  it("settles the curator's re-centre capped at the Anchor, within Pace", () => {
    expect(manage.steps.recentre?.status).toBe("success");
    expect(manage.steps.recentre?.detail).toMatch(/capped at the Anchor ceiling; support \d+\.\d%; Pace left this epoch: \d+\.\d% of the vault's value/);
  });

  it("has the chain refuse moving everything in the same epoch, with PaceExceeded", () => {
    expect(manage.steps.overpace?.status).toBe("reverted");
    expect(manage.steps.overpace?.error).toMatch(/^PaceExceeded\(/);
  });
});
