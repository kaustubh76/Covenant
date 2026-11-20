// The refusal proof: the attack lab's one-call attacks, put on chain against a live vault. Behind
// `npm run proof -- --refusals` (scripts/proof-public.ts).
//
// Each attack is the same call the attack lab's live check simulates (src/chain/scenarios/attackcalls.ts). It is
// pre-flighted first and sent only when the pre-flight fails with the error the covenant is meant to give, so what is
// on record is the chain's own refusal, decoded from the mined transaction. Nothing here changes a role or moves the
// price; the two calls that settle are a keeper's poke and the curator's fee claim.
//
//   curatorWithdraw  the curator withdraws shares it does not hold        InsufficientShares (or NotIssuer, roles apart)
//   skim             a reshape that re-adds only 90% of the support         IdleTooLarge
//   fragment         the reserve split over the range cap                   TooManyRanges
//   issuerExit       the issuer takes principal that has not vested         Locked
//   farm             a keeper restores while support is healthy             NothingToRestore
//   outsider         a stranger removes a vault range through a router      SafeCastOverflow (the router's own position)
//   vaultPays        an LP deposits with 1 wei attached                     InsufficientPayment
//   poke             a keeper syncs the Anchor                              settles
//   curatorFees      the curator claims its share of the fees               settles

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, formatEther, isAddressEqual, parseEther } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { type ChainCtx, type ExternalSigner, createChainCtx } from "../../src/chain/client";
import { mergeSpans } from "../../src/chain/logs";
import { NETWORKS, type Runtime, networkOf, parseManifest } from "../../src/chain/network";
import {
  curatorWithdrawCall,
  farmCall,
  fragmentCall,
  issuerExitCall,
  outsiderCall,
  skimCall,
  vaultCall,
  vaultPaysCall,
} from "../../src/chain/scenarios/attackcalls";
import type { ActionCall } from "../../src/chain/preflight";
import { simulate } from "../../src/chain/tx";
import { type VaultView, readVaultView } from "../../src/chain/view";
import { ROOT, manifestPath, runtimePath } from "./localchain";
import { loadRecord, mined, runKit, type RunRecord, vaultEvent } from "./runkit";

export type RefusalStepKey = "gas" | "curatorWithdraw" | "skim" | "fragment" | "issuerExit" | "farm" | "outsider" | "vaultPays" | "poke" | "curatorFees";

export interface RefusalProofRecord extends RunRecord<RefusalStepKey> {
  network: string;
  chainId: number;
  vault: Address;
  token: Address;
  signer: Address;
  keeper: Address;
  lp: Address;
  startedAtBlock: number;
  finishedAtBlock?: number;
}

export interface RefusalProofOptions {
  net: "base-sepolia" | "base-sepolia-fork";
  records: string;
  /** The proof's own record, deployments/<progress>.proof.json (`<records>-refusals` by default). */
  progress?: string;
  rpcUrl?: string;
  /** The vault's issuer and curator. */
  signer: ExternalSigner;
  /** A stranger: farms the bounty, reaches for the vault's positions, pokes. */
  keeper: PrivateKeyAccount;
  /** An outside depositor, who tries to make the vault pay. */
  lp: PrivateKeyAccount;
  /** The vault: the runtime's default unless given. */
  vault?: Address;
  recordSpan?: boolean;
  check?: boolean;
  fresh?: boolean;
  log?: (line: string) => void;
}

export const refusalProofPath = (name: string) => join(ROOT, "deployments", `${name}.proof.json`);

/** What each helper needs for gas: refusals and a poke cost a few millionths of an ETH on Base Sepolia. */
const GAS_FLOOR = parseEther("0.0005");
const GAS_MONEY = parseEther("0.001");

const pct = (bps: unknown) => `${(Number(bps ?? 0) / 100).toFixed(1)}%`;
const amt = (wei: bigint) => {
  const x = Number(formatEther(wei));
  return x === 0 ? "0" : x < 1e-4 ? x.toFixed(12).replace(/0+$/, "") : x.toPrecision(3);
};

export async function runRefusalProof(o: RefusalProofOptions): Promise<RefusalProofRecord> {
  const log = o.log ?? (() => {});
  const info = NETWORKS[o.net];
  const manifest = parseManifest(JSON.parse(readFileSync(manifestPath(o.records), "utf8")));
  const runtime = JSON.parse(readFileSync(runtimePath(o.records), "utf8")) as Runtime;
  const rpcUrl = o.rpcUrl ?? info.defaultRpc;
  const net = networkOf(o.net, rpcUrl, manifest, runtime);
  const ctx = createChainCtx(net, o.signer);
  const keeperCtx = createChainCtx(net, { account: o.keeper });
  const lpCtx = createChainCtx(net, { account: o.lp });
  const me = ctx.signer as Address;

  const chainId = await ctx.pub.getChainId();
  if (chainId !== info.chainId) throw new Error(`the RPC answers as chain ${chainId}, not ${info.name} (${info.chainId})`);
  const vault = (o.vault ?? runtime.defaultVault) as Address | undefined;
  if (!vault) throw new Error(`deployments/${o.records}.runtime.json records no vault`);
  let v = await readVaultView(ctx, vault);
  if (!isAddressEqual(v.people.curator, me) || !isAddressEqual(v.people.issuer, me)) {
    throw new Error(`${me} is not the issuer and curator of ${vault} (issuer ${v.people.issuer}, curator ${v.people.curator})`);
  }

  const path = refusalProofPath(o.progress ?? `${o.records}-refusals`);
  const prev = loadRecord<RefusalProofRecord>(path, o.fresh);
  if (prev && (!isAddressEqual(prev.vault, vault) || !isAddressEqual(prev.signer, me))) {
    throw new Error(`${path} is a refusal proof against ${prev.vault} by ${prev.signer}, not this one. Pass --fresh to start another.`);
  }
  const p: RefusalProofRecord = prev ?? {
    network: info.name,
    chainId,
    vault,
    token: v.token,
    signer: me,
    keeper: o.keeper.address,
    lp: o.lp.address,
    startedAtBlock: Number(await ctx.pub.getBlockNumber()),
    steps: {},
  };
  const kit = runKit<RefusalStepKey>({
    path,
    record: p,
    ctx,
    check: o.check,
    log,
  });
  const describe = () => ({
    now: v.time + 1,
    quoteSymbol: v.quoteSymbol,
    tokenSymbol: v.tokenSymbol,
  });
  const fresh = async () => {
    v = await readVaultView(ctx, vault);
    return v;
  };
  if (prev) log(`resuming the refusal proof in ${path}`);
  log(`${info.name}: vault ${vault} (${v.tokenSymbol}), issuer and curator ${me}, keeper ${o.keeper.address}, LP ${o.lp.address}`);

  if (!outsiderCall(v, manifest)) throw new Error("this network records no liquidity router, or the vault holds no ranges");
  const cw = curatorWithdrawCall(v);
  // Every refusal, pre-flighted against the vault as it is now: the whole run is checked before anything is sent.
  const plan: {
    key: RefusalStepKey;
    ctx: ChainCtx;
    title: string;
    expect: string[];
    build: (x: VaultView) => ActionCall;
  }[] = [
    {
      key: "curatorWithdraw",
      ctx,
      title: cw.title,
      expect: ["InsufficientShares", "NotIssuer"],
      build: (x) => curatorWithdrawCall(x).call,
    },
    {
      key: "skim",
      ctx,
      title: "The curator re-adds only 90% of the support",
      expect: ["IdleTooLarge"],
      build: skimCall,
    },
    {
      key: "fragment",
      ctx,
      title: "The curator splits the reserve over the range cap",
      expect: ["TooManyRanges"],
      build: fragmentCall,
    },
    {
      key: "issuerExit",
      ctx,
      title: "The issuer withdraws principal that has not vested",
      expect: ["Locked"],
      build: issuerExitCall,
    },
    {
      key: "farm",
      ctx: keeperCtx,
      title: "A keeper calls restore on a healthy vault",
      expect: ["NothingToRestore"],
      build: farmCall,
    },
    {
      key: "outsider",
      ctx: keeperCtx,
      title: "A stranger removes one of the vault's ranges through a router",
      expect: ["SafeCastOverflow", "CannotUpdateEmptyPosition"],
      build: (x) => outsiderCall(x, manifest) as ActionCall,
    },
    {
      key: "vaultPays",
      ctx: lpCtx,
      title: "An LP deposits for a tenth of the vault with 1 wei attached",
      expect: ["InsufficientPayment"],
      build: vaultPaysCall,
    },
  ];
  // Stand-ins' balances do not matter to a pre-flight of a refusal, but the guard does: every reshape checks it first.
  if (!v.guard.ok)
    throw new Error(
      `the guard is tripped (spot ${Math.round(v.guard.diff)} ticks from the TWAP): the reshapes would be refused for that instead. Run again once it passes.`,
    );
  if (o.check) {
    for (const s of plan) {
      const pre = await simulate(s.ctx, s.ctx.signer as Address, s.build(v) as never, describe());
      const okay = !pre.ok && s.expect.includes(pre.error?.name ?? "");
      log(`${okay ? "ok  " : "FAIL"} ${s.key}: ${pre.ok ? "would settle" : pre.error?.signature}`);
    }
    const poke = await simulate(keeperCtx, o.keeper.address, vaultCall(v, "poke", []) as never);
    const fees = await simulate(ctx, me, vaultCall(v, "claimCuratorFees", []) as never);
    log(`${poke.ok ? "ok  " : "FAIL"} poke: ${poke.ok ? "settles" : poke.error?.signature}`);
    log(
      `${fees.ok ? "ok  " : "FAIL"} curatorFees: ${fees.ok ? `settles, ${JSON.stringify(fees.value, (_, x) => (typeof x === "bigint" ? x.toString() : x))}` : fees.error?.signature}`,
    );
    return p;
  }
  kit.save();

  // Gas money for the two helpers, if they are short (their keys are derived from the signer's, so nothing strands).
  if (!p.steps.gas) {
    const [kb, lb] = await Promise.all([ctx.pub.getBalance({ address: o.keeper.address }), ctx.pub.getBalance({ address: o.lp.address })]);
    const short = [kb < GAS_FLOOR ? o.keeper.address : null, lb < GAS_FLOOR ? o.lp.address : null].filter((a): a is Address => !!a);
    if (short.length) {
      const prior = await kit.landed("gas");
      if (prior)
        kit.record("gas", {
          title: "Gas money for the helpers",
          status: "success",
          ...mined(prior.transactionHash, prior),
          detail: kit.onResume,
        });
      else {
        let last: { hash: `0x${string}`; block: number } | null = null;
        for (const to of short) {
          const hash = await ctx.wallet("issuer").sendTransaction({ to, value: GAS_MONEY } as never);
          kit.sending("gas").onHash(hash);
          const r = await ctx.pub.waitForTransactionReceipt({
            hash,
            pollingInterval: 1_000,
            timeout: 180_000,
          });
          last = { hash, block: Number(r.blockNumber) };
        }
        if (last)
          kit.record("gas", {
            title: "Gas money for the helpers",
            status: "success",
            ...last,
            detail: `${formatEther(GAS_MONEY)} ETH each to ${short.join(", ")}`,
          });
      }
    }
  }

  // The refusals, each against the vault as it is when it is sent.
  for (const s of plan) {
    if (p.steps[s.key]) continue;
    await fresh();
    await kit.refuse(s.key, {
      ctx: s.ctx,
      call: s.build(v),
      title: s.title,
      expect: s.expect,
      describe,
      detail: (e) => `${e.signature}: ${e.reason}`,
    });
  }

  // A keeper syncs the Anchor: permissionless, and it changes nothing a holder owns. (No event: the transaction is the record.)
  await fresh();
  const anchorBefore = v.anchor;
  await kit.settle("poke", {
    ctx: keeperCtx,
    call: vaultCall(v, "poke", []),
    title: "A keeper syncs the Anchor",
    detail: async () => {
      const after = await fresh();
      return after.anchor === anchorBefore
        ? `the Anchor is committed at tick ${after.anchor}, unchanged: the TWAP has not moved it`
        : `the Anchor moves from tick ${anchorBefore} to ${after.anchor}`;
    },
  });

  // The curator takes its share of the trading fees, which the terms set aside for it on every swap.
  await kit.settle("curatorFees", {
    ctx,
    call: vaultCall(v, "claimCuratorFees", []),
    title: "The curator claims its fee share",
    detail: (out) => {
      const ev = vaultEvent(out.receipt, vault, "CuratorFeesClaimed") as {
        amount0: bigint;
        amount1: bigint;
      } | null;
      if (!ev) return "claimed";
      const [q, t] = v.quoteIs0 ? [ev.amount0, ev.amount1] : [ev.amount1, ev.amount0];
      return `${amt(q)} ETH and ${amt(t)} ${v.tokenSymbol} to the curator, its ${pct(v.terms.curatorFeeBps)} of the fees`;
    },
  });

  p.finishedAtBlock ??= Number(await ctx.pub.getBlockNumber());
  kit.save();
  if (o.recordSpan) {
    // Refusals and a poke leave no event; the fee claim does.
    const rpath = runtimePath(o.records);
    const rt = JSON.parse(readFileSync(rpath, "utf8")) as Runtime;
    const launch = rt.launches.find((l) => isAddressEqual(l.vault, vault));
    const block = p.steps.curatorFees?.block;
    if (launch && block) {
      launch.spans = mergeSpans(launch.spans ?? [], [block]);
      writeFileSync(rpath, JSON.stringify(rt, null, 2) + "\n");
    }
  }
  log(`refusal proof complete: ${path}`);
  return p;
}
