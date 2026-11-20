// Where each attack has been played for real on Base Sepolia: the recorded proof steps (deployments/84532*.proof.json,
// read by server/live.ts) whose transactions are the attack's moves. The attack lab links each card to these, the
// ledger counts them, and a test fails if any of the twenty is left without one.

/** A proof on record: the covenant proof (CVNT), the LP and management proofs (CVLP), the refusal proof (CVNT) and the lifecycle proof (CVQ). */
export type StoryKey = "covenant" | "lp" | "manage" | "refusals" | "lifecycle";
export type StepRef = readonly [story: StoryKey, step: string];

export const ATTACK_TXS: Record<string, readonly StepRef[]> = {
  "curator-withdraw": [
    ["refusals", "curatorWithdraw"],
    ["lifecycle", "curatorShares"],
    ["lifecycle", "curatorPrincipal"],
  ],
  skim: [["refusals", "skim"]],
  softrug: [
    ["covenant", "rug"],
    ["lifecycle", "newCuratorRug"],
  ],
  manipulate: [
    ["lifecycle", "dump"],
    ["lifecycle", "guardReshape"],
    ["lifecycle", "guardDeposit"],
    ["lifecycle", "guardRestore"],
  ],
  flash: [
    ["lifecycle", "flashSell"],
    ["lifecycle", "flashBuy"],
    ["lifecycle", "flashCheck"],
  ],
  pace: [["manage", "overpace"]],
  "instant-curator": [
    ["lifecycle", "propose"],
    ["lifecycle", "acceptEarly"],
    ["lifecycle", "accept"],
    ["lifecycle", "newCuratorRug"],
  ],
  fragment: [["refusals", "fragment"]],
  farm: [["refusals", "farm"]],
  "cheap-shares": [["lp", "join"]],
  "lp-exit": [["lp", "leave"]],
  "big-dump": [["covenant", "crash"]],
  "issuer-exit": [
    ["refusals", "issuerExit"],
    ["lifecycle", "lockedEarly"],
  ],
  outsider: [["refusals", "outsider"]],
  "pump-quick": [
    ["lifecycle", "pump"],
    ["lifecycle", "quickRestore"],
    ["lifecycle", "sellBack"],
  ],
  "pump-patient": [
    ["lifecycle", "pump"],
    ["lifecycle", "patientRestore"],
    ["lifecycle", "sellBack"],
  ],
  "colluding-curator": [
    ["manage", "pump"],
    ["manage", "chase"],
  ],
  "freeze-exits": [
    ["lifecycle", "dump"],
    ["lifecycle", "lpExitTripped"],
  ],
  "dust-restore": [["covenant", "restore"]],
  "vault-pays": [["refusals", "vaultPays"]],
};
