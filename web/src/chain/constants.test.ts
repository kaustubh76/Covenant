// The app's copies of contract constants that have no getter, checked against the Solidity they come from.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BOUNTY_MAX_BPS, BOUNTY_RESERVE, IDLE_BPS, IDLE_FLOOR_WEI, MAX_RANGES, PRINCIPAL_SHARES, RESHAPE_MAX_RANGES, idleAllowance } from "./constants";

const SRC = join(process.cwd(), "..", "src");
/** The value of `uint256 internal constant NAME = value;` in a contract source file. */
function solidityConstant(file: string, name: string): bigint {
  const text = readFileSync(join(SRC, file), "utf8");
  const m = text.match(new RegExp(`constant\\s+${name}\\s*=\\s*([0-9_]+)(?:e([0-9]+))?\\s*;`));
  if (!m) throw new Error(`${name} not found in ${file}`);
  return BigInt(m[1].replace(/_/g, "")) * 10n ** BigInt(m[2] ?? 0);
}

describe("contract constants the app restates", () => {
  it("match the Solidity they come from", () => {
    expect(BigInt(MAX_RANGES)).toBe(solidityConstant("vault/VaultStorage.sol", "MAX_RANGES"));
    expect(BigInt(RESHAPE_MAX_RANGES)).toBe(solidityConstant("vault/VaultStorage.sol", "RESHAPE_MAX_RANGES"));
    expect(PRINCIPAL_SHARES).toBe(solidityConstant("vault/VaultStorage.sol", "PRINCIPAL_SHARES"));
    expect(BigInt(IDLE_BPS)).toBe(solidityConstant("vault/VaultOps.sol", "IDLE_BPS"));
    expect(IDLE_FLOOR_WEI).toBe(solidityConstant("vault/VaultOps.sol", "IDLE_FLOOR"));
    expect(BigInt(BOUNTY_RESERVE)).toBe(solidityConstant("CovenantVault.sol", "BOUNTY_RESERVE"));
    expect(BigInt(BOUNTY_MAX_BPS)).toBe(solidityConstant("CovenantVault.sol", "BOUNTY_MAX_BPS"));
  });

  it("would catch a change: a different value in the source is a different number here", () => {
    expect(() => solidityConstant("CovenantVault.sol", "NO_SUCH_CONSTANT")).toThrow(/not found/);
  });

  it("compute the idle allowance as VaultOps does: a share of what was handled, never under the floor", () => {
    expect(idleAllowance(0n)).toBe(1000n);
    expect(idleAllowance(10n ** 18n)).toBe(10n ** 15n);
    expect(idleAllowance(500_000n)).toBe(1000n);
  });
});
