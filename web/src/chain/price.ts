// Display maths for concentrated liquidity, in floating point. Contract code is the authority for every rule; these
// helpers only place things on a chart and format amounts.
//
// Price ticks rise with the launched token's price in the quote (see src/libraries/Orient.sol). When the quote is
// currency0 the price tick is the negated pool tick; when it is currency1 they are equal.

export const LN_BASE = Math.log(1.0001);
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
const TWO_96 = 2 ** 96;

export const sqrtAtTick = (tick: number) => Math.exp((tick * LN_BASE) / 2);
/** The exact (fractional) pool tick of a sqrt price. */
export const tickAtSqrt = (sqrtP: number) => (2 * Math.log(sqrtP)) / LN_BASE;
export const sqrtX96ToFloat = (sqrtPriceX96: bigint) => Number(sqrtPriceX96) / TWO_96;

// ---------------------------------------------------------------------------------------------------- orientation

export const toPrice = (quoteIs0: boolean, poolTick: number) => (quoteIs0 ? -poolTick : poolTick);
export const toPool = (quoteIs0: boolean, priceTick: number) => (quoteIs0 ? -priceTick : priceTick);
export const rangeToPrice = (quoteIs0: boolean, tickLower: number, tickUpper: number): [number, number] =>
  quoteIs0 ? [-tickUpper, -tickLower] : [tickLower, tickUpper];
export const rangeToPool = (quoteIs0: boolean, priceLower: number, priceUpper: number): [number, number] =>
  quoteIs0 ? [-priceUpper, -priceLower] : [priceLower, priceUpper];
export const split = (quoteIs0: boolean, a0: number, a1: number) => (quoteIs0 ? { quote: a0, token: a1 } : { quote: a1, token: a0 });

/** Largest multiple of `spacing` at or below `tick` (Orient.floorTo). */
export const floorTo = (tick: number, spacing: number) => Math.floor(tick / spacing) * spacing;
/** Smallest multiple of `spacing` at or above `tick` (Orient.ceilTo). */
export const ceilTo = (tick: number, spacing: number) => Math.ceil(tick / spacing) * spacing;

// ---------------------------------------------------------------------------------------------------- prices

/** Quote per token at a price tick. `decimalsShift` = token decimals − quote decimals. */
export const priceAt = (priceTick: number, decimalsShift = 0) => Math.exp(priceTick * LN_BASE) * 10 ** decimalsShift;
/** The price tick of a quote-per-token price. */
export const priceTickOf = (price: number, decimalsShift = 0) => Math.log(price / 10 ** decimalsShift) / LN_BASE;
/** A tick distance as a percentage move, e.g. 1500 ticks → 16.2%. */
export const ticksToPct = (ticks: number) => (Math.exp(ticks * LN_BASE) - 1) * 100;

// ---------------------------------------------------------------------------------------------------- amounts

/**
 * Currency amounts a pool-tick range holds at a sqrt price (RangeMath.amounts, without rounding). Units follow the
 * liquidity: pass liquidity / 1e18 to get whole tokens for 18-decimal currencies.
 */
export function amountsAt(sqrtP: number, tickLower: number, tickUpper: number, liquidity: number): { a0: number; a1: number } {
  const a = sqrtAtTick(tickLower);
  const b = sqrtAtTick(tickUpper);
  if (sqrtP <= a) return { a0: liquidity * (1 / a - 1 / b), a1: 0 };
  if (sqrtP < b) return { a0: liquidity * (1 / sqrtP - 1 / b), a1: liquidity * (sqrtP - a) };
  return { a0: 0, a1: liquidity * (b - a) };
}

/** Quote and token a price-tick range holds when the price sits at `spotPriceTick` (fractional allowed). */
export function holdingsAtPrice(quoteIs0: boolean, spotPriceTick: number, priceLower: number, priceUpper: number, liquidity: number) {
  const [lo, hi] = rangeToPool(quoteIs0, priceLower, priceUpper);
  const { a0, a1 } = amountsAt(sqrtAtTick(toPool(quoteIs0, spotPriceTick)), lo, hi, liquidity);
  return split(quoteIs0, a0, a1);
}

// ---------------------------------------------------------------------------------------------------- CCA prices

/** CCA prices are quote per token in Q96. */
export const q96ToNumber = (q96: bigint) => Number(q96) / TWO_96;

/** Snap a quote-per-token price to the auction's tick grid (floor + k·spacing, k ≥ 0). */
export function snapToAuctionTick(price: number, floorQ96: bigint, spacingQ96: bigint): bigint {
  const steps = Math.max(0, Math.round((price * TWO_96 - Number(floorQ96)) / Number(spacingQ96)));
  return floorQ96 + BigInt(steps) * spacingQ96;
}

/** Uniswap v4's sqrt price bounds, in Q96. A swap's price limit must lie strictly between them. */
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

/** sqrt(1.0001^tick) in Q96, approximately: good enough for a swap's price limit, clamped to v4's bounds. */
export function sqrtPriceLimitAt(poolTick: number): bigint {
  const raw = BigInt(Math.floor(sqrtAtTick(poolTick) * 2 ** 96));
  return raw <= MIN_SQRT_PRICE ? MIN_SQRT_PRICE + 1n : raw >= MAX_SQRT_PRICE ? MAX_SQRT_PRICE - 1n : raw;
}
