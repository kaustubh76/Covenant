"use client";

import { useWidth } from "@/lib/useSize";
import { amt, axisPrice, price } from "@/lib/format";

export interface CurveBid {
  id: string;
  bidder: string;
  /** Quote per token. */
  maxPrice: number;
  amount: number;
  /** A draft not yet in the auction: drawn dashed, never as demand the auction holds. */
  pending?: boolean;
}

/** Bids by price. Outbid demand stays recorded in the CCA, and the Seed turns it into buy support. */
export function DemandCurve({ bids, result, height = 240 }: { bids: CurveBid[]; result: { clearingPrice: number; floorPrice: number } | null; height?: number }) {
  const [ref, W] = useWidth<HTMLDivElement>(640);
  const padL = 12;
  const padR = 12;
  const padT = 46;
  const padB = 30;
  const iw = W - padL - padR;
  const ih = height - padT - padB;
  const levels = [...new Map(bids.filter((b) => b.amount > 0).map((b) => [b.maxPrice, 0])).keys()].sort((a, b) => a - b);
  const at = (p: number, pending: boolean) => bids.filter((b) => b.maxPrice === p && !!b.pending === pending).reduce((s, b) => s + b.amount, 0);
  const byLevel = levels.map((p) => ({ price: p, placed: at(p, false), drafted: at(p, true), amount: at(p, false) + at(p, true), who: [...new Set(bids.filter((b) => b.maxPrice === p).map((b) => b.bidder))].join(", ") }));
  const anyDraft = byLevel.some((l) => l.drafted > 0);
  // The axes fit the bids (and the result, once there is one) at any scale: a testnet launch's prices and amounts are
  // thousands of times smaller than a local one's, and a fixed 1 at either end would squeeze every bar into a corner.
  const lo = Math.min(...levels, result?.floorPrice ?? Infinity);
  const hi = Math.max(...levels, result?.clearingPrice ?? -Infinity);
  const [pMin, pMax] = Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 ? (hi > lo ? [lo * 0.985, hi * 1.03] : [lo * 0.95, lo * 1.05]) : [0, 1];
  const x = (p: number) => padL + ((p - pMin) / (pMax - pMin)) * iw;
  const maxA = Math.max(Number.MIN_VALUE, ...byLevel.map((l) => l.amount));
  const base = padT + ih;
  const bw = Math.max(18, Math.min(44, iw / 12));
  const cp = result?.clearingPrice;

  return (
    <div ref={ref} className="w-full">
      <div className="relative" style={{ height }}>
      <svg className="absolute left-0 top-0" width={W} height={height} role="img" aria-label="Auction bids by price">
        <line x1={padL} x2={W - padR} y1={base} y2={base} stroke="var(--line-strong)" />
        {byLevel.map((l) => {
          const h = (l.amount / maxA) * ih;
          const hp = (l.placed / maxA) * ih;
          const lost = cp !== undefined && l.price < cp;
          const color = cp === undefined ? "var(--muted)" : lost ? "var(--support)" : "var(--ink)";
          const show = (a: number) => (Number.isInteger(a) ? a : amt(a));
          return (
            <g key={l.price}>
              {l.placed > 0 && <rect x={x(l.price) - bw / 2} y={base - hp} width={bw} height={hp} fill={color} opacity={lost ? 0.28 : 0.16} />}
              {l.placed > 0 && <rect x={x(l.price) - bw / 2} y={base - hp} width={bw} height={1.5} fill={color} />}
              {l.drafted > 0 && (
                <rect x={x(l.price) - bw / 2 + 0.75} y={base - h + 0.75} width={bw - 1.5} height={Math.max(0, h - hp - 1.5)} fill="none" stroke="var(--muted)" strokeDasharray="3 3" />
              )}
              <text x={x(l.price)} y={base - h - 7} textAnchor="middle" fontSize={11} fill="var(--ink)" className="num">
                {l.placed > 0 ? `${show(l.placed)} ETH` : ""}
                {l.drafted > 0 ? `${l.placed > 0 ? " + " : ""}${show(l.drafted)} draft` : ""}
              </text>
              <text x={x(l.price)} y={base + 17} textAnchor="middle" fontSize={10.5} fill="var(--faint)" className="num">
                {axisPrice(l.price)}
              </text>
            </g>
          );
        })}
        {cp !== undefined && (
          <>
            <line x1={x(cp)} x2={x(cp)} y1={12} y2={base} stroke="var(--accent)" strokeDasharray="4 3" />
            <text x={x(cp) - 6} y={14} textAnchor="end" fontSize={11} fill="var(--accent)" className="num">
              Clears at {price(cp)}
            </text>
          </>
        )}
      </svg>
      </div>
      {anyDraft && (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted">
          <span className="h-2.5 w-2.5 rounded-[2px] border border-dashed border-muted" />
          Drafts: not in the auction until placed
        </div>
      )}
      {result && (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[2px] bg-support/40 ring-1 ring-support" />
            Losing bids: demand that stays on-chain
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[2px] bg-ink/20 ring-1 ring-ink" />
            Winning bids
          </span>
        </div>
      )}
    </div>
  );
}
