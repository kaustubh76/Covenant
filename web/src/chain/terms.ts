import { parseEther } from "viem";

const DAY = 86_400;
const HOUR = 3_600;

/** The covenant's terms, as the contract stores them (src/types/CovenantTypes.sol). */
export interface Terms {
  supportBps: number;
  supportBandTicks: number;
  paceBps: number;
  epochLength: number;
  guardTicks: number;
  twapWindow: number;
  lockDuration: number;
  vestDuration: number;
  curatorTimelock: number;
  bounty: bigint;
  curatorFeeBps: number;
}

export type PresetKey = "conservative" | "standard" | "aggressive";

/** The spec's presets (docs/SPEC.md §17), exactly as test/base/Presets.sol defines them. */
export const PRESETS: Record<PresetKey, Terms> = {
  conservative: {
    supportBps: 5000,
    supportBandTicks: 2000,
    paceBps: 3000,
    epochLength: DAY,
    guardTicks: 300,
    twapWindow: 30 * 60,
    lockDuration: 180 * DAY,
    vestDuration: 90 * DAY,
    curatorTimelock: 3 * DAY,
    bounty: parseEther("0.01"),
    curatorFeeBps: 1000,
  },
  standard: {
    supportBps: 4000,
    supportBandTicks: 1500,
    paceBps: 5000,
    epochLength: DAY,
    guardTicks: 300,
    twapWindow: 30 * 60,
    lockDuration: 90 * DAY,
    vestDuration: 30 * DAY,
    curatorTimelock: 2 * DAY,
    bounty: parseEther("0.01"),
    curatorFeeBps: 1000,
  },
  aggressive: {
    supportBps: 3000,
    supportBandTicks: 1000,
    paceBps: 7000,
    epochLength: 12 * HOUR,
    guardTicks: 500,
    twapWindow: 15 * 60,
    lockDuration: 60 * DAY,
    vestDuration: 30 * DAY,
    curatorTimelock: DAY,
    bounty: parseEther("0.01"),
    curatorFeeBps: 1000,
  },
};

export const PRESET_INFO: { key: PresetKey; name: string; blurb: string }[] = [
  { key: "conservative", name: "Conservative", blurb: "Community launches" },
  { key: "standard", name: "Standard", blurb: "A balanced default" },
  { key: "aggressive", name: "Aggressive", blurb: "Deep CEX co-listing" },
];

/** Terms as returned by viem from the contract (bigint for the uint128 bounty, numbers for the rest). */
export function termsFromChain(t: {
  supportBps: number;
  supportBandTicks: number;
  paceBps: number;
  epochLength: number;
  guardTicks: number;
  twapWindow: number;
  lockDuration: number;
  vestDuration: number;
  curatorTimelock: number;
  bounty: bigint;
  curatorFeeBps: number;
}): Terms {
  return { ...t };
}

/** The checks TermsLib.validate makes, as inline hints. The factory is the authority. */
export function termsProblems(t: Terms, tickSpacing: number, maxWindow = 7_200): string[] {
  const out: string[] = [];
  if (t.supportBps < 1 || t.supportBps > 10_000) out.push("Support must be between 0.01% and 100%.");
  if (t.guardTicks <= 0 || t.guardTicks > 10_000) out.push("The guard must be between 1 and 10,000 ticks.");
  const minBand = t.guardTicks + 3 * tickSpacing;
  if (t.supportBandTicks < minBand || t.supportBandTicks > 200_000) out.push(`The band must be at least the guard plus three tick spacings (${minBand} ticks).`);
  if (t.paceBps < 1 || t.paceBps > 10_000) out.push("Pace must be between 0.01% and 100%.");
  if (t.epochLength < HOUR || t.epochLength > 30 * DAY) out.push("The epoch must be between 1 hour and 30 days.");
  if (t.twapWindow < 300 || t.twapWindow > maxWindow) out.push(`The averaging window must be between 5 minutes and ${maxWindow / 60} minutes.`);
  if (t.curatorFeeBps > 3000) out.push("The curator fee is capped at 30%.");
  return out;
}
