// The ledger: every transaction Covenant's own keys have sent on Base Sepolia, decoded, and what it covers. Built by
// `npm run ledger` (scripts/ledger.ts) from Blockscout and the proof records into deployments/84532.ledger.json; read by
// the /ledger page, and checked by a test that fails if any function below has no settled transaction on record.

import type { Address, Hex } from "viem";

/** Who sent it: the deployer (issuer, curator and treasury of the launches), a key derived from it, or the backend's relayer. */
export type LedgerRole = "deployer" | "keeper" | "lp" | "curator2" | "issuer2" | "attacker" | "relayer";

export interface LedgerTx {
  hash: Hex;
  block: number;
  /** ISO time the block was made. */
  time: string;
  from: Address;
  role: LedgerRole;
  to: Address | null;
  /** What `to` is: a Covenant contract, Uniswap's, a launch's token, a helper being funded, or a deployment. */
  target: string;
  /** The vault it acts on, when there is one. */
  vault?: Address;
  /** Contract.function, e.g. CovenantVault.reshape, or "transfer" for plain ETH and "deploy" for a contract creation. */
  fn: string;
  status: "success" | "reverted";
  /** The decoded revert, e.g. IdleTooLarge(738550211640646, 9). */
  error?: string;
  /** The proof step this transaction is, when it is one. */
  story?: string;
  step?: string;
  title?: string;
}

export interface CoverageRow {
  contract: string;
  fn: string;
  /** Who may call it. */
  who: string;
  /** What it does, in a few words. */
  what: string;
  settled: { hash: Hex; vault?: Address }[];
  refused: { hash: Hex; error: string; vault?: Address }[];
}

export interface Ledger {
  network: string;
  chainId: number;
  explorer: string;
  generatedAt: string;
  generatedAtBlock: number;
  addresses: Partial<Record<LedgerRole, Address[]>>;
  vaults: { vault: Address; symbol: string }[];
  txs: LedgerTx[];
  coverage: CoverageRow[];
  /** Each attack card, with the transactions that played it. */
  attacks: Record<
    string,
    {
      story: string;
      step: string;
      hash: Hex;
      status: "success" | "reverted";
      error?: string;
      vault: Address;
      symbol: string;
    }[]
  >;
}

/**
 * Every state-changing function a person can call on Covenant and on the Uniswap launch path it runs through. Each must
 * have at least one settled transaction on Base Sepolia; the refusals are the attacks.
 */
export const CATALOGUE: {
  contract: string;
  fn: string | string[];
  who: string;
  what: string;
}[] = [
  {
    contract: "CovenantFactory",
    fn: "createVault",
    who: "Issuer",
    what: "Create the vault and register the launch",
  },
  {
    contract: "LBPStrategy",
    fn: "initializeDistribution",
    who: "Issuer",
    what: "Open the auction",
  },
  {
    contract: "CCA",
    fn: "submitBid",
    who: "Bidder",
    what: "Bid in the auction",
  },
  {
    contract: "CCA",
    fn: "checkpoint",
    who: "Anyone",
    what: "Close the auction",
  },
  {
    contract: "LBPStrategy",
    fn: "migrate",
    who: "Anyone",
    what: "Migrate the raise into the pool",
  },
  {
    contract: "CovenantVault",
    fn: "adopt",
    who: "Anyone",
    what: "Adopt the launch's liquidity",
  },
  {
    contract: "CCA",
    fn: ["exitBid", "exitPartiallyFilledBid"],
    who: "Bidder",
    what: "Exit a bid",
  },
  {
    contract: "CCA",
    fn: "claimTokens",
    who: "Bidder",
    what: "Claim the bought tokens",
  },
  {
    contract: "CovenantVault",
    fn: "reshape",
    who: "Curator",
    what: "Reshape the liquidity",
  },
  {
    contract: "CovenantVault",
    fn: "fundBounty",
    who: "Anyone",
    what: "Fund the restore bounty",
  },
  {
    contract: "PoolSwapTest",
    fn: "swap",
    who: "Trader",
    what: "Trade in the pool (the hook runs)",
  },
  {
    contract: "CovenantVault",
    fn: "poke",
    who: "Anyone",
    what: "Sync the Anchor",
  },
  {
    contract: "CovenantVault",
    fn: "restore",
    who: "Anyone",
    what: "Restore lapsed support, for the bounty",
  },
  {
    contract: "CovenantVault",
    fn: "collectFees",
    who: "Anyone",
    what: "Collect the principal's fees",
  },
  {
    contract: "CovenantVault",
    fn: "claimCuratorFees",
    who: "Curator",
    what: "Claim the curator's fee share",
  },
  { contract: "CovenantVault", fn: "deposit", who: "LP", what: "Join in kind" },
  {
    contract: "CovenantVault",
    fn: "claimFees",
    who: "LP",
    what: "Claim an LP's fees",
  },
  {
    contract: "CovenantVault",
    fn: "withdraw",
    who: "LP",
    what: "Leave in kind",
  },
  {
    contract: "CovenantVault",
    fn: "withdrawPrincipal",
    who: "Issuer",
    what: "Take vested principal",
  },
  {
    contract: "CovenantVault",
    fn: "proposeCurator",
    who: "Issuer",
    what: "Propose a new curator",
  },
  {
    contract: "CovenantVault",
    fn: "cancelCuratorProposal",
    who: "Issuer",
    what: "Cancel the proposal",
  },
  {
    contract: "CovenantVault",
    fn: "acceptCurator",
    who: "Anyone",
    what: "Complete the change after the timelock",
  },
  {
    contract: "CovenantVault",
    fn: "transferIssuer",
    who: "Issuer",
    what: "Hand over the issuer role",
  },
  {
    contract: "CovenantVault",
    fn: "acceptIssuer",
    who: "Pending issuer",
    what: "Accept the issuer role",
  },
];

export const fnNames = (c: (typeof CATALOGUE)[number]) => (Array.isArray(c.fn) ? c.fn : [c.fn]);
