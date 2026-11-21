// What the store says when reads fail: the numbers on screen keep the block they were read at, and nothing is shown
// as read that was not.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

const readVaultView = vi.fn();
const readActivity = vi.fn();
const discoverLaunches = vi.fn();
vi.mock("@/chain/view", async (orig) => ({ ...(await orig<typeof import("@/chain/view")>()), readVaultView: (...a: unknown[]) => readVaultView(...a) }));
vi.mock("@/chain/history", async (orig) => ({ ...(await orig<typeof import("@/chain/history")>()), readActivity: (...a: unknown[]) => readActivity(...a) }));
vi.mock("@/chain/discover", async (orig) => ({ ...(await orig<typeof import("@/chain/discover")>()), discoverLaunches: (...a: unknown[]) => discoverLaunches(...a) }));

const { useChain } = await import("./chain");

const VAULT = "0x2d887961773d3793cF5950f6a9Bec4F4BF79582d" as Address;
const net = { key: "base-sepolia", name: "Base Sepolia", chainId: 84532, caps: { devChain: false }, runtime: null } as never;
const ctx = { net } as never;
const viewAt = (block: bigint) => ({ address: VAULT, block }) as never;

describe("the store when reads fail", () => {
  beforeEach(() => {
    readVaultView.mockReset();
    readActivity.mockReset().mockResolvedValue({ beats: [], seen: null });
    discoverLaunches.mockReset().mockResolvedValue([]);
    useChain.setState({ net, ctx, vault: VAULT, view: null, status: "ready", staleSince: null, readError: null, history: [], historyState: "loading", launchesFrom: "chain" });
  });

  it("keeps the last view, marks it stale from its own block, and clears the mark on the next good read", async () => {
    readVaultView.mockResolvedValueOnce(viewAt(100n));
    await useChain.getState().refresh();
    expect(useChain.getState().staleSince).toBeNull();

    readVaultView.mockRejectedValueOnce(new Error("The network did not answer"));
    await useChain.getState().refresh();
    readVaultView.mockRejectedValueOnce(new Error("Still nothing"));
    await useChain.getState().refresh();
    const s = useChain.getState();
    expect(s.view?.block).toBe(100n);
    expect(s.staleSince).toBe(100); // from the first failure on, not the latest
    expect(s.readError).toBe("Still nothing");

    readVaultView.mockResolvedValueOnce(viewAt(103n));
    await useChain.getState().refresh();
    expect(useChain.getState().staleSince).toBeNull();
    expect(useChain.getState().readError).toBeNull();
  });

  it("says the activity feed was not read, rather than that nothing happened", async () => {
    readVaultView.mockResolvedValue(viewAt(100n));
    readActivity.mockRejectedValueOnce(new Error("logs: no answer"));
    await useChain.getState().refresh();
    expect(useChain.getState().historyState).toBe("failed");
    readActivity.mockResolvedValueOnce({ beats: [], seen: null });
    await useChain.getState().refresh();
    expect(useChain.getState().historyState).toBe("read");
  });

  it("says where the vault list came from: the chain's own logs, not the record, once discovery answers", async () => {
    useChain.setState({ launchesFrom: "record" });
    readVaultView.mockResolvedValue(viewAt(100n));
    await useChain.getState().refresh();
    expect(useChain.getState().launchesFrom).toBe("chain");
  });
});
