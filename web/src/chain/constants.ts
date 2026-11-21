// Contract constants the app needs but cannot read: none of these has a getter. Each is pinned to its Solidity source
// by constants.test.ts, so a change in the contracts fails the tests instead of leaving the app quoting an old value.
// Parameters that do have a getter (the terms, the hook's window) are read from the chain instead, never restated here.

/** The most ranges a vault may hold (VaultStorage.MAX_RANGES). */
export const MAX_RANGES = 16;
/** The most ranges a reshape may leave (VaultStorage.RESHAPE_MAX_RANGES): room for a restore's two. */
export const RESHAPE_MAX_RANGES = 14;
/** The principal's shares (VaultStorage.PRINCIPAL_SHARES). */
export const PRINCIPAL_SHARES = 10n ** 18n;
/** What a reshape may leave idle: IDLE_BPS of what it handled, but never less than IDLE_FLOOR wei (VaultOps). */
export const IDLE_BPS = 10;
export const IDLE_FLOOR_WEI = 1000n;
/** Collected fees keep the bounty pool topped up to this many bounties (CovenantVault.BOUNTY_RESERVE). */
export const BOUNTY_RESERVE = 3;
/** A restore's bounty is at most this share, in basis points, of the quote it moves (CovenantVault.BOUNTY_MAX_BPS). */
export const BOUNTY_MAX_BPS = 100;

/** The idle allowance a reshape handling `handled` wei gets: max(IDLE_BPS of it, IDLE_FLOOR), as VaultOps computes. */
export function idleAllowance(handled: bigint): bigint {
  const cap = (handled * BigInt(IDLE_BPS)) / 10_000n;
  return cap > IDLE_FLOOR_WEI ? cap : IDLE_FLOOR_WEI;
}
