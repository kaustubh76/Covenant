"use client";

import { formatEther } from "viem";
import { BOUNTY_MAX_BPS, IDLE_BPS } from "@/chain/constants";
import { ticksBelowPct, ticksToPct } from "@/chain/price";
import type { Terms } from "@/chain/terms";
import { Seal } from "@/components/shell/AppShell";
import { duration, pct } from "@/lib/format";

/** How far above a price `ticks` reaches, and how far below: a band under the TWAP is measured downward. */
const up = (ticks: number) => `${ticksToPct(ticks).toFixed(1)}%`;
const down = (ticks: number) => `${ticksBelowPct(ticks).toFixed(1)}%`;

/**
 * The covenant as a bidder reads it: the vault's immutable terms, fixed before the auction opens. `terms` are the
 * vault's own (`vault.terms()`), or a draft's before it exists; `symbol` is its token's. The quote is ETH unless said
 * otherwise: the app reads ETH-quoted vaults only (chain/view.ts UnsupportedQuote).
 */
export function TermsCard({ terms: t, symbol, quote = "ETH", compact }: { terms: Terms; symbol: string; quote?: string; compact?: boolean }) {
  const rows: [string, React.ReactNode][] = [
    [
      "Conservation",
      <>
        A reshape puts back everything it lifts: at most <b>{pct(IDLE_BPS, 1)}</b> of what it handles may sit idle in the vault. There is no path for liquidity to leave the pool early.
      </>,
    ],
    [
      "Support",
      <>
        At least <b>{pct(t.supportBps, 0)}</b> of the vault&apos;s {quote} bids within <b>{down(t.supportBandTicks)}</b> below the average price.
      </>,
    ],
    [
      "Pace",
      <>
        At most <b>{pct(t.paceBps, 0)}</b> of vault value moves at once, from an allowance that refills by that much every <b>{duration(t.epochLength)}</b>: no more than twice that within any one{" "}
        {duration(t.epochLength)}. The first epoch after adoption is free, so the seed can be placed.
      </>,
    ],
    [
      "Guard",
      <>
        Nothing is reshaped, restored or deposited while spot is more than <b>{t.guardTicks.toLocaleString("en-US")} ticks</b> (about {up(t.guardTicks)}) from its <b>{duration(t.twapWindow)}</b> average.
      </>,
    ],
    [
      "Anchor",
      <>
        No bid above the Anchor plus the guard. The Anchor drops with the price at once and climbs at most <b>{up(t.supportBandTicks)}</b> per <b>{duration(t.epochLength)}</b>.
      </>,
    ],
    [
      "Lock",
      <>
        Issuer principal locked <b>{duration(t.lockDuration)}</b> from launch, then released evenly over <b>{duration(t.vestDuration)}</b>.
      </>,
    ],
    [
      "Curator",
      <>
        Replacing the curator takes <b>{duration(t.curatorTimelock)}</b>. The curator earns <b>{pct(t.curatorFeeBps, 0)}</b> of swap fees and owns nothing else.
      </>,
    ],
    [
      "Restore",
      <>
        Anyone may put support back when it lapses, for a bounty of up to <b>{Number(formatEther(t.bounty))} {quote}</b>, and never more than {pct(BOUNTY_MAX_BPS, 0)} of the {quote} the restore moves.
      </>,
    ],
  ];
  return (
    <div className="rounded-lg border border-line-strong bg-raised">
      <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
        <div>
          <div className="eyebrow">
            The covenant · {symbol}/{quote}
          </div>
          <div className="display mt-0.5 text-[26px] leading-tight text-ink">Terms of the lock</div>
        </div>
        <Seal className="h-9 w-9 shrink-0 text-accent" />
      </div>
      <dl className="px-5">
        {rows.slice(0, compact ? 4 : rows.length).map(([k, v]) => (
          <div key={k} className="grid grid-cols-[104px_1fr] gap-3 border-b border-line py-3 last:border-b-0">
            <dt className="eyebrow pt-0.5">{k}</dt>
            <dd className="text-[13.5px] leading-snug text-muted [&_b]:font-medium [&_b]:text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="border-t border-line px-5 py-3 text-xs text-faint">Fixed when the vault is created, before the auction opens. Nobody can amend it, including the issuer.</div>
    </div>
  );
}
