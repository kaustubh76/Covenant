import { describe, expect, it } from "vitest";
import type { NetworkKey } from "@/chain/network";
import { offeredDevNetwork } from "./chain";

const list = (...n: [NetworkKey, "ready" | "offline"][]) => ({ networks: n.map(([key, state]) => ({ key, name: key, state })) });

describe("offeredDevNetwork: where the guided demo and the attack lab can run for real", () => {
  it("prefers a dev chain that is up: the local one, else the Playground", () => {
    expect(offeredDevNetwork(list(["local", "ready"], ["playground", "ready"]))).toBe("local");
    expect(offeredDevNetwork(list(["local", "offline"], ["base-sepolia", "ready"], ["playground", "ready"]))).toBe("playground");
  });
  it("points at an offline local chain only when nothing is up, and at nothing on a copy that offers neither", () => {
    expect(offeredDevNetwork(list(["local", "offline"], ["base-sepolia", "ready"]))).toBe("local");
    expect(offeredDevNetwork(list(["base-sepolia", "ready"], ["playground", "offline"]))).toBeNull();
  });
});
