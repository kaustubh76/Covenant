// Who may do what to a vault, as Govern's table shows it. Each row names the contract functions behind it, so
// powers.test.ts can check the table against CovenantVault.sol's own access checks rather than trust its wording.

/** Who a power belongs to: the issuer, the curator, anyone at all, or nobody (no function does it). */
export type Access = "issuer" | "curator" | "anyone" | "nobody";

export interface Power {
  what: string;
  /** The vault functions behind it; none for a power no function grants. */
  fns: string[];
  access: Access;
}

export const POWERS: Power[] = [
  { what: "Move liquidity along the price axis, within the rules", fns: ["reshape"], access: "curator" },
  { what: "Withdraw launch liquidity before it vests", fns: [], access: "nobody" },
  { what: "Withdraw vested principal, to the treasury only", fns: ["withdrawPrincipal"], access: "issuer" },
  { what: "Propose a new curator (timelocked)", fns: ["proposeCurator"], access: "issuer" },
  { what: "Accept the new curator after the timelock", fns: ["acceptCurator"], access: "anyone" },
  { what: "Collect the principal's fees to the treasury", fns: ["collectFees"], access: "anyone" },
  { what: "Claim the curator's fee share", fns: ["claimCuratorFees"], access: "curator" },
  { what: "Restore support for a bounty", fns: ["restore"], access: "anyone" },
  { what: "Deposit and withdraw in kind", fns: ["deposit", "withdraw"], access: "anyone" },
  { what: "Sync the Anchor (poke)", fns: ["poke"], access: "anyone" },
  { what: "Change the covenant's terms", fns: [], access: "nobody" },
];

/** The table's columns, in order. */
export const POWER_COLUMNS = ["Issuer", "Curator", "Keeper", "Anyone"] as const;

/** A power's row: which of the columns may do it. */
export function powerRow(p: Power): boolean[] {
  if (p.access === "anyone") return [true, true, true, true];
  if (p.access === "issuer") return [true, false, false, false];
  if (p.access === "curator") return [false, true, false, false];
  return [false, false, false, false];
}
