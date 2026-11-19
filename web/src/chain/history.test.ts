import { type Address, type Hex, type Log, encodeAbiParameters, encodeEventTopics, getAddress, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { covenantVaultAbi } from "./abi.generated";
import { feedAmount, seenIn } from "./history";

describe("feedAmount", () => {
  it("writes a testnet fee out in full, with three significant figures", () => {
    expect(feedAmount(2.45454545454e-7)).toBe("0.000000245");
    expect(feedAmount(2.454545454545e-6)).toBe("0.00000245");
    expect(feedAmount(0.000969)).toBe("0.000969");
    expect(feedAmount(0.0149281)).toBe("0.0149");
  });

  it("writes zero as 0, and larger amounts as before", () => {
    expect(feedAmount(0)).toBe("0");
    expect(feedAmount(9.6574)).toBe("9.66");
    expect(feedAmount(41.9123)).toBe("41.91");
    expect(feedAmount(129.42)).toBe("129");
  });
});

describe("seenIn: who a vault's logs name", () => {
  const VAULT = "0x0000000000000000000000000000000000000b01" as Address;
  const [A, B, C, D1, D2] = ["a1", "b2", "c3", "d4", "e5"].map((x) => `0x${x.repeat(20)}` as Address);
  const at = (block: number, index: number, topics: Hex[], data: Hex = "0x", address: Address = VAULT) =>
    ({ address, topics, data, blockNumber: BigInt(block), logIndex: index }) as unknown as Log;
  const changed = (block: number, previous: Address, current: Address, address?: Address) =>
    at(block, 0, encodeEventTopics({ abi: covenantVaultAbi, eventName: "CuratorChanged", args: { previous, current } }) as Hex[], "0x", address);
  const deposited = (block: number, owner: Address) =>
    at(
      block,
      1,
      encodeEventTopics({ abi: covenantVaultAbi, eventName: "Deposited", args: { owner } }) as Hex[],
      encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [10n, 1n, 2n]),
    );

  it("lists every curator a change named and every depositor, newest first and each once", () => {
    // given out of order, as kept spans and the recent window arrive
    const logs = [changed(9, B, C), deposited(8, D1), deposited(3, D1), changed(5, A, B), deposited(7, D2)];
    const seen = seenIn(logs, VAULT);
    expect(seen.vault).toBe(VAULT);
    expect(seen.curators).toEqual([C, B, A].map((a) => getAddress(a)));
    expect(seen.depositors).toEqual([D1, D2].map((a) => getAddress(a)));
  });

  it("ignores other contracts' logs, the zero address and events it does not read", () => {
    const other = "0x0000000000000000000000000000000000000b02" as Address;
    const noise = at(4, 0, ["0x1234000000000000000000000000000000000000000000000000000000000000"]);
    const seen = seenIn([changed(2, A, B, other), changed(3, zeroAddress, A), noise], VAULT);
    expect(seen.curators).toEqual([getAddress(A)]);
    expect(seen.depositors).toEqual([]);
  });
});
