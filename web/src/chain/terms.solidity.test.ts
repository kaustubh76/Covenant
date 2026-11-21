// The app's copies of the Solidity's term presets and bounds, checked against the source they copy: a preset the
// Launch page offers is exactly the one the contracts' tests use, and the page refuses exactly what TermsLib refuses.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEther } from "viem";
import { describe, expect, it } from "vitest";
import { PRESETS, type PresetKey, type Terms, termsProblems } from "./terms";

const ROOT = join(process.cwd(), "..");
const UNITS: Record<string, bigint> = { seconds: 1n, minutes: 60n, hours: 3600n, days: 86_400n, weeks: 604_800n };

/** A Solidity literal with its unit (`1 days`, `30 minutes`, `0.01 ether`, `4000`), as a number of base units. */
function literal(v: string): bigint {
  const m = v.trim().match(/^([0-9_.]+)\s*(seconds|minutes|hours|days|weeks|ether)?$/);
  if (!m) throw new Error(`cannot read the literal ${v}`);
  const n = m[1].replace(/_/g, "");
  if (m[2] === "ether") return parseEther(n);
  return BigInt(n) * (m[2] ? UNITS[m[2]] : 1n);
}

/** Each preset in test/base/Presets.sol, field by field. */
function solidityPresets(): Record<PresetKey, Record<string, bigint>> {
  const text = readFileSync(join(ROOT, "test", "base", "Presets.sol"), "utf8");
  const out = {} as Record<PresetKey, Record<string, bigint>>;
  for (const key of ["conservative", "standard", "aggressive"] as const) {
    const body = text.match(new RegExp(`function ${key}\\(\\)[^{]*\\{[^]*?Terms\\(\\{([^]*?)\\}\\)`))?.[1];
    if (!body) throw new Error(`preset ${key} not found in Presets.sol`);
    out[key] = Object.fromEntries(
      body
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => {
          const [k, val] = x.split(":");
          return [k.trim(), literal(val)];
        }),
    );
  }
  return out;
}

/** `int24 internal constant NAME = value;` in TermsLib.sol. */
function bound(name: string): number {
  const text = readFileSync(join(ROOT, "src", "libraries", "TermsLib.sol"), "utf8");
  const m = text.match(new RegExp(`constant\\s+${name}\\s*=\\s*([^;]+);`));
  if (!m) throw new Error(`${name} not found in TermsLib.sol`);
  return Number(literal(m[1]));
}

describe("the Launch page's presets", () => {
  it("are exactly test/base/Presets.sol's, every field", () => {
    const sol = solidityPresets();
    for (const key of ["conservative", "standard", "aggressive"] as const) {
      const ts = PRESETS[key] as unknown as Record<string, number | bigint>;
      expect(Object.keys(ts).sort(), key).toEqual(Object.keys(sol[key]).sort());
      for (const [field, value] of Object.entries(sol[key])) expect(BigInt(ts[field]), `${key}.${field}`).toBe(value);
    }
  });
});

describe("the Launch page's term checks", () => {
  const base: Terms = { ...PRESETS.standard };
  const spacing = 60;
  const maxWindow = 7_200;
  const ok = (t: Partial<Terms>) => termsProblems({ ...base, ...t }, spacing, maxWindow).length === 0;

  it("refuse exactly what TermsLib.validate refuses, at each of its bounds", () => {
    const maxGuard = bound("MAX_GUARD_TICKS");
    const maxBand = bound("MAX_BAND_TICKS");
    const minEpoch = bound("MIN_EPOCH");
    const maxEpoch = bound("MAX_EPOCH");
    const minWindow = bound("MIN_WINDOW");
    const maxFee = bound("MAX_CURATOR_FEE_BPS");

    expect(ok({ guardTicks: maxGuard, supportBandTicks: maxGuard + 3 * spacing })).toBe(true);
    expect(ok({ guardTicks: maxGuard + 1, supportBandTicks: maxGuard + 1 + 3 * spacing })).toBe(false);
    expect(ok({ supportBandTicks: maxBand })).toBe(true);
    expect(ok({ supportBandTicks: maxBand + 1 })).toBe(false);
    // the band must clear the guard by three tick spacings
    expect(ok({ supportBandTicks: base.guardTicks + 3 * spacing })).toBe(true);
    expect(ok({ supportBandTicks: base.guardTicks + 3 * spacing - 1 })).toBe(false);
    expect(ok({ epochLength: minEpoch })).toBe(true);
    expect(ok({ epochLength: minEpoch - 1 })).toBe(false);
    expect(ok({ epochLength: maxEpoch })).toBe(true);
    expect(ok({ epochLength: maxEpoch + 1 })).toBe(false);
    expect(ok({ twapWindow: minWindow })).toBe(true);
    expect(ok({ twapWindow: minWindow - 1 })).toBe(false);
    expect(ok({ twapWindow: maxWindow })).toBe(true);
    expect(ok({ twapWindow: maxWindow + 1 })).toBe(false);
    expect(ok({ curatorFeeBps: maxFee })).toBe(true);
    expect(ok({ curatorFeeBps: maxFee + 1 })).toBe(false);
    expect(ok({ supportBps: 10_000 })).toBe(true);
    expect(ok({ supportBps: 10_001 })).toBe(false);
    expect(ok({ supportBps: 0 })).toBe(false);
    expect(ok({ paceBps: 10_000 })).toBe(true);
    expect(ok({ paceBps: 0 })).toBe(false);
  });

  it("take the averaging window's cap from the hook, not a constant: a smaller cap refuses more", () => {
    expect(termsProblems({ ...base, twapWindow: 3_600 }, spacing, 1_800).length).toBe(1);
    expect(termsProblems({ ...base, twapWindow: 3_600 }, spacing, 7_200).length).toBe(0);
  });
});
