import { describe, expect, it } from "vitest";
import { layoutKey } from "./layout";

const range = (tickLower: number, tickUpper: number, liquidity: bigint) => ({ tickLower, tickUpper, liquidity }) as never;
const vault = (address: string, ranges: never[]) => ({ address, ranges }) as never;

describe("layoutKey", () => {
  const a = vault("0xA999c514FB4B9063Ef047CF39EdCb37098f84AFc", [range(-600, 600, 10n), range(600, 1200, 5n)]);

  it("does not change when only the block or the price does", () => {
    const later = { ...(a as object), block: 99, spot: 123, twap: 456 } as never;
    expect(layoutKey(later)).toBe(layoutKey(a));
  });

  it("changes when a range's liquidity or bounds change, or another vault is picked", () => {
    expect(layoutKey(vault("0xa999c514fb4b9063ef047cf39edcb37098f84afc", [range(-600, 600, 11n), range(600, 1200, 5n)]))).not.toBe(layoutKey(a));
    expect(layoutKey(vault("0xa999c514fb4b9063ef047cf39edcb37098f84afc", [range(-660, 600, 10n), range(600, 1200, 5n)]))).not.toBe(layoutKey(a));
    expect(layoutKey(vault("0x0000000000000000000000000000000000000001", [range(-600, 600, 10n), range(600, 1200, 5n)]))).not.toBe(layoutKey(a));
  });
});
