"use client";

import { formatEther } from "viem";
import { ticksToPct } from "@/chain/price";
import type { Terms } from "@/chain/terms";
import { Seal } from "@/components/shell/AppShell";
import { duration, pct } from "@/lib/format";

const tp = (ticks: number) => `${ticksToPct(ticks).toFixed(1)}%`;

/** The covenant as a bidder reads it: the vault's immutable terms, fixed before the auction opens. */
export function TermsCard({ terms: t, symbol = "TOKEN", quote = "ETH", compact }: { terms: Terms; symbol?: string; quote?: string; compact?: boolean }) {
  const rows: [string, React.ReactNode][] = [
    ["Conservation", <>A reshape puts back everything it lifts. There is no path for liquidity to leave the pool early.</>],
    [
      "Support",
      <>
        At least <b>{pct(t.supportBps, 0)}</b> of the vault&apos;s {quote} bids within <b>{tp(t.supportBandTicks)}</b> below the average price.
      </>,
    ],
    [
      "Pace",
      <>
        No more than <b>{pct(t.paceBps, 0)}</b> of vault value moves per <b>{duration(t.epochLength)}</b>.
      </>,
    ],
    [
      "Guard",
      <>
        Nothing is reshaped, restored or deposited while spot is more than <b>{tp(t.guardTicks)}</b> from its <b>{duration(t.twapWindow)}</b> average.
      </>,
    ],
    [
      "Anchor",
      <>
        No bid above the Anchor plus the guard. The Anchor drops with the price at once and climbs at most <b>{tp(t.supportBandTicks)}</b> per epoch.
      </>,
    ],
    [
      "Lock",
      <>
        Issuer principal locked <b>{Math.round(t.lockDuration / 86400)} days</b> from launch, then released evenly over <b>{Math.round(t.vestDuration / 86400)} days</b>.
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
        Anyone may put support back when it lapses, for a bounty of up to <b>{Number(formatEther(t.bounty))} {quote}</b>.
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
