// The app's public-chain code path, against Covenant deployed and launched on a fork of Base Sepolia (fork.setup.ts):
// what the browser does on Base Sepolia, with the launch's key standing in for the wallet. No Anvil controls are used.

import { readFileSync } from "node:fs";
import { type Hex, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { manifestPath, runtimePath } from "../scripts/lib/localchain";
import { covenantVaultAbi } from "../src/chain/abi.generated";
import { type ChainCtx, createChainCtx } from "../src/chain/client";
import { discoverLaunches } from "../src/chain/discover";
import { readHistory } from "../src/chain/history";
import { NEVER } from "../src/chain/launch";
import { swap } from "../src/chain/market";
import { type Runtime, networkOf, parseManifest } from "../src/chain/network";
import { moveEverything, softRug } from "../src/chain/plans";
import { preflight } from "../src/chain/preflight";
import { planRestore } from "../src/chain/scenarios/restore";
import { send } from "../src/chain/tx";
import { type VaultView, readVaultView } from "../src/chain/view";

const skip = inject("forkSkip");
const reshape = (v: VaultView, plan: { cuts: unknown[]; legs: unknown[] }) =>
  ({ address: v.address, abi: covenantVaultAbi, functionName: "reshape", args: [plan.cuts, plan.legs, NEVER] }) as never;

describe.skipIf(!!skip)("Base Sepolia, rehearsed on a fork, through the app's public-chain code path", () => {
  let ctx: ChainCtx;
  let v: VaultView;

  beforeAll(async () => {
    const records = inject("forkRecords");
    const manifest = parseManifest(JSON.parse(readFileSync(manifestPath(records), "utf8")));
    const runtime = JSON.parse(readFileSync(runtimePath(records), "utf8")) as Runtime;
    // What the browser builds for this network, with the launch's key standing in for the connected wallet.
    ctx = createChainCtx(networkOf("base-sepolia-fork", inject("forkRpcUrl"), manifest, runtime), { account: privateKeyToAccount(inject("forkKey") as Hex) });
    v = await readVaultView(ctx, runtime.defaultVault);
  });

  it("uses no local-chain powers: no Anvil controls, and one signer for every role", () => {
    expect(ctx.test).toBeNull();
    expect(ctx.net.caps.devChain).toBe(false);
    expect(ctx.address("curator")).toBe(ctx.signer);
    expect(ctx.address("keeper")).toBe(ctx.signer);
  });

  it("launched through Uniswap's live LBPStrategy and seeded support above the minimum", () => {
    expect(v.support.have).toBeGreaterThanOrEqual(v.support.need);
    expect(v.ranges.length).toBeGreaterThanOrEqual(5);
    expect(v.people.curator).toBe(ctx.signer);
    expect(v.people.issuer).toBe(ctx.signer);
  });

  it("refuses a soft rug with the contract's own error, and sends nothing, even when asked to force it", async () => {
    const pre = await preflight(ctx, v.people.curator, reshape(v, softRug(v)), v);
    expect(pre.ok).toBe(false);
    expect(pre.error?.name).toBe("SupportBroken");
    const o = await send(ctx, v.people.curator, reshape(v, softRug(v)), { force: true });
    expect(o.ok).toBe(false);
    expect(o.hash).toBeUndefined();
  });

  it("previews the curator's reshape for a visitor with no wallet, and declines to send it", async () => {
    const visitor = createChainCtx(ctx.net);
    const pre = await preflight(visitor, v.people.curator, reshape(v, moveEverything(v)), v);
    expect(pre.ok).toBe(true);
    expect(pre.after?.support.have).toBeGreaterThanOrEqual(v.support.need);
    const o = await send(visitor, v.people.curator, reshape(v, moveEverything(v)));
    expect(o.ok).toBe(false);
    expect(o.refused).toMatch(/Connect a wallet/);
  });

  it("settles the curator's honest reshape, signed by the wallet", async () => {
    const o = await send(ctx, v.people.curator, reshape(v, moveEverything(v)));
    expect(o.ok).toBe(true);
    expect(o.receipt?.status).toBe("success");
  });

  it("sells through Uniswap's PoolSwapTest on Base Sepolia, from tokens the wallet holds", async () => {
    const o = await swap(ctx, await readVaultView(ctx, v.address), "market", false, parseEther("1"));
    expect(o.ok).toBe(true);
    expect(o.hash).toBeDefined();
  });

  it("has nothing to restore while support holds", async () => {
    const p = await planRestore(ctx, await readVaultView(ctx, v.address), "keeper");
    expect(p?.pre.ok).toBe(false);
    expect(p?.pre.error?.name).toBe("NothingToRestore");
  });

  it("pokes and collects fees from the wallet", async () => {
    for (const functionName of ["poke", "collectFees"] as const) {
      const o = await send(ctx, "keeper", { address: v.address, abi: covenantVaultAbi, functionName, args: [] });
      expect(o.ok, functionName).toBe(true);
    }
  });

  it("finds the launch and its history within the RPC's 200-block log cap", async () => {
    const launches = await discoverLaunches(ctx);
    expect(launches.some((l) => l.vault.toLowerCase() === v.address.toLowerCase() && l.adopted)).toBe(true);
    const history = await readHistory(ctx, await readVaultView(ctx, v.address));
    expect(history.some((b) => b.title === "Launch liquidity adopted")).toBe(true);
    expect(history.filter((b) => b.title === "Reshape").length).toBeGreaterThanOrEqual(2);
  });
});
