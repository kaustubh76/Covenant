"use client";

import { motion } from "framer-motion";
import { useMemo, useRef, useState } from "react";
import { holdingsAtPrice, priceAt } from "@/chain/price";
import type { VaultView } from "@/chain/view";
import { amt, price } from "@/lib/format";
import { useWidth } from "@/lib/useSize";

/** What the chart needs from a vault: its ranges in price ticks and the prices the rules are measured against. */
export type ShapeSource = Pick<VaultView, "spot" | "twap" | "band" | "anchor" | "ceiling" | "quoteIs0" | "tickSpacing" | "tokenSymbol" | "quoteSymbol"> & {
  ranges: { priceLower: number; priceUpper: number; L: number }[];
  terms: { guardTicks: number };
};

export interface Handle {
  id: string;
  /** Price ticks. */
  lower: number;
  upper: number;
  asset: "quote" | "token";
}

interface Seg {
  from: number;
  to: number;
  L: number;
  side: "support" | "ask";
}

const isWide = (r: { priceLower: number; priceUpper: number }) => r.priceUpper - r.priceLower > 100_000;

function profile(ranges: ShapeSource["ranges"], lo: number, hi: number, spot: number): Seg[] {
  const pts = new Set<number>([lo, hi]);
  if (spot > lo && spot < hi) pts.add(spot);
  for (const r of ranges) for (const e of [r.priceLower, r.priceUpper]) if (e > lo && e < hi) pts.add(e);
  const xs = [...pts].sort((a, b) => a - b);
  const out: Seg[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const mid = (xs[i] + xs[i + 1]) / 2;
    const L = ranges.reduce((s, r) => (r.priceLower <= mid && mid < r.priceUpper ? s + r.L : s), 0);
    out.push({ from: xs[i], to: xs[i + 1], L, side: mid < spot ? "support" : "ask" });
  }
  return out;
}

/** A price-tick window that fits every narrow range, the band and both prices of the given layouts. */
export function chartDomain(sources: ShapeSource[], extra: { lower: number; upper: number }[] = []): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of sources) {
    lo = Math.min(lo, s.spot - 600, s.twap - 600, s.band[0] - 300);
    hi = Math.max(hi, s.spot + 600, s.twap + 600);
    for (const r of s.ranges) {
      if (isWide(r)) continue;
      lo = Math.min(lo, r.priceLower);
      hi = Math.max(hi, r.priceUpper);
    }
  }
  for (const r of extra) {
    if (r.upper - r.lower > 100_000) continue;
    lo = Math.min(lo, r.lower);
    hi = Math.max(hi, r.upper);
  }
  const anyNarrow = sources.some((s) => s.ranges.some((r) => !isWide(r))) || extra.length > 0;
  if (!anyNarrow) {
    lo -= 3600;
    hi += 2400;
  }
  const pad = Math.max(240, (hi - lo) * 0.05);
  return [Math.floor(lo - pad), Math.ceil(hi + pad)];
}

/**
 * The liquidity shape on a price axis. Price (quote per token) rises to the right, so the vault's quote, which buys
 * the token as it falls, sits on the left and token asks on the right.
 */
export function ShapeChart({
  world,
  ghost,
  height = 320,
  domain,
  handles,
  onHandle,
  onHandleEnd,
  maxBidUpper,
  minAskLower,
  caption,
  showAnchor = true,
}: {
  world: ShapeSource;
  /** Draw this layout as an outline behind the main shape (e.g. the layout before a change). */
  ghost?: ShapeSource;
  height?: number;
  domain?: [number, number];
  handles?: Handle[];
  onHandle?: (id: string, lower: number, upper: number) => void;
  onHandleEnd?: () => void;
  /** Bids must stay at or below this price tick. */
  maxBidUpper?: number;
  /** Asks must stay at or above this price tick. */
  minAskLower?: number;
  caption?: string;
  showAnchor?: boolean;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const drag = useRef<{ id: string; mode: "l" | "r" | "m"; startX: number; lower: number; upper: number } | null>(null);

  const H = height;
  const padL = 12;
  const padR = 12;
  const padT = 34;
  const handleBand = handles?.length ? 14 + handles.length * 16 : 0;
  const padB = 30 + handleBand;
  const iw = W - padL - padR;
  const ih = H - padT - padB;

  const [lo, hi] = useMemo(() => domain ?? chartDomain(ghost ? [world, ghost] : [world]), [domain, world, ghost]);
  const x = (p: number) => padL + ((p - lo) / (hi - lo)) * iw;
  const priceAtX = (px: number) => lo + ((px - padL) / iw) * (hi - lo);

  const { spot, twap, band, anchor, ceiling } = world;
  const guard = world.terms.guardTicks;
  const segs = useMemo(() => profile(world.ranges, lo, hi, spot), [world, lo, hi, spot]);
  const ghostSegs = useMemo(() => (ghost ? profile(ghost.ranges, lo, hi, ghost.spot) : []), [ghost, lo, hi]);
  // A lone full-range position has no shape to compare against, so draw it low: spread thin, as it is.
  const onlyWide = world.ranges.every(isWide) && (!ghost || ghost.ranges.every(isWide));
  const maxL = Math.max(1e-12, ...segs.map((s) => s.L), ...ghostSegs.map((s) => s.L)) / (onlyWide ? 0.12 : 1);
  const y = (L: number) => padT + ih - Math.max(L > 0 ? 2 : 0, (L / maxL) * ih);
  const base = padT + ih;

  const step = [300, 600, 1200, 1500, 3000, 6000, 12000].find((s) => (hi - lo) / s <= (W < 520 ? 4 : 8)) ?? 12000;
  const axis: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) axis.push(t);

  const ghostPath = ghostSegs.length
    ? ghostSegs.map((s, i) => `${i === 0 ? "M" : "L"}${x(s.from).toFixed(1)},${y(s.L).toFixed(1)} L${x(s.to).toFixed(1)},${y(s.L).toFixed(1)}`).join(" ")
    : "";

  const xSpot = x(spot);
  const xTwap = x(twap);
  const merged = Math.abs(xSpot - xTwap) < 74;
  const inView = (p: number) => p > lo && p < hi;
  const hovered = hover !== null ? segs.find((s) => hover >= s.from && hover < s.to) : undefined;
  const hoveredAmt = hovered ? holdingsAtPrice(world.quoteIs0, spot, hovered.from, hovered.to, hovered.L) : null;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const d = drag.current;
    if (d && onHandle) {
      const sp = world.tickSpacing;
      const dt = Math.round((((px - d.startX) / iw) * (hi - lo)) / sp) * sp;
      let lower = d.lower;
      let upper = d.upper;
      // screen-left is the lower price, so the left grip moves `lower`
      if (d.mode === "m") {
        lower += dt;
        upper += dt;
      } else if (d.mode === "l") lower = Math.min(upper - sp, lower + dt);
      else upper = Math.max(lower + sp, upper + dt);
      const h = handles!.find((k) => k.id === d.id)!;
      if (h.asset === "quote" && maxBidUpper !== undefined && upper > maxBidUpper) {
        if (d.mode === "m") lower -= upper - maxBidUpper;
        upper = maxBidUpper;
      }
      if (h.asset === "token" && minAskLower !== undefined && lower < minAskLower) {
        if (d.mode === "m") upper += minAskLower - lower;
        lower = minAskLower;
      }
      if (upper > lower) onHandle(d.id, lower, upper);
      return;
    }
    setHover(px >= padL && px <= W - padR ? priceAtX(px) : null);
  };

  const grab = (e: React.PointerEvent, h: Handle, mode: "l" | "r" | "m") => {
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    const rect = svgRef.current!.getBoundingClientRect();
    drag.current = { id: h.id, mode, startX: e.clientX - rect.left, lower: h.lower, upper: h.upper };
    setHover(null);
  };

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height: H }}>
      <svg
        ref={svgRef}
        width={W}
        height={H}
        role="img"
        aria-label={caption ?? "Liquidity shape: quote support below the price, token asks above it"}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onPointerUp={() => {
          if (drag.current) onHandleEnd?.();
          drag.current = null;
        }}
        className="absolute left-0 top-0 block touch-none"
      >
        {/* support band */}
        <rect x={x(band[0])} y={padT} width={Math.max(0, x(band[1]) - x(band[0]))} height={ih} fill="var(--accent)" opacity={0.07} />
        <line x1={x(band[0])} x2={x(band[0])} y1={padT} y2={base} stroke="var(--accent)" strokeOpacity={0.45} strokeDasharray="2 4" />
        <text
          x={x(band[0]) < W - 118 ? x(band[0]) + 7 : x(band[0]) - 6}
          y={padT + 13}
          textAnchor={x(band[0]) < W - 118 ? "start" : "end"}
          fontSize={10.5}
          letterSpacing="0.12em"
          fill="var(--accent)"
          opacity={0.9}
        >
          SUPPORT BAND
        </text>

        {/* gridlines */}
        {axis.map((t) => (
          <line key={t} x1={x(t)} x2={x(t)} y1={base} y2={base + 4} stroke="var(--line-strong)" />
        ))}

        {/* ghost layout */}
        {ghostPath && <path d={ghostPath} fill="none" stroke="var(--faint)" strokeWidth={1} strokeDasharray="3 3" />}

        {/* liquidity */}
        {segs.map((s) => {
          const x0 = x(s.from);
          const w = Math.max(0, x(s.to) - x0);
          const top = y(s.L);
          const fill = s.side === "support" ? "var(--support)" : "var(--ask)";
          return (
            <g key={`${s.from}:${s.to}`}>
              <motion.rect x={x0} width={w} initial={false} animate={{ y: top, height: base - top }} transition={{ duration: 0.45, ease: [0.2, 0.7, 0.2, 1] }} fill={fill} opacity={0.22} />
              <motion.rect x={x0} width={w} height={1.5} initial={false} animate={{ y: top }} transition={{ duration: 0.45, ease: [0.2, 0.7, 0.2, 1] }} fill={fill} opacity={s.L > 0 ? 1 : 0} />
            </g>
          );
        })}
        <line x1={padL} x2={W - padR} y1={base} y2={base} stroke="var(--line-strong)" />

        {/* guard corridor */}
        <rect x={x(twap - guard)} y={base - 3} width={Math.max(0, x(twap + guard) - x(twap - guard))} height={3} fill="var(--ink)" opacity={0.5} />

        {/* anchor and the bid ceiling it sets */}
        {showAnchor && inView(anchor) && Math.abs(x(anchor) - xTwap) > 2 && (
          <g>
            <line x1={x(anchor)} x2={x(anchor)} y1={padT + 22} y2={base} stroke="var(--warn)" strokeOpacity={0.7} strokeDasharray="1 3" />
            <text x={x(anchor) - 5} y={base - 26} fontSize={10} textAnchor="end" fill="var(--warn)" opacity={0.9} letterSpacing="0.08em">
              ANCHOR
            </text>
          </g>
        )}
        {showAnchor && inView(ceiling) && (
          <g>
            <line x1={x(ceiling)} x2={x(ceiling)} y1={base - 10} y2={base} stroke="var(--warn)" strokeWidth={1.5} />
            <text x={x(ceiling) + 4} y={base - 12} fontSize={9.5} fill="var(--warn)" opacity={0.85}>
              bid ceiling
            </text>
          </g>
        )}

        {/* TWAP and spot */}
        <line x1={xTwap} x2={xTwap} y1={padT - 4} y2={base} stroke="var(--accent)" strokeDasharray="4 3" />
        <line x1={xSpot} x2={xSpot} y1={padT - 4} y2={base} stroke="var(--ink)" />
        {merged ? (
          <text x={Math.min(W - 150, Math.max(4, xSpot + 6))} y={padT - 14} fontSize={11} fill="var(--ink)" className="num">
            Spot {price(priceAt(spot))} · TWAP {price(priceAt(twap))}
          </text>
        ) : (
          <>
            <text x={xSpot + (xSpot > xTwap ? 6 : -6)} y={padT - 14} fontSize={11} fill="var(--ink)" textAnchor={xSpot > xTwap ? "start" : "end"} className="num">
              Spot {price(priceAt(spot))}
            </text>
            <text x={xTwap + (xSpot > xTwap ? -6 : 6)} y={padT - 14} fontSize={11} fill="var(--accent)" textAnchor={xSpot > xTwap ? "end" : "start"} className="num">
              TWAP {price(priceAt(twap))}
            </text>
          </>
        )}

        {/* axis */}
        {axis.map((t) => (
          <text key={t} x={x(t)} y={base + 18} fontSize={10.5} fill="var(--faint)" textAnchor="middle" className="num">
            {priceAt(t).toFixed(3)}
          </text>
        ))}

        {/* hover */}
        {hover !== null && !drag.current && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={base} stroke="var(--muted)" strokeOpacity={0.5} />}

        {/* draggable draft ranges */}
        {handles?.map((h, i) => {
          const yy = base + 30 + i * 16;
          const xl = x(h.lower);
          const xr = x(h.upper);
          const color = h.asset === "quote" ? "var(--support)" : "var(--ask)";
          return (
            <g key={h.id}>
              <rect x={xl} y={yy - 3} width={Math.max(2, xr - xl)} height={6} rx={3} fill={color} opacity={0.55} style={{ cursor: "grab" }} onPointerDown={(e) => grab(e, h, "m")} />
              <rect x={xl - 8} y={yy - 9} width={16} height={18} fill="transparent" style={{ cursor: "ew-resize" }} onPointerDown={(e) => grab(e, h, "l")} />
              <rect x={xr - 8} y={yy - 9} width={16} height={18} fill="transparent" style={{ cursor: "ew-resize" }} onPointerDown={(e) => grab(e, h, "r")} />
              <circle cx={xl} cy={yy} r={4.5} fill="var(--bg)" stroke={color} strokeWidth={1.5} pointerEvents="none" />
              <circle cx={xr} cy={yy} r={4.5} fill="var(--bg)" stroke={color} strokeWidth={1.5} pointerEvents="none" />
            </g>
          );
        })}
      </svg>

      {hover !== null && hovered && !drag.current && (
        <div
          className="pointer-events-none absolute top-10 z-10 w-[190px] rounded-md border border-line-strong bg-raised px-3 py-2 text-xs shadow-lg"
          style={{ left: Math.min(W - 198, Math.max(4, x(hover) + 10)) }}
        >
          <div className="num text-ink">
            {price(priceAt(hover))} {world.quoteSymbol}
          </div>
          <div className="mt-0.5 text-muted">
            {hovered.L > 0 && hoveredAmt ? (
              hovered.side === "support" ? (
                <>
                  <span className="num text-support">
                    {amt(hoveredAmt.quote)} {world.quoteSymbol}
                  </span>{" "}
                  bidding from {priceAt(hovered.to).toFixed(3)} down to {priceAt(hovered.from).toFixed(3)}
                </>
              ) : (
                <>
                  <span className="num text-ask">
                    {amt(hoveredAmt.token)} {world.tokenSymbol}
                  </span>{" "}
                  offered from {priceAt(hovered.from).toFixed(3)} to {priceAt(hovered.to).toFixed(3)}
                </>
              )
            ) : (
              "No liquidity here"
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ShapeLegend({ ghost, anchor = true }: { ghost?: string; anchor?: boolean }) {
  const Item = ({ swatch, children }: { swatch: React.ReactNode; children: React.ReactNode }) => (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted">
      {swatch}
      {children}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <Item swatch={<span className="h-2.5 w-2.5 rounded-[2px] bg-support/40 ring-1 ring-support" />}>Quote support</Item>
      <Item swatch={<span className="h-2.5 w-2.5 rounded-[2px] bg-ask/40 ring-1 ring-ask" />}>Token asks</Item>
      <Item swatch={<span className="h-2.5 w-2.5 rounded-[2px] bg-accent/20 ring-1 ring-accent/50" />}>Support band</Item>
      <Item swatch={<span className="h-3 w-px bg-ink" />}>Spot</Item>
      <Item swatch={<span className="h-3 w-0 border-l border-dashed border-accent" />}>TWAP</Item>
      {anchor && <Item swatch={<span className="h-3 w-0 border-l border-dotted border-warn" />}>Anchor</Item>}
      {ghost && <Item swatch={<span className="h-0 w-3 border-t border-dashed border-faint" />}>{ghost}</Item>}
    </div>
  );
}
