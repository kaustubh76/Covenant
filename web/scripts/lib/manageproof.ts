// The management proof: active liquidity management on a live vault, within its rules, each step a real transaction.
// Behind `npm run proof -- --manage` (scripts/proof-public.ts) and the fork suite.
//
// A curator may move the launch's liquidity freely, but no bid above the Anchor ceiling, and no more of the vault's value
// per epoch than Pace allows. Both are shown refused by the chain itself, and an honest re-centre shown settling between
// them. It runs against a vault past its setup epoch (Pace is not enforced during it), and checks each step by simulation
// before sending it; a simulation that disagrees with what the step expects stops the run with nothing more sent.
//
//   pump      the market buys the price well above the Anchor ceiling (the issuer's address, standing in for it)
//             (Then nobody trades until the guard lets curator actions through again: the TWAP has followed the price.)
//   chase     the curator bids up to the pumped price: refused with BidAboveCeiling. Sent anyway, so the chain refuses it.
//   recentre  the curator re-centres the support range on the TWAP, capped at the ceiling: settles, within Pace
//   overpace  the curator tries to move everything in the same epoch: refused with PaceExceeded. Sent anyway too.
//
// Reshape checks run guard, Pace, then the ceiling, so the chase comes while the epoch's allowance is still unspent.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, isAddressEqual } from "viem";
import { covenantVaultAbi } from "../../src/chain/abi.generated";
import { type ExternalSigner, createChainCtx } from "../../src/chain/client";
import { NEVER } from "../../src/chain/launch";
import { mergeSpans } from "../../src/chain/logs";
import { pushTo } from "../../src/chain/market";
import { NETWORKS, type Runtime, networkOf, parseManifest } from "../../src/chain/network";
import { type Plan, chasePump, moveEverything, recentre } from "../../src/chain/plans";
import { priceAt, rangeToPrice } from "../../src/chain/price";
import { preflight } from "../../src/chain/preflight";
import { must, send } from "../../src/chain/tx";
import { readVaultView } from "../../src/chain/view";
import { ROOT, manifestPath, rpc, runtimePath } from "./localchain";
import { gasOf, loadRecord, mined, replayTx, runKit, type RunRecord, vaultEvent } from "./runkit";

export type ManageStepKey = "pump" | "chase" | "recentre" | "overpace";

export interface ManageProofRecord extends RunRecord<ManageStepKey> {
  network: string;
  chainId: number;
  vault: Address;
  token: Address;
  curator: Address;
  startedAtBlock: number;
  finishedAtBlock?: number;
}

export interface ManageProofOptions {
  net: "base-sepolia" | "base-sepolia-fork";
  records: string;
  /** The proof's own record, deployments/<progress>.proof.json (`<records>-manage` by default). */
  progress?: string;
  rpcUrl?: string;
  /** The vault's curator and issuer: it pumps, chases, re-centres and over-reaches. */
  signer: ExternalSigner;
  /** The vault: the runtime records' latest launch unless given. */
  vault?: Address;
  /** Jump time instead of waiting (a fork only). */
  warp?: boolean;
  recordSpan?: boolean;
  check?: boolean;
  fresh?: boolean;
  log?: (line: string) => void;
}

export const manageProofPath = (name: string) => join(ROOT, "deployments", `${name}.proof.json`);

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
const fmt = (ethPerToken: number) => ethPerToken.toPrecision(4);
const rise = (from: number, to: number) => `${((1.0001 ** (to - from) - 1) * 100).toFixed(1)}%`;

export async function runManageProof(o: ManageProofOptions): Promise<ManageProofRecord> {
  const log = o.log ?? (() => {});
  const info = NETWORKS[o.net];
  const manifest = parseManifest(JSON.parse(readFileSync(manifestPath(o.records), "utf8")));
  const runtime = JSON.parse(readFileSync(runtimePath(o.records), "utf8")) as Runtime;
  const rpcUrl = o.rpcUrl ?? info.defaultRpc;
  const net = networkOf(o.net, rpcUrl, manifest, runtime);
  const ctx = createChainCtx(net, o.signer);
  const me = ctx.signer as Address;

  const chainId = await ctx.pub.getChainId();
  if (chainId !== info.chainId) throw new Error(`the RPC answers as chain ${chainId}, not ${info.name} (${info.chainId})`);
  const vault = o.vault ?? runtime.launches.at(-1)?.vault;
  if (!vault) throw new Error(`deployments/${o.records}.runtime.json records no launch`);
  let v = await readVaultView(ctx, vault);
  if (!isAddressEqual(v.people.curator, me)) throw new Error(`${me} is not the curator of ${vault} (${v.people.curator})`);

  const path = manageProofPath(o.progress ?? `${o.records}-manage`);
  const prev = loadRecord<ManageProofRecord>(path, o.fresh);
  if (prev && (!isAddressEqual(prev.vault, vault) || !isAddressEqual(prev.curator, me))) {
    throw new Error(`${path} is a management proof against ${prev.vault} by ${prev.curator}, not this one. Pass --fresh to start another.`);
  }
  const p: ManageProofRecord = prev ?? { network: info.name, chainId, vault, token: v.token, curator: me, startedAtBlock: Number(await ctx.pub.getBlockNumber()), steps: {} };
  const { save, record, sending, landed } = runKit<ManageStepKey>({ path, record: p, ctx, check: o.check, log });
  const onResume = "settled before the runner stopped, and recorded when it resumed";
  const reshape = (plan: Plan) => ({ address: vault, abi: covenantVaultAbi, functionName: "reshape" as const, args: [plan.cuts, plan.legs, NEVER] as const });
  const describe = () => ({ now: v.time + 1, quoteSymbol: v.quoteSymbol, tokenSymbol: v.tokenSymbol });
  if (prev) log(`resuming the management proof in ${path}`);
  log(`${info.name}: vault ${vault} (${v.tokenSymbol}), curator ${me}`);

  // Pace is not enforced in the setup epoch, so the over-reach would not be refused yet.
  for (let jumped = false; v.pace.setup; ) {
    const left = v.pace.setupEndsAt - v.time;
    if (o.warp && !jumped) {
      await rpc(rpcUrl, "evm_increaseTime", [left + 5]);
      await rpc(rpcUrl, "evm_mine", []);
      jumped = true;
    } else if (o.warp) throw new Error("still in the setup epoch after jumping over it");
    else {
      log(`  setup epoch: Pace applies in about ${Math.max(1, Math.ceil(left / 60))} min`);
      await new Promise((r) => setTimeout(r, Math.min(60_000, Math.max(5_000, left * 1000 + 3_000))));
    }
    v = await readVaultView(ctx, vault);
  }

  // The pump's target: far enough over the ceiling that the Anchor, which climbs at most half a band while the TWAP
  // catches up, is still well below the price when the curator tries to follow it.
  const target = v.ceiling + Math.ceil(v.terms.supportBandTicks / 2) + 4 * v.tickSpacing;
  if (o.check) {
    log(`plan: pump spot ${v.spotTick} → ${target} (+${rise(v.spotTick, target)}), above the ceiling ${v.ceiling}; hold; chase (refused); re-centre; over-reach (refused)`);
    return p;
  }
  save();

  // 1. The pump.
  if (!p.steps.pump) {
    const title = "The market pumps the price";
    const prior = await landed("pump");
    if (prior) record("pump", { title, status: "success", ...mined(prior.transactionHash, prior), detail: onResume });
    else {
      const before = v.spotTick;
      const balance = await ctx.pub.getBalance({ address: me });
      const sent = must(await pushTo(ctx, v, "market", target, balance, sending("pump")), "the pump");
      v = await readVaultView(ctx, vault);
      record("pump", {
        title,
        status: "success",
        ...mined(sent.hash, sent.receipt),
        detail: `price ${fmt(priceAt(before))} → ${fmt(priceAt(v.spotTick))} ETH (+${rise(before, v.spotTick)}), above the Anchor ceiling at ${fmt(priceAt(v.ceiling))}`,
      });
      if (v.spotTick <= v.ceiling) throw new Error("the pump did not lift spot above the ceiling: there is nothing to chase");
    }
  }

  // 2–3. Hold until the guard lets the curator act, then chase: what the chain refuses has to be the Anchor, not the guard.
  if (!p.steps.chase) {
    const title = "The curator chases the pump";
    let receipt = await landed("chase", "reverted");
    if (!receipt) {
      for (let jumped = false; ; ) {
        v = await readVaultView(ctx, vault);
        const pre = await preflight(ctx, "curator", reshape(chasePump(v)), v);
        if (pre.ok) throw new Error("the chase passed pre-flight: the Anchor caught up with the pump. Nothing was sent.");
        if (pre.error?.name === "BidAboveCeiling") break;
        if (pre.error?.name !== "PriceGuard") throw new Error(`the chase was refused with ${pre.error?.signature}, not BidAboveCeiling. Nothing was sent.`);
        if (o.warp) {
          if (jumped) throw new Error("the guard still refuses after the TWAP window");
          await rpc(rpcUrl, "evm_increaseTime", [v.terms.twapWindow]);
          await rpc(rpcUrl, "evm_mine", []);
          jumped = true;
          continue;
        }
        log(`  holding: spot ${Math.round(v.guard.diff)} ticks off the TWAP (the guard allows ${v.guard.limit}); the curator waits`);
        await new Promise((r) => setTimeout(r, 60_000));
      }
      const call = reshape(chasePump(v));
      const gas = await gasOf(ctx, me, call);
      const hash = await ctx.wallet("curator").writeContract({ ...call, gas } as never);
      sending("chase").onHash(hash);
      receipt = await ctx.pub.waitForTransactionReceipt({ hash, pollingInterval: 1_000, timeout: 180_000 });
      if (receipt.status !== "reverted") throw new Error(`the chase was meant to revert, but it settled: ${hash}`);
    }
    const err = await replayTx(ctx, receipt.transactionHash, describe());
    // BidAboveCeiling(bidTop, ceiling), in price ticks: the chain's own ceiling in that block, not the view's from before.
    const [bidTop, ceiling] = (err.args as readonly unknown[]).map(Number);
    record("chase", {
      title,
      status: "reverted",
      ...mined(receipt.transactionHash, receipt),
      error: err.signature,
      detail:
        Number.isFinite(bidTop) && Number.isFinite(ceiling)
          ? `${err.signature}: a bid up to ${fmt(priceAt(bidTop))} ETH, over the Anchor ceiling at ${fmt(priceAt(ceiling))}`
          : `${err.signature}: bids up to the pumped price, above the Anchor ceiling`,
    });
  }

  // 4. The honest move: the support range re-centred on the TWAP, but no higher than the ceiling.
  if (!p.steps.recentre) {
    const title = "The curator re-centres, capped at the Anchor";
    const prior = await landed("recentre");
    if (prior) record("recentre", { title, status: "success", ...mined(prior.transactionHash, prior), detail: onResume });
    else {
      v = await readVaultView(ctx, vault);
      const plan = recentre(v);
      const sent = must(await send(ctx, "curator", reshape(plan), sending("recentre")), "the re-centre");
      const ev = vaultEvent(sent.receipt, vault, "Reshaped") as { movedFraction: bigint; supportBps: bigint } | null;
      const after = await readVaultView(ctx, vault);
      const [lo, hi] = rangeToPrice(v.quoteIs0, plan.legs[0].tickLower, plan.legs[0].tickUpper);
      record("recentre", {
        title,
        status: "success",
        ...mined(sent.hash, sent.receipt),
        detail: ev
          ? `moved ${pct(Number(ev.movedFraction) / 1e5)} of the vault's value into bids from ${fmt(priceAt(lo))} to ${fmt(priceAt(hi))} ETH, capped at the Anchor ceiling; support ${pct(Number(ev.supportBps))}; Pace left this epoch: ${pct(after.pace.available * 1e4)} of the vault's value`
          : "re-centred",
      });
    }
  }

  // 5. The over-reach: everything at once, in the same epoch.
  if (!p.steps.overpace) {
    const title = "The curator tries to move everything at once";
    let receipt = await landed("overpace", "reverted");
    if (!receipt) {
      v = await readVaultView(ctx, vault);
      const call = reshape(moveEverything(v));
      const pre = await preflight(ctx, "curator", call, v);
      if (pre.ok) throw new Error("moving everything passed pre-flight: Pace would not hold. Nothing was sent.");
      if (pre.error?.name !== "PaceExceeded") throw new Error(`moving everything was refused with ${pre.error?.signature}, not PaceExceeded. Nothing was sent.`);
      const gas = await gasOf(ctx, me, call);
      const hash = await ctx.wallet("curator").writeContract({ ...call, gas } as never);
      sending("overpace").onHash(hash);
      receipt = await ctx.pub.waitForTransactionReceipt({ hash, pollingInterval: 1_000, timeout: 180_000 });
      if (receipt.status !== "reverted") throw new Error(`the over-reach was meant to revert, but it settled: ${hash}`);
    }
    const err = await replayTx(ctx, receipt.transactionHash, describe());
    const [requested, available] = err.args as readonly [bigint?, bigint?];
    record("overpace", {
      title,
      status: "reverted",
      ...mined(receipt.transactionHash, receipt),
      error: err.signature,
      detail:
        requested !== undefined && available !== undefined
          ? `${err.signature}: asked to move ${pct(Number(requested) / 1e5)} of the vault's value, ${pct(Number(available) / 1e5)} is left this epoch`
          : err.signature,
    });
  }

  p.finishedAtBlock ??= Number(await ctx.pub.getBlockNumber());
  save();
  if (o.recordSpan) {
    const rpath = runtimePath(o.records);
    const rt = JSON.parse(readFileSync(rpath, "utf8")) as Runtime;
    const launch = rt.launches.find((l) => isAddressEqual(l.vault, vault));
    if (launch) {
      const blocks = (["pump", "recentre"] as const).map((k) => p.steps[k]?.block).filter((b): b is number => !!b);
      launch.spans = mergeSpans(launch.spans ?? [], blocks);
      writeFileSync(rpath, JSON.stringify(rt, null, 2) + "\n");
      log(`kept blocks ${launch.spans.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ")} in ${rpath}`);
    }
  }
  log(`management proof complete: ${path}`);
  return p;
}



