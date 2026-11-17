"use client";

import { useWidth } from "@/lib/useSize";
import { amt, axisPrice, price } from "@/lib/format";

export interface CurveBid {
  id: string;
  bidder: string;
  /** Quote per token. */
  maxPrice: number;
  amount: number;
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
  const byLevel = levels.map((p) => ({ price: p, amount: bids.filter((b) => b.maxPrice === p).reduce((s, b) => s + b.amount, 0), who: [...new Set(bids.filter((b) => b.maxPrice === p).map((b) => b.bidder))].join(", ") }));
  const pMin = Math.min(...levels, result?.floorPrice ?? 1) * 0.985;
  const pMax = Math.max(...levels, result?.clearingPrice ?? 1) * 1.03;
  const x = (p: number) => padL + ((p - pMin) / (pMax - pMin)) * iw;
  const maxA = Math.max(1, ...byLevel.map((l) => l.amount));
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
          const lost = cp !== undefined && l.price < cp;
          const color = cp === undefined ? "var(--muted)" : lost ? "var(--support)" : "var(--ink)";
          return (
            <g key={l.price}>
              <rect x={x(l.price) - bw / 2} y={base - h} width={bw} height={h} fill={color} opacity={lost ? 0.28 : 0.16} />
              <rect x={x(l.price) - bw / 2} y={base - h} width={bw} height={1.5} fill={color} />
              <text x={x(l.price)} y={base - h - 7} textAnchor="middle" fontSize={11} fill="var(--ink)" className="num">
                {Number.isInteger(l.amount) ? l.amount : amt(l.amount)} ETH
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
