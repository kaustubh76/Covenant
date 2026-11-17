// The live proof: Covenant's rules exercised as real transactions against a launched vault on a public chain, each one
// on record with its receipt. Behind `npm run proof` (scripts/proof-public.ts) and the fork suite.
//
// It runs through the app's own public-chain code (pre-flight, send, the market and restore helpers) and checks the whole
// plan by simulation before it sends anything. Progress is kept in deployments/<name>.proof.json, each transaction's hash
// saved the moment it is broadcast (runkit.ts), so a run that stops carries on where it left off without sending any step
// twice. On a rehearsal fork the TWAP window is jumped over instead of waited out.
//
//   rug      the curator's soft rug: refused in pre-flight (SupportBroken), then sent anyway with a fixed gas limit, so
//            the chain itself reverts it. The one transaction here meant to fail. The app never sends one.
//   deepen   an honest reshape: half the reserve into the band, the rest four bands deeper. Within Pace and Support.
//   crash    the smallest sell-off that strands support once it holds, found by simulation (crashsim.ts), then sold.
//            (Then nobody trades until the TWAP has followed the price to within the guard: 26 minutes on the live run.)
//   keeper   a second address, whose key is derived from the signer's, gets gas money.
//   restore  that address puts support back and is paid the bounty: restore is open to anyone.
//   fees     anyone collects the swap fees the sell-off paid.
//   refill   the issuer tops the bounty pool back up by what the keeper was paid.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Abi, type Address, formatEther, isAddressEqual, parseEther } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { covenantVaultAbi, testTokenAbi } from "../../src/chain/abi.generated";
import { type ExternalSigner, createChainCtx } from "../../src/chain/client";
import { type SimCall, findCrash } from "../../src/chain/crashsim";
import { NEVER } from "../../src/chain/launch";
import { pushTo } from "../../src/chain/market";
import { mergeSpans } from "../../src/chain/logs";
import { NETWORKS, type Runtime, networkOf, parseManifest } from "../../src/chain/network";
import { type Plan, deepenReserve, softRug } from "../../src/chain/plans";
import { preflight } from "../../src/chain/preflight";
import { planRestore, restoreCall } from "../../src/chain/scenarios/restore";
import { must, send } from "../../src/chain/tx";
import { readVaultView } from "../../src/chain/view";
import { ROOT, manifestPath, rpc, runtimePath } from "./localchain";
import { gasOf, loadRecord, mined, replayTx, runKit, type RunRecord, type RunStep, vaultEvent } from "./runkit";

export type ProofStepKey = "rug" | "deepen" | "crash" | "keeper" | "restore" | "fees" | "refill";

export type ProofStep = RunStep;

export interface ProofRecord extends RunRecord<ProofStepKey> {
  network: string;
  chainId: number;
  vault: Address;
  token: Address;
  signer: Address;
  keeper: Address;
  startedAtBlock: number;
  finishedAtBlock?: number;
  /** What the simulation said would happen, before anything was sent. */
  plan?: { depth: number; sold: string; supportAfterHold: number; restoreIndices: number[]; supportAfterRestore?: number };
}

export interface ProofOptions {
  net: "base-sepolia" | "base-sepolia-fork";
  /** The deployment to run against: deployments/<records>.json and .runtime.json. The proof uses its default vault. */
  records: string;
  /** The proof's own record, deployments/<progress>.proof.json (the records' name by default). */
  progress?: string;
  rpcUrl?: string;
  /** The vault's issuer and curator. It also sells the tokens for the crash. */
  signer: ExternalSigner;
  /** The stranger who restores. */
  keeper: PrivateKeyAccount;
  /** Jump time over the TWAP window instead of waiting (a fork only: Anvil's evm_increaseTime). */
  warp?: boolean;
  /** Add the proof's blocks to the launch's runtime record, so the app's activity feed keeps them. */
  recordSpan?: boolean;
  /** Simulate the whole proof and stop. Nothing is sent and nothing is written. */
  check?: boolean;
  /** Start a new proof instead of carrying on with the recorded one. */
  fresh?: boolean;
  log?: (line: string) => void;
}

export const proofPath = (name: string) => join(ROOT, "deployments", `${name}.proof.json`);

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
const amt = (wei: bigint) => {
  const v = Number(formatEther(wei));
  if (v === 0) return "0";
  // Fees on a testnet vault run to millionths of an ETH: written out in full, never as 2.45e-7.
  if (Math.abs(v) < 1e-4) return v.toFixed(12).replace(/0+$/, "");
  return v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(3);
};

export async function runProof(o: ProofOptions): Promise<ProofRecord> {
  const log = o.log ?? (() => {});
  const info = NETWORKS[o.net];
  const manifest = parseManifest(JSON.parse(readFileSync(manifestPath(o.records), "utf8")));
  const runtime = JSON.parse(readFileSync(runtimePath(o.records), "utf8")) as Runtime;
  const rpcUrl = o.rpcUrl ?? info.defaultRpc;
  const net = networkOf(o.net, rpcUrl, manifest, runtime);
  const ctx = createChainCtx(net, o.signer);
  const keeperCtx = createChainCtx(net, { account: o.keeper });
  const me = ctx.signer as Address;
  const keeper = o.keeper.address;

  const chainId = await ctx.pub.getChainId();
  if (chainId !== info.chainId) throw new Error(`the RPC answers as chain ${chainId}, not ${info.name} (${info.chainId})`);
  const vault = runtime.defaultVault as Address | undefined;
  if (!vault) throw new Error(`deployments/${o.records}.runtime.json records no vault: launch one first`);
  let v = await readVaultView(ctx, vault);
  if (!isAddressEqual(v.people.curator, me)) throw new Error(`${me} is not the curator of ${vault} (${v.people.curator}): the proof's reshapes are the curator's`);

  const path = proofPath(o.progress ?? o.records);
  const prev = loadRecord<ProofRecord>(path, o.fresh);
  if (prev && (!isAddressEqual(prev.vault, vault) || !isAddressEqual(prev.signer, me))) {
    throw new Error(`${path} is a proof against ${prev.vault} by ${prev.signer}, not this one. Pass --fresh to start another.`);
  }
  const p: ProofRecord = prev ?? { network: info.name, chainId, vault, token: v.token, signer: me, keeper, startedAtBlock: Number(await ctx.pub.getBlockNumber()), steps: {} };
  const { save, link, record, sending, landed } = runKit<ProofStepKey>({ path, record: p, ctx, check: o.check, log });
  const onResume = "settled before the runner stopped, and recorded when it resumed";
  const reshape = (plan: Plan) => ({ address: vault, abi: covenantVaultAbi, functionName: "reshape" as const, args: [plan.cuts, plan.legs, NEVER] as const });
  const describe = () => ({ now: v.time + 1, quoteSymbol: v.quoteSymbol, tokenSymbol: v.tokenSymbol });
  const sym = v.tokenSymbol;
  if (prev) log(`resuming the proof in ${path}`);
  log(`${info.name}: vault ${vault}, signer ${me}, keeper ${keeper}`);

  // The whole plan, simulated before anything is sent: the deepened reserve, the smallest sell-off that strands support
  // once it has held for the window, and the keeper's restore after it.
  if (!p.steps.crash) {
    const prelude: SimCall[] = p.steps.deepen ? [] : [{ account: me, to: vault, abi: covenantVaultAbi as Abi, functionName: "reshape", args: reshape(deepenReserve(v)).args }];
    const sim = await findCrash(ctx, v, me, keeper, prelude);
    if (!sim?.restore?.ok) throw new Error("no sell-off of the signer's tokens strands support on this layout once the reserve is deepened. Nothing was sent.");
    p.plan = {
      depth: sim.depth,
      sold: formatEther(sim.sold),
      supportAfterHold: sim.after.support.have,
      restoreIndices: sim.restore.indices,
      supportAfterRestore: sim.restore.supportAfter,
    };
    log(
      `plan (simulated): ${p.steps.deepen ? "" : "deepen the reserve, then "}sell ${amt(sim.sold)} ${sym}, ${sim.depth} ticks down, and hold it past the ` +
        `${Math.round(v.terms.twapWindow / 60)}-minute TWAP window. Support falls to ${pct(sim.after.support.have)} (needs ${pct(sim.after.support.need)}); ` +
        `a stranger's restore brings it back to ${pct(sim.restore.supportAfter ?? 0)}.`,
    );
  }
  if (o.check) return p;
  save();

  // 1. The soft rug, refused before it is sent and then sent anyway, so the chain's own refusal is on record.
  if (!p.steps.rug) {
    let receipt = await landed("rug", "reverted");
    if (!receipt) {
      v = await readVaultView(ctx, vault);
      const call = reshape(softRug(v));
      const pre = await preflight(ctx, "curator", call, v);
      if (pre.ok) throw new Error("the soft rug passed pre-flight: the covenant would not hold. Nothing was sent.");
      // A gas limit from the simulation, so the wallet does not estimate (an estimate of a revert fails) and the call
      // runs to the same revert rather than out of gas.
      const gas = await gasOf(ctx, me, call);
      const hash = await ctx.wallet("curator").writeContract({ ...call, gas } as never);
      sending("rug").onHash(hash);
      receipt = await ctx.pub.waitForTransactionReceipt({ hash, pollingInterval: 1_000, timeout: 180_000 });
      if (receipt.status !== "reverted") throw new Error(`the soft rug was meant to revert, but it settled: ${link(hash)}`);
    }
    const hash = receipt.transactionHash;
    const onChain = await replayTx(ctx, hash, describe());
    record("rug", {
      title: "The curator's soft rug",
      status: "reverted",
      hash,
      block: Number(receipt.blockNumber),
      error: onChain.signature,
      detail: `${onChain.signature}: support would have been ${pct(Number(onChain.args[0] ?? 0))}, the covenant needs ${pct(Number(onChain.args[1] ?? v.support.need))}`,
    });
  }

  // 2. An honest reshape that sets up what restore exists for.
  if (!p.steps.deepen) {
    const title = "An honest reshape: half the reserve four bands deep";
    const prior = await landed("deepen");
    if (prior) record("deepen", { title, status: "success", ...mined(prior.transactionHash, prior), detail: onResume });
    else {
      v = await readVaultView(ctx, vault);
      const sent = must(await send(ctx, "curator", reshape(deepenReserve(v)), sending("deepen")), "the reshape");
      const after = await readVaultView(ctx, vault);
      record("deepen", {
        title,
        status: "success",
        ...mined(sent.hash, sent.receipt),
        detail: `support ${pct(v.support.have)} → ${pct(after.support.have)} (needs ${pct(after.support.need)}), within Pace`,
      });
    }
  }

  // 3. The sell-off: the smallest that strands support once it holds, simulated again on the layout as it now is.
  if (!p.steps.crash) {
    const title = "The market sells the price down";
    const prior = await landed("crash");
    if (prior) record("crash", { title, status: "success", ...mined(prior.transactionHash, prior), detail: onResume });
    else {
      v = await readVaultView(ctx, vault);
      const sim = await findCrash(ctx, v, me, keeper);
      if (!sim?.restore?.ok) throw new Error("the deepened layout has no sell-off that strands support. Nothing more was sent.");
      const budget = await ctx.pub.readContract({ address: v.token, abi: testTokenAbi, functionName: "balanceOf", args: [me] });
      const sold = must(await pushTo(ctx, v, "market", v.spotTick - sim.depth, budget, sending("crash")), "the sell-off");
      const after = await readVaultView(ctx, vault);
      const drop = v.spotTick - after.spotTick;
      record("crash", {
        title,
        status: "success",
        ...mined(sold.hash, sold.receipt),
        detail: `${amt(sim.sold)} ${sym} sold; spot ${drop} ticks down (${dropOf(v.spotTick, after.spotTick)})`,
      });
      // The simulation chose this depth as the smallest that strands support; a sale that moved spot much less will not.
      if (drop < 0.9 * sim.depth) throw new Error(`the sell-off moved spot ${drop} ticks, short of the ${sim.depth} simulated; support may not lapse. Inspect before resuming.`);
    }
  }

  // 4. The price holds with nobody trading. Support counts against the time-weighted price, so it lapses only as the TWAP
  // follows the sell-off, and the guard lets restore through once spot and the TWAP are within its ticks again: before
  // the full window has passed, so restore goes as soon as its pre-flight does.
  const restoreTitle = "A stranger restores support, for the bounty";
  if (!p.steps.restore) {
    const prior = await landed("restore");
    if (prior) {
      const ev = vaultEvent(prior, vault, "Restored") as { bounty: bigint } | null;
      record("restore", { title: restoreTitle, status: "success", ...mined(prior.transactionHash, prior), value: ev?.bounty.toString(), detail: onResume });
    }
  }
  if (!p.steps.restore) {
    let jumped = false;
    for (;;) {
      v = await readVaultView(ctx, vault);
      const plan = await planRestore(ctx, v, keeper);
      if (plan?.pre.ok) break;
      if (o.warp) {
        if (jumped) throw new Error(`restore still refused after the window: ${plan?.pre.error?.signature ?? "nothing to restore"}`);
        await rpc(rpcUrl, "evm_increaseTime", [v.terms.twapWindow + 300]);
        await rpc(rpcUrl, "evm_mine", []);
        jumped = true;
        continue;
      }
      const crashedAt = Number((await ctx.pub.getBlock({ blockNumber: BigInt(p.steps.crash!.block) })).timestamp);
      const left = crashedAt + v.terms.twapWindow - v.time;
      if (left < -3600) throw new Error(`restore still refused an hour after the window: ${plan?.pre.error?.signature ?? "nothing to restore"}`);
      log(
        `  holding: support ${pct(v.support.have)} (needs ${pct(v.support.need)}), guard ${v.guard.ok ? "passes" : `${Math.round(v.guard.diff)} ticks off (limit ${v.guard.limit})`}` +
          (left > 0 ? `, about ${Math.ceil(left / 60)} min of the window left` : ", window passed"),
      );
      await new Promise((r) => setTimeout(r, 60_000));
    }
  }

  // 5. Gas money for the keeper, whose key the signer's derives (so its ETH is never stranded).
  if (!p.steps.restore && !p.steps.keeper) {
    const title = "A second address gets gas money";
    const prior = await landed("keeper");
    if (prior) record("keeper", { title, status: "success", ...mined(prior.transactionHash, prior), detail: `0.001 ETH to ${keeper}` });
    else if ((await ctx.pub.getBalance({ address: keeper })) < parseEther("0.0005")) {
      const hash = await ctx.wallet("issuer").sendTransaction({ to: keeper, value: parseEther("0.001") } as never);
      sending("keeper").onHash(hash);
      const receipt = await ctx.pub.waitForTransactionReceipt({ hash, pollingInterval: 1_000, timeout: 180_000 });
      record("keeper", { title, status: "success", hash, block: Number(receipt.blockNumber), detail: `0.001 ETH to ${keeper}` });
    }
  }

  // 6. The restore, by an address that is neither issuer nor curator, paid from the bounty pool.
  if (!p.steps.restore) {
    v = await readVaultView(ctx, vault);
    const plan = await planRestore(ctx, v, keeper);
    if (!plan?.pre.ok) throw new Error(`restore would not settle: ${plan?.pre.error?.signature ?? "nothing to restore"}`);
    const sent = must(await send(keeperCtx, "keeper", restoreCall(v, [...plan.indices].sort((a, b) => a - b)), sending("restore")), "the restore");
    const ev = vaultEvent(sent.receipt, vault, "Restored") as { supportBefore: bigint; supportAfter: bigint; bounty: bigint } | null;
    record("restore", {
      title: restoreTitle,
      status: "success",
      ...mined(sent.hash, sent.receipt),
      value: ev ? ev.bounty.toString() : undefined,
      detail: ev
        ? `support ${pct(Number(ev.supportBefore))} → ${pct(Number(ev.supportAfter))}; ${formatEther(ev.bounty)} ETH bounty paid to ${keeper}`
        : `ranges [${plan.indices.join(", ")}] restored by ${keeper}`,
    });
  }

  // 7. Fees the sell-off paid, collected by anyone: to the treasury, and part to the bounty pool.
  if (!p.steps.fees) {
    const prior = await landed("fees");
    const sent = prior
      ? { ok: true, hash: prior.transactionHash, receipt: prior, error: undefined, refused: undefined }
      : await send(ctx, "holder", { address: vault, abi: covenantVaultAbi, functionName: "collectFees", args: [] }, sending("fees"));
    if (sent.ok) {
      const ev = vaultEvent(sent.receipt, vault, "FeesCollected") as { toTreasury0: bigint; toTreasury1: bigint; toBountyPool: bigint } | null;
      const [q, t] = v.quoteIs0 ? [ev?.toTreasury0, ev?.toTreasury1] : [ev?.toTreasury1, ev?.toTreasury0];
      record("fees", {
        title: "Anyone collects the swap fees",
        status: "success",
        ...mined(sent.hash, sent.receipt),
        detail: ev ? `${amt(q ?? 0n)} ETH and ${amt(t ?? 0n)} ${sym} to the treasury, ${amt(ev.toBountyPool)} ETH to the bounty pool` : "fees collected",
      });
    } else log(`collectFees: ${sent.error?.signature ?? sent.refused ?? "refused"}; skipped`);
  }

  // 8. The bounty pool topped back up by what the keeper was paid, so the next keeper finds it as this one did. (A bounty
  // is capped at a share of the quote a restore moves, so it can be small.)
  const paid = BigInt(p.steps.restore?.value ?? "0");
  if (!p.steps.refill && paid > 0n) {
    const prior = await landed("refill");
    const sent = prior
      ? { hash: prior.transactionHash, receipt: prior }
      : must(await send(ctx, "issuer", { address: vault, abi: covenantVaultAbi, functionName: "fundBounty", args: [paid], value: paid }, sending("refill")), "fundBounty");
    record("refill", {
      title: "The issuer tops the bounty pool back up",
      status: "success",
      ...mined(sent.hash, sent.receipt),
      value: paid.toString(),
      detail: `${formatEther(paid)} ETH, what the keeper was paid`,
    });
  }

  p.finishedAtBlock ??= Number(await ctx.pub.getBlockNumber());
  save();
  if (o.recordSpan) {
    // The feed reads recent blocks only; kept spans stay in it for good (history.ts). The whole run spans thousands of
    // 200 ms blocks, so only the blocks holding its events are kept: the reverted rug and the gas transfer leave none.
    const rpath = runtimePath(o.records);
    const rt = JSON.parse(readFileSync(rpath, "utf8")) as Runtime;
    const launch = rt.launches.find((l) => isAddressEqual(l.vault, vault));
    if (launch) {
      const blocks = (["deepen", "crash", "restore", "fees", "refill"] as const).map((k) => p.steps[k]?.block).filter((b): b is number => !!b);
      launch.spans = mergeSpans(launch.spans ?? [], blocks);
      writeFileSync(rpath, JSON.stringify(rt, null, 2) + "\n");
      log(`kept blocks ${launch.spans.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ")} in ${rpath}`);
    }
  }
  log(`proof complete: ${path}`);
  return p;
}



/** A fall in price ticks as a percentage: ticks are 0.01% steps in price. */
const dropOf = (before: number, after: number) => `${((1 - 1.0001 ** (after - before)) * 100).toFixed(1)}% lower`;

