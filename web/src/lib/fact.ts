// A displayed figure, marked with what it is and the exact value it shows, so `npm run audit:ui` can check it against
// the chain. Spread onto the element that shows the figure:
//   <span {...fact("vault.supportBps", view.support.have, view.block)}>{pct(view.support.have)}</span>
// `raw` is the machine value the text was formatted from (a bigint, a number, an address, a boolean), never the text.

export type FactAttrs = { "data-fact": string; "data-raw": string; "data-block"?: string };

export function fact(key: string, raw: bigint | number | string | boolean | null | undefined, block?: bigint | number | null): FactAttrs {
  return {
    "data-fact": key,
    "data-raw": raw === null || raw === undefined ? "" : String(raw),
    ...(block === null || block === undefined ? {} : { "data-block": String(block) }),
  };
}
