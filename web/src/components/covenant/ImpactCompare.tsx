"use client";

import { Slider } from "@/components/ui";
import { num } from "@/lib/format";

const impact = (ticks: number) => 1 - Math.exp(-ticks * Math.log(1.0001));

/** The same sell order against the launcher's full-range position and against the Covenant layout, as measured. */
export function ImpactCompare({
  fullTicks,
  managedTicks,
  size,
  symbol = "tokens",
  slider,
}: {
  fullTicks: number;
  managedTicks: number;
  size: number;
  symbol?: string;
  slider?: { value: number; min: number; max: number; onChange: (v: number) => void };
}) {
  const max = Math.max(fullTicks, managedTicks, 1);
  const ratio = managedTicks > 0 ? fullTicks / managedTicks : Infinity;
  const Bar = ({ label, sub, ticks, tone }: { label: string; sub: string; ticks: number; tone: "muted" | "support" }) => (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <span className="text-sm font-medium text-ink">{label}</span>
          <span className="ml-2 text-[13px] text-faint">{sub}</span>
        </div>
        <div className="num text-right text-sm text-ink">
          −{num(impact(ticks) * 100, 1)}% <span className="text-faint">· {Math.round(ticks)} ticks</span>
        </div>
      </div>
      <div className="mt-2 h-2.5 w-full rounded-sm bg-line">
        <div className={`h-full rounded-sm transition-[width] duration-500 ease-out ${tone === "support" ? "bg-support" : "bg-muted"}`} style={{ width: `${(ticks / max) * 100}%` }} />
      </div>
    </div>
  );
  return (
    <div className="grid gap-8 md:grid-cols-[1fr_220px] md:items-center">
      <div className="space-y-6">
        <Bar label="Full-range position" sub="how launches seed today" ticks={fullTicks} tone="muted" />
        <Bar label="Covenant layout" sub="same assets, same price" ticks={managedTicks} tone="support" />
        {slider && <Slider label="Sell order" value={slider.value} min={slider.min} max={slider.max} onChange={slider.onChange} display={`${slider.value} ${symbol}`} />}
      </div>
      <div className="border-t border-line pt-6 md:border-l md:border-t-0 md:pl-8 md:pt-0">
        <div className="display text-[64px] leading-none text-ink">{Number.isFinite(ratio) ? num(ratio, 1) : "∞"}×</div>
        <div className="mt-2 text-sm text-muted">less price impact from the same {size}-token sell, with not one extra unit of liquidity.</div>
      </div>
    </div>
  );
}
