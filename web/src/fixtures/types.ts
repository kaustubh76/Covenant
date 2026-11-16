// Fixtures recorded from the real contracts by scripts/record.ts, so the landing page shows real outcomes with no
// chain running. Everything here is plain JSON: no bigints, no functions.

import type { Who } from "@/chain/accounts";
import type { BeatInput } from "@/chain/beat";
import type { DecodedError, Rule } from "@/chain/errors";
import type { ShapeSource } from "@/components/covenant/ShapeChart";
import type { VaultView } from "@/chain/view";

/** What the landing page draws and states about one vault state. */
export type RecordedView = ShapeSource & {
  support: { have: number; need: number };
  principal: { quote: number; token: number };
  terms: ShapeSource["terms"] & { supportBps: number; supportBandTicks: number };
};

export interface RecordedError {
  name: string;
  signature: string;
  rule: Rule;
  reason: string;
}

export interface RecordedBeat {
  actor: Who;
  title: string;
  detail?: string;
  ok: boolean;
  error?: RecordedError;
}

export interface Recorded {
  recordedAt: string;
  hero: { migrated: RecordedView; shaped: RecordedView; tries: { key: string; label: string; error: RecordedError }[] };
  story: {
    raw: RecordedView;
    shaped: RecordedView;
    dumped: RecordedView;
    crashed: RecordedView;
    restored: RecordedView;
    dumpTokens: number;
    dumpDropTicks: number;
    fullDumpDropTicks: number;
    softRug: RecordedError;
    crashTicks: number;
    bounty: number;
  };
  proof: { supportFrom: number; supportTo: number; ratio: number; blocked: number; total: number };
  impact: { size: number; full: number; managed: number }[];
  revertTape: string[];
  attacks: Record<string, { blocked: boolean; summary: string; beats: RecordedBeat[] }>;
}

export function recordView(v: VaultView): RecordedView {
  return {
    spot: v.spot,
    twap: v.twap,
    band: v.band,
    anchor: v.anchor,
    ceiling: v.ceiling,
    quoteIs0: v.quoteIs0,
    tickSpacing: v.tickSpacing,
    tokenSymbol: v.tokenSymbol,
    quoteSymbol: v.quoteSymbol,
    ranges: v.ranges.map((r) => ({ priceLower: r.priceLower, priceUpper: r.priceUpper, L: r.L })),
    terms: { guardTicks: v.terms.guardTicks, supportBps: v.terms.supportBps, supportBandTicks: v.terms.supportBandTicks },
    support: { have: v.support.have, need: v.support.need },
    principal: v.principal,
  };
}

export const recordError = (e: DecodedError): RecordedError => ({ name: e.name, signature: e.signature, rule: e.rule, reason: e.reason });

export const recordBeat = (b: BeatInput): RecordedBeat => ({ actor: b.actor, title: b.title, detail: b.detail, ok: b.ok, error: b.error ? recordError(b.error) : undefined });
