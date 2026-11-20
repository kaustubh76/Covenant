// The LP proof: an outside LP joins a launched vault in kind, earns its share of the swap fees and leaves in kind, each a
// real transaction on record. Behind `npm run proof -- --lp` (scripts/proof-public.ts) and the fork suite.
//
// Deposits stay closed for a vault's first epoch, so this runs against a vault past it: CVLP, launched with the contract's
// minimum one-hour epoch. The runner waits for the epoch to end, or on a fork jumps over it. It prices the deposit the way
// the Provide page does (src/chain/provide.ts) and resumes like the live proof (runkit.ts): no step is sent twice.
//
//   gas      the issuer sends the LP gas money and the deposit's ETH (the LP's key is derived from the issuer's)
//   tokens   the issuer sends it the tokens the deposit needs
//   join     the LP deposits for 10% new shares, paying both currencies in proportion to every range
//   buy      the market buys a little through PoolSwapTest...
//   sell     ...and sells about as much back, so the vault's ranges earn swap fees both ways
//   collect  anyone collects the fees: the treasury's and the bounty pool's cut, the rest owed to shareholders
//   claim    the LP claims its share
//   leave    the LP burns every share and takes its slice of every range back, in kind

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, formatEther, isAddressEqual, parseEther } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { covenantVaultAbi, testTokenAbi } from "../../src/chain/abi.generated";
import { type ExternalSigner, createChainCtx } from "../../src/chain/client";
import { NEVER } from "../../src/chain/launch";
import { mergeSpans } from "../../src/chain/logs";
import { swap } from "../../src/chain/market";
import { NETWORKS, type Runtime, networkOf, parseManifest } from "../../src/chain/network";
import { priceAt } from "../../src/chain/price";
import { preflight } from "../../src/chain/preflight";
import { depositCall, ensureAllowance, quoteBudget, withSlack } from "../../src/chain/provide";
import { must, send } from "../../src/chain/tx";
import { readVaultView } from "../../src/chain/view";
import { ROOT, manifestPath, rpc, runtimePath } from "./localchain";
import { loadRecord, mined, runKit, type RunRecord, vaultEvent } from "./runkit";

export type LpStepKey = "gas" | "tokens" | "join" | "buy" | "sell" | "collect" | "claim" | "leave";

export interface LpProofRecord extends RunRecord<LpStepKey> {
  network: string;
  chainId: number;
  vault: Address;
  token: Address;
  issuer: Address;
  lp: Address;
  startedAtBlock: number;
  finishedAtBlock?: number;
}

export interface LpProofOptions {
  net: "base-sepolia" | "base-sepolia-fork";
  /** The deployment to run against: deployments/<records>.json and .runtime.json. */
  records: string;
  /** The proof's own record, deployments/<progress>.proof.json (`<records>-lp` by default). */
  progress?: string;
  rpcUrl?: string;
  /** The vault's issuer: it funds the LP and makes the trades. */
  signer: ExternalSigner;
  lp: PrivateKeyAccount;
  /** The vault: the runtime records' latest launch unless given. */
  vault?: Address;
  /** Jump over the setup epoch instead of waiting (a fork only). */
  warp?: boolean;
  /** Add the proof's event blocks to the vault's runtime record, so the app's feed keeps them. */
  recordSpan?: boolean;
  /** Say what would happen and stop. Nothing is sent and nothing is written. */
  check?: boolean;
  fresh?: boolean;
  log?: (line: string) => void;
}

export const lpProofPath = (name: string) => join(ROOT, "deployments", `${name}.proof.json`);

/** The LP adds this percentage of the vault's shares. */
const SHARE = 10n;
const GAS_MONEY = parseEther("0.004");
const TRADE = parseEther("0.001");

const amt = (wei: bigint) => {
  const v = Number(formatEther(wei));
  if (v === 0) return "0";
  // Fees on a testnet vault run to millionths of an ETH: written out in full, never as 2.45e-7.
  if (Math.abs(v) < 1e-4) return v.toFixed(12).replace(/0+$/, "");
  return v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(3);
};

export async function runLpProof(o: LpProofOptions): Promise<LpProofRecord> {
  const log = o.log ?? (() => {});
  const info = NETWORKS[o.net];
  const manifest = parseManifest(JSON.parse(readFileSync(manifestPath(o.records), "utf8")));
  const runtime = JSON.parse(readFileSync(runtimePath(o.records), "utf8")) as Runtime;
  const rpcUrl = o.rpcUrl ?? info.defaultRpc;
  const net = networkOf(o.net, rpcUrl, manifest, runtime);
  const ctx = createChainCtx(net, o.signer);
  const lpCtx = createChainCtx(net, { account: o.lp });
  const me = ctx.signer as Address;
  const lp = o.lp.address;

  const chainId = await ctx.pub.getChainId();
  if (chainId !== info.chainId) throw new Error(`the RPC answers as chain ${chainId}, not ${info.name} (${info.chainId})`);
  // Unless told, the vault this proof already ran against; a first run takes the latest launch.
  const vault = o.vault ?? (o.fresh ? undefined : loadRecord<{ vault?: Address }>(lpProofPath(o.progress ?? `${o.records}-lp`))?.vault) ?? runtime.launches.at(-1)?.vault;
  if (!vault) throw new Error(`deployments/${o.records}.runtime.json records no launch`);
  let v = await readVaultView(ctx, vault);
  if (!isAddressEqual(v.people.issuer, me)) throw new Error(`${me} is not the issuer of ${vault} (${v.people.issuer}): the issuer funds the LP`);

  const path = lpProofPath(o.progress ?? `${o.records}-lp`);
  const prev = loadRecord<LpProofRecord>(path, o.fresh);
  if (prev && (!isAddressEqual(prev.vault, vault) || !isAddressEqual(prev.lp, lp))) {
    throw new Error(`${path} is an LP proof against ${prev.vault} by ${prev.lp}, not this one. Pass --fresh to start another.`);
  }
  const p: LpProofRecord = prev ?? { network: info.name, chainId, vault, token: v.token, issuer: me, lp, startedAtBlock: Number(await ctx.pub.getBlockNumber()), steps: {} };
  const { save, record, sending, landed } = runKit<LpStepKey>({ path, record: p, ctx, check: o.check, log });
  const onResume = "settled before the runner stopped, and recorded when it resumed";
  const sym = v.tokenSymbol;
  const eth = (pair: readonly [bigint, bigint]) => (v.quoteIs0 ? pair[0] : pair[1]);
  const tok = (pair: readonly [bigint, bigint]) => (v.quoteIs0 ? pair[1] : pair[0]);
  if (prev) log(`resuming the LP proof in ${path}`);
  log(`${info.name}: vault ${vault} (${sym}), issuer ${me}, LP ${lp}`);

  // What the LP needs: its slice of the vault's tokens for SHARE% new shares, with room to spare. (Its ETH comes with the
  // gas money: a 10% slice of a testnet vault is a few thousandths of an ETH.)
  const tokensNeeded = parseEther(((v.principal.token * Number(SHARE)) / 100 * 1.5 + 1).toFixed(18));
  if (o.check) {
    const opens = v.pace.setup ? `deposits open in about ${Math.ceil((v.pace.setupEndsAt - v.time) / 60)} min` : "deposits are open";
    log(`plan: fund the LP with ${formatEther(GAS_MONEY)} ETH and ${amt(tokensNeeded)} ${sym}; ${opens}; join for ${SHARE}% new shares, trade, collect, claim, leave`);
    return p;
  }
  save();

  // 1–2. The LP's means: gas money and the deposit's ETH, then the tokens.
  if (!p.steps.gas) {
    const title = "The issuer sends the LP gas money";
    const prior = await landed("gas");
    if (prior) record("gas", { title, status: "success", ...mined(prior.transactionHash, prior), detail: onResume });
    else if ((await ctx.pub.getBalance({ address: lp })) < GAS_MONEY / 2n) {
      const hash = await ctx.wallet("issuer").sendTransaction({ to: lp, value: GAS_MONEY } as never);
      sending("gas").onHash(hash);
      const receipt = await ctx.pub.waitForTransactionReceipt({ hash, pollingInterval: 1_000, timeout: 180_000 });
      record("gas", { title, status: "success", hash, block: Number(receipt.blockNumber), detail: `${formatEther(GAS_MONEY)} ETH to ${lp}` });
    }
  }
  if (!p.steps.tokens) {
    const title = `The issuer sends the LP ${sym}`;
    const prior = await landed("tokens");
    if (prior) record("tokens", { title, status: "success", ...mined(prior.transactionHash, prior), detail: onResume });
    else {
      const have = await ctx.pub.readContract({ address: v.token, abi: testTokenAbi, functionName: "balanceOf", args: [lp] });
      if (have < tokensNeeded) {
        const sent = must(
          await send(ctx, "issuer", { address: v.token, abi: testTokenAbi, functionName: "transfer", args: [lp, tokensNeeded - have] }, sending("tokens")),
          "the token transfer",
        );
        record("tokens", { title, status: "success", ...mined(sent.hash, sent.receipt), detail: `${amt(tokensNeeded - have)} ${sym} to ${lp}` });
      }
    }
  }

  // The setup epoch: deposits revert with SetupEpoch until it ends.
  if (!p.steps.join) {
    for (let jumped = false; ; ) {
      v = await readVaultView(ctx, vault);
      if (!v.pace.setup) break;
      const left = v.pace.setupEndsAt - v.time;
      if (o.warp) {
        if (jumped) throw new Error("still in the setup epoch after jumping over it");
        await rpc(rpcUrl, "evm_increaseTime", [left + 5]);
        await rpc(rpcUrl, "evm_mine", []);
        jumped = true;
        continue;
      }
      log(`  setup epoch: deposits open in about ${Math.max(1, Math.ceil(left / 60))} min`);
      await new Promise((r) => setTimeout(r, Math.min(60_000, Math.max(5_000, left * 1000 + 3_000))));
    }
  }

  // 3. The LP joins in kind: the same slice of every range, priced by simulating the deposit from its own address.
  if (!p.steps.join) {
    const title = "An outside LP joins in kind";
    const prior = await landed("join");
    if (prior) {
      const ev = vaultEvent(prior, vault, "Deposited") as { shares: bigint } | null;
      record("join", { title, status: "success", ...mined(prior.transactionHash, prior), value: ev?.shares.toString(), detail: onResume });
    } else {
      v = await readVaultView(ctx, vault);
      const shares = (v.raw.totalShares * SHARE) / 100n;
      await ensureAllowance(lpCtx, "lp", v, tokensNeeded);
      const spendable = (await ctx.pub.getBalance({ address: lp })) - parseEther("0.0005");
      const pre = await preflight(lpCtx, "lp", depositCall(v, shares, quoteBudget(v, Number(SHARE) / 100, spendable)), v);
      if (!pre.ok) throw new Error(`the deposit would revert: ${pre.error?.signature ?? "unknown"}. Nothing was sent.`);
      const [a0, a1] = pre.value as readonly [bigint, bigint];
      const call = { ...depositCall(v, shares, withSlack(a0)), args: [shares, withSlack(a0), withSlack(a1), NEVER] as const };
      const sent = must(await send(lpCtx, "lp", call, sending("join")), "the deposit");
      const ev = vaultEvent(sent.receipt, vault, "Deposited") as { shares: bigint; amount0: bigint; amount1: bigint } | null;
      const paid = ev ? ([ev.amount0, ev.amount1] as const) : ([a0, a1] as const);
      const of = Number(shares) / Number(v.raw.totalShares + shares);
      record("join", {
        title,
        status: "success",
        ...mined(sent.hash, sent.receipt),
        value: shares.toString(),
        detail: `${amt(eth(paid))} ETH and ${amt(tok(paid))} ${sym} for ${(of * 100).toFixed(1)}% of the vault's shares`,
      });
    }
  }

  // 4–5. Trades both ways, so the ranges earn fees in both currencies.
  if (!p.steps.buy) {
    const title = "The market buys";
    const prior = await landed("buy");
    if (prior) record("buy", { title, status: "success", ...mined(prior.transactionHash, prior), detail: onResume });
    else {
      v = await readVaultView(ctx, vault);
      const sent = must(await swap(ctx, v, "market", true, TRADE, undefined, sending("buy")), "the buy");
      record("buy", { title, status: "success", ...mined(sent.hash, sent.receipt), detail: `${formatEther(TRADE)} ETH of ${sym}, through PoolSwapTest` });
    }
  }
  if (!p.steps.sell) {
    const title = "The market sells";
    const prior = await landed("sell");
    if (prior) record("sell", { title, status: "success", ...mined(prior.transactionHash, prior), detail: onResume });
    else {
      v = await readVaultView(ctx, vault);
      const back = parseEther(((Number(formatEther(TRADE)) / priceAt(v.spotTick)) * 0.98).toFixed(18));
      const sent = must(await swap(ctx, v, "market", false, back, undefined, sending("sell")), "the sell");
      record("sell", { title, status: "success", ...mined(sent.hash, sent.receipt), detail: `${amt(back)} ${sym} back, about what the buy took` });
    }
  }

  // 6. Anyone realises the fees: the treasury's and the bounty pool's cut now, the shareholders' owed to them.
  if (!p.steps.collect) {
    const title = "Anyone collects the fees";
    const prior = await landed("collect");
    if (prior) record("collect", { title, status: "success", ...mined(prior.transactionHash, prior), detail: onResume });
    else {
      const sent = must(await send(ctx, "holder", { address: vault, abi: covenantVaultAbi, functionName: "collectFees", args: [] }, sending("collect")), "collectFees");
      const ev = vaultEvent(sent.receipt, vault, "FeesCollected") as { toTreasury0: bigint; toTreasury1: bigint; toBountyPool: bigint } | null;
      record("collect", {
        title,
        status: "success",
        ...mined(sent.hash, sent.receipt),
        // The bounty pool is topped up from the quote side first, so a small fee can all go there and none to the treasury.
        detail: ev
          ? `${amt(eth([ev.toTreasury0, ev.toTreasury1]))} ETH and ${amt(tok([ev.toTreasury0, ev.toTreasury1]))} ${sym} to the treasury, ${amt(ev.toBountyPool)} ETH to the bounty pool; the shareholders' part is owed to them`
          : "fees collected",
      });
    }
  }

  // 7. The LP's share of them.
  if (!p.steps.claim) {
    const title = "The LP claims its share of the fees";
    const prior = await landed("claim");
    if (prior) record("claim", { title, status: "success", ...mined(prior.transactionHash, prior), detail: onResume });
    else {
      const sent = must(await send(lpCtx, "lp", { address: vault, abi: covenantVaultAbi, functionName: "claimFees", args: [] }, sending("claim")), "claimFees");
      const ev = vaultEvent(sent.receipt, vault, "FeesClaimed") as { amount0: bigint; amount1: bigint } | null;
      record("claim", {
        title,
        status: "success",
        ...mined(sent.hash, sent.receipt),
        detail: ev ? `${amt(eth([ev.amount0, ev.amount1]))} ETH and ${amt(tok([ev.amount0, ev.amount1]))} ${sym}` : "fees claimed",
      });
    }
  }

  // 8. The LP leaves: every share burned for its slice of every range, in kind. Exits are never refused.
  if (!p.steps.leave) {
    const title = "The LP leaves in kind";
    const prior = await landed("leave");
    if (prior) record("leave", { title, status: "success", ...mined(prior.transactionHash, prior), detail: onResume });
    else {
      v = await readVaultView(ctx, vault);
      const held = await ctx.pub.readContract({ address: vault, abi: covenantVaultAbi, functionName: "sharesOf", args: [lp] });
      if (held === 0n) throw new Error("the LP holds no shares to withdraw");
      const out = { address: vault, abi: covenantVaultAbi, functionName: "withdraw" as const, args: [held, 0n, 0n, NEVER] as const };
      const pre = await preflight(lpCtx, "lp", out, v);
      if (!pre.ok) throw new Error(`the withdrawal would revert: ${pre.error?.signature ?? "unknown"}`);
      const [m0, m1] = pre.value as readonly [bigint, bigint];
      const sent = must(await send(lpCtx, "lp", { ...out, args: [held, (m0 * 995n) / 1000n, (m1 * 995n) / 1000n, NEVER] as const }, sending("leave")), "the withdrawal");
      const ev = vaultEvent(sent.receipt, vault, "Withdrawn") as { amount0: bigint; amount1: bigint } | null;
      const got = ev ? ([ev.amount0, ev.amount1] as const) : ([m0, m1] as const);
      record("leave", {
        title,
        status: "success",
        ...mined(sent.hash, sent.receipt),
        value: held.toString(),
        detail: `every share burned for ${amt(eth(got))} ETH and ${amt(tok(got))} ${sym}`,
      });
    }
  }

  p.finishedAtBlock ??= Number(await ctx.pub.getBlockNumber());
  save();
  if (o.recordSpan) {
    // Only the blocks holding the vault's events and the swaps are kept for the feed; the transfers leave none there.
    const rpath = runtimePath(o.records);
    const rt = JSON.parse(readFileSync(rpath, "utf8")) as Runtime;
    const launch = rt.launches.find((l) => isAddressEqual(l.vault, vault));
    if (launch) {
      const blocks = (["join", "buy", "sell", "collect", "claim", "leave"] as const).map((k) => p.steps[k]?.block).filter((b): b is number => !!b);
      launch.spans = mergeSpans(launch.spans ?? [], blocks);
      writeFileSync(rpath, JSON.stringify(rt, null, 2) + "\n");
      log(`kept blocks ${launch.spans.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ")} in ${rpath}`);
    }
  }
  log(`LP proof complete: ${path}`);
  return p;
}

