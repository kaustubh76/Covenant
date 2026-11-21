import { priceAt } from "@/chain/price";

const nf = (min: number, max: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });

export const num = (v: number, dp = 2) => nf(dp, dp).format(Math.abs(v) < 5 * 10 ** -(dp + 1) ? 0 : v);
/** An amount: whole numbers from 1,000, two decimals from 1, four below. One too small for four decimals says so, never "0". */
export const amt = (v: number) =>
  Math.abs(v) >= 1000 ? nf(0, 0).format(v) : Math.abs(v) >= 1 ? nf(2, 2).format(v) : v !== 0 && Math.abs(v) < 0.00005 ? (v < 0 ? "> −0.0001" : "< 0.0001") : nf(0, 4).format(v);
export const pct = (bps: number, dp = 1) => `${nf(dp, dp).format(bps / 100)}%`;
/** Quote per token: four decimals from 1 up, four significant digits below (a testnet launch trades near 0.0002). */
export const price = (ethPerToken: number) =>
  Math.abs(ethPerToken) >= 1 || ethPerToken === 0 ? nf(4, 4).format(ethPerToken) : ethPerToken.toPrecision(4);
/** A chart's axis label: three decimals from 1 up, three significant digits below. */
export const axisPrice = (ethPerToken: number) => (Math.abs(ethPerToken) >= 1 || ethPerToken === 0 ? ethPerToken.toFixed(3) : ethPerToken.toPrecision(3));
/** Quote per token at a price tick. */
export const tickPrice = (priceTick: number) => price(priceAt(priceTick));
export const signedPct = (ratio: number, dp = 1) => `${ratio >= 0 ? "+" : "−"}${nf(dp, dp).format(Math.abs(ratio) * 100)}%`;
export const ticksAsPct = (ticks: number) => `${nf(0, 1).format((Math.exp(ticks * Math.log(1.0001)) - 1) * 100)}%`;

export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d >= 2) return h ? `${d}d ${h}h` : `${d}d`;
  if (d === 1) return h ? `1d ${h}h` : "1d";
  if (h >= 1) return m ? `${h}h ${m}m` : `${h}h`;
  if (m >= 1) return `${m}m`;
  return `${s}s`;
}

export const sinceGenesis = (now: number, genesis: number) => `T+${duration(now - genesis)}`;
