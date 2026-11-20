// The lifecycle proof: every power a vault hands out, used for real on Base Sepolia and either settled or refused by
// the chain, plus the attacks that need time to play. Behind `npm run proof -- --lifecycle --vault 0x…`.
//
// It runs against a vault launched with quick clocks (scripts/launch-public.ts --timelock 900 --lock 1800 --vest 1800
// --epoch 3600): the same Standard rules, but a curator change takes 15 minutes rather than two days, and the principal
// unlocks over an hour rather than four months. So the handovers and the principal's exit settle within one sitting,
// and the pump-ratchet's "four days of syncs" is four of its one-hour epochs.
//
// T0 is adoption. In order, each step pre-flighted before it is sent (a refusal is sent only when the pre-flight gives
// the error the covenant is meant to give; a step that should settle and would not stops the run, nothing sent):
//
//   setup epoch (T0 to T0+1h: no deposits, Pace not yet enforced)
//     lockedEarly       the issuer takes all its principal                        Locked
//     propose1, cancel  the issuer proposes a curator, then withdraws it           settle
//     propose           and proposes it again                                      settles: the timelock starts
//     acceptEarly       a stranger accepts at once                                 TimelockActive
//     transferIssuer    the issuer hands its role to a second key                  settles
//     strangerIssuer    a stranger tries to take it                                NotPendingIssuer
//     acceptIssuer      the second key accepts, transferBack, issuerBack           settle: the issuer role goes there and back
//     flashSell/Buy     a 5,000-tick dump and its buy-back, in one block or second settle, and the TWAP does not move
//     flashCheck        the curator's 1-wei reshape                                settles: the guard was not fooled
//     accept            once the timelock has run, a stranger accepts              settles: the new curator is in place
//     newCuratorRug     the new curator moves the support away                     SupportBroken
//     curatorShares     the new curator withdraws shares it does not hold          InsufficientShares
//     curatorPrincipal  and asks for the issuer's principal                        NotIssuer
//   after the setup epoch, principal vested
//     principalOut      the issuer takes a quarter of its principal                settles, to the treasury
//     lpJoin            an outside LP joins for a tenth                            settles
//     dump              the price is pushed 2,500 ticks down                       settles: the guard trips
//     guardReshape, guardDeposit, guardRestore                                     PriceGuard, all three
//     lpExitTripped     the LP leaves while the guard is tripped                   settles: exits are never frozen
//     buyBack           the price is bought back                                   settles
//   the pump-ratchet (an attacker's own key)
//     pump              buy every ask, 30,000 ticks up through empty ticks         settles
//     quickRestore      two hours later, no syncs: restore                         NothingToRestore
//     poke1..           a keeper syncs the Anchor every 25 minutes                 settle: it climbs a band per epoch at most
//     patientRestore    once the band has floated above every price the vault sold at: restore   RestoreBandEmpty
//     sellBack          the attacker sells everything back                         settles: a loss, the fees stay with the vault
//   wrap-up
//     curatorFees, collect, lpClaim                                                settle

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Abi, type Address, type Hex, formatEther, isAddressEqual, parseEther } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { covenantVaultAbi, testTokenAbi } from "../../src/chain/abi.generated";
import { type ChainCtx, type ExternalSigner, createChainCtx } from "../../src/chain/client";
import { decodeRevert } from "../../src/chain/errors";
import { NEVER } from "../../src/chain/launch";
import { mergeSpans } from "../../src/chain/logs";
import { paidIn0, pushTo, swap, swapCall } from "../../src/chain/market";
import { NETWORKS, type Runtime, networkOf, parseManifest } from "../../src/chain/network";
import { priceAt } from "../../src/chain/price";
import { depositCall, ensureAllowance, quoteBudget, withSlack } from "../../src/chain/provide";
import { curatorPrincipalCall, curatorSharesCall, farmCall, nudgeCall, softRugCall, vaultCall } from "../../src/chain/scenarios/attackcalls";
import { type Outcome, must, send, simulate } from "../../src/chain/tx";
import { type VaultView, readVaultView } from "../../src/chain/view";
import { ROOT, manifestPath, rpc, runtimePath } from "./localchain";
import { type RunStep, hold, loadRecord, mined, runKit, type RunRecord, vaultEvent } from "./runkit";

const POKES = 14;
type PokeKey = `poke${number}`;
export type LifecycleStepKey =
  | "gas"
  | "lockedEarly"
  | "propose1"
  | "cancel"
  | "propose"
  | "acceptEarly"
  | "transferIssuer"
  | "strangerIssuer"
  | "acceptIssuer"
  | "transferBack"
  | "issuerBack"
  | "flashSell"
  | "flashBuy"
  | "flashCheck"
  | "accept"
  | "newCuratorRug"
  | "curatorShares"
  | "curatorPrincipal"
  | "principalOut"
  | "lpFunds"
  | "lpJoin"
  | "dump"
  | "guardReshape"
  | "guardDeposit"
  | "guardRestore"
  | "lpExitTripped"
  | "buyBack"
  | "attackerFunds"
  | "pump"
  | "quickRestore"
  | PokeKey
  | "patientRestore"
  | "sellBack"
  | "curatorFees"
  | "collect"
  | "lpClaim";

export interface LifecycleProofRecord extends RunRecord<LifecycleStepKey> {
  network: string;
  chainId: number;
  vault: Address;
  token: Address;
  /** The issuer (and, until the handover, the curator and the treasury). */
  signer: Address;
  keeper: Address;
  lp: Address;
  curator2: Address;
  issuer2: Address;
  attacker: Address;
  startedAtBlock: number;
  finishedAtBlock?: number;
  /** What later steps need from earlier ones, kept so a resumed run picks up where it left off. */
  marks: {
    homeTick?: number;
    pumpAt?: number;
    tokensBought?: string;
    attackerEthBefore?: string;
    lastPokeAt?: number;
  };
}

export interface LifecycleProofOptions {
  net: "base-sepolia" | "base-sepolia-fork";
  records: string;
  /** The proof's own record, deployments/<progress>.proof.json (`<records>-lifecycle` by default). */
  progress?: string;
  rpcUrl?: string;
  /** The vault's issuer, curator and treasury at the start. */
  signer: ExternalSigner;
  keeper: PrivateKeyAccount;
  lp: PrivateKeyAccount;
  /** The curator proposed and accepted. */
  curator2: PrivateKeyAccount;
  /** The interim issuer, who hands the role back. */
  issuer2: PrivateKeyAccount;
  /** The pump-ratchet's attacker. */
  attacker: PrivateKeyAccount;
  vault: Address;
  /** The most ETH the pump may spend. */
  maxPump?: bigint;
  /** Jump time instead of waiting (a fork only). */
  warp?: boolean;
  recordSpan?: boolean;
  check?: boolean;
  fresh?: boolean;
  log?: (line: string) => void;
}

export const lifecycleProofPath = (name: string) => join(ROOT, "deployments", `${name}.proof.json`);

const GAS_MONEY = parseEther("0.0015");
const GAS_FLOOR = parseEther("0.0008");
const RESERVE = parseEther("0.003");
const ONE = 10n ** 18n;
const PUMP_TICKS = 30_000;
const FLASH_TICKS = 5_000;
const DUMP_TICKS = 2_500;
const QUICK_HOLD_S = 2 * 3600;
const POKE_EVERY_S = 25 * 60;

const pct = (bps: unknown) => `${(Number(bps ?? 0) / 100).toFixed(1)}%`;
const amt = (wei: bigint) => {
  const x = Number(formatEther(wei < 0n ? -wei : wei));
  const s = x === 0 ? "0" : x < 1e-4 ? x.toFixed(12).replace(/0+$/, "") : x >= 100 ? x.toFixed(0) : x >= 1 ? x.toFixed(2) : x.toPrecision(3);
  return wei < 0n ? `-${s}` : s;
};
const fmt = (ethPerToken: number) => ethPerToken.toPrecision(4);
const pokeKey = (i: number) => `poke${i}` as PokeKey;
/** AttackCatalogue's restore argument: every range with any part under the price. */
const underSpot = (v: VaultView) => v.ranges.filter((r) => r.priceLower < v.spotTick).map((r) => BigInt(r.index));
const restoreUnderSpot = (v: VaultView) => vaultCall(v, "restore", [underSpot(v), NEVER]);

export async function runLifecycleProof(o: LifecycleProofOptions): Promise<LifecycleProofRecord> {
  const log = o.log ?? (() => {});
  const info = NETWORKS[o.net];
  const manifest = parseManifest(JSON.parse(readFileSync(manifestPath(o.records), "utf8")));
  const runtime = JSON.parse(readFileSync(runtimePath(o.records), "utf8")) as Runtime;
  const rpcUrl = o.rpcUrl ?? info.defaultRpc;
  const net = networkOf(o.net, rpcUrl, manifest, runtime);
  const ctx = createChainCtx(net, o.signer);
  const keeperCtx = createChainCtx(net, { account: o.keeper });
  const lpCtx = createChainCtx(net, { account: o.lp });
  const cur2Ctx = createChainCtx(net, { account: o.curator2 });
  const iss2Ctx = createChainCtx(net, { account: o.issuer2 });
  const atkCtx = createChainCtx(net, { account: o.attacker });
  const me = ctx.signer as Address;
  const vault = o.vault;
  const warp = o.warp ? { rpcUrl } : undefined;
  const maxPump = o.maxPump ?? parseEther("0.3");
  /** How far a fork jumps while waiting on the guard: the TWAP needs over an hour to follow a 30,000-tick move. */
  const guardStep = o.warp ? 600 : 60;

  const chainId = await ctx.pub.getChainId();
  if (chainId !== info.chainId) throw new Error(`the RPC answers as chain ${chainId}, not ${info.name} (${info.chainId})`);
  let v = await readVaultView(ctx, vault);
  const view = async () => (v = await readVaultView(ctx, vault));

  const path = lifecycleProofPath(o.progress ?? `${o.records}-lifecycle`);
  const prev = loadRecord<LifecycleProofRecord>(path, o.fresh);
  if (prev && (!isAddressEqual(prev.vault, vault) || !isAddressEqual(prev.signer, me))) {
    throw new Error(`${path} is a lifecycle proof against ${prev.vault} by ${prev.signer}, not this one. Pass --fresh to start another.`);
  }
  if (!prev && (!isAddressEqual(v.people.issuer, me) || !isAddressEqual(v.people.curator, me))) {
    throw new Error(`${me} is not the issuer and curator of ${vault} (issuer ${v.people.issuer}, curator ${v.people.curator})`);
  }
  const p: LifecycleProofRecord = prev ?? {
    network: info.name,
    chainId,
    vault,
    token: v.token,
    signer: me,
    keeper: o.keeper.address,
    lp: o.lp.address,
    curator2: o.curator2.address,
    issuer2: o.issuer2.address,
    attacker: o.attacker.address,
    startedAtBlock: Number(await ctx.pub.getBlockNumber()),
    steps: {},
    marks: {},
  };
  p.marks ??= {};
  const kit = runKit<LifecycleStepKey>({
    path,
    record: p,
    ctx,
    check: o.check,
    log,
  });
  const { refuse, settle } = kit;
  const describe = () => ({
    now: v.time + 1,
    quoteSymbol: v.quoteSymbol,
    tokenSymbol: v.tokenSymbol,
  });
  const sym = v.tokenSymbol;
  const tokensOf = (who: Address) =>
    ctx.pub.readContract({
      address: v.token,
      abi: testTokenAbi,
      functionName: "balanceOf",
      args: [who],
    });
  const sharesOf = (who: Address) =>
    ctx.pub.readContract({
      address: vault,
      abi: covenantVaultAbi,
      functionName: "sharesOf",
      args: [who],
    });
  const ethOf = (who: Address) => ctx.pub.getBalance({ address: who });
  const t = v.terms;
  if (prev) log(`resuming the lifecycle proof in ${path}`);
  log(`${info.name}: vault ${vault} (${sym}); timelock ${t.curatorTimelock} s, lock ${t.lockDuration} s, vest ${t.vestDuration} s, epoch ${t.epochLength} s`);
  log(
    `  issuer ${me}, keeper ${o.keeper.address}, LP ${o.lp.address}, curator2 ${o.curator2.address}, issuer2 ${o.issuer2.address}, attacker ${o.attacker.address}`,
  );
  if (!o.warp && (t.curatorTimelock > 3600 || t.lockDuration + t.vestDuration > 4 * 3600)) {
    throw new Error("this vault's clocks are Standard: the lifecycle proof needs a vault launched with --timelock, --lock and --vest (see the header)");
  }

  if (o.check) {
    await checkPumpPlan(ctx, v, o.keeper.address, maxPump, log);
    return p;
  }
  kit.save();

  // ----------------------------------------------------------------------------------------------- the helpers' means
  if (!p.steps.gas) {
    const need = [o.keeper.address, o.curator2.address, o.issuer2.address];
    const short: Address[] = [];
    for (const a of need) if ((await ethOf(a)) < GAS_FLOOR) short.push(a);
    const prior = await kit.landed("gas");
    if (prior)
      kit.record("gas", {
        title: "Gas money for the helpers",
        status: "success",
        ...mined(prior.transactionHash, prior),
        detail: kit.onResume,
      });
    else if (short.length) {
      let last: { hash: Hex; block: number } | null = null;
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

  // ----------------------------------------------------------------------------------------------- the setup epoch
  await view();
  await refuse("lockedEarly", {
    ctx,
    call: vaultCall(v, "withdrawPrincipal", [ONE, 0n, 0n, NEVER]),
    title: "The issuer takes all its principal, before it has vested",
    expect: ["Locked"],
    describe,
    detail: (e) => `${e.signature}: ${e.reason}`,
  });

  const propose = (title: string) => ({
    ctx,
    call: vaultCall(v, "proposeCurator", [o.curator2.address]),
    title,
    describe,
  });
  await settle("propose1", {
    ...propose("The issuer proposes a new curator"),
    detail: () => `the timelock starts: ${t.curatorTimelock / 60} minutes, in public`,
  });
  await settle("cancel", {
    ctx,
    call: vaultCall(v, "cancelCuratorProposal", []),
    title: "The issuer withdraws the proposal",
    detail: () => "nothing changes: the curator stays",
  });
  await settle("propose", {
    ...propose("The issuer proposes the new curator again"),
    detail: async () => {
      await view();
      return `${o.curator2.address} may take over from ${new Date(v.people.curatorReadyAt * 1000).toISOString().slice(11, 16)} UTC, ${t.curatorTimelock / 60} minutes on`;
    },
  });
  await refuse("acceptEarly", {
    ctx: keeperCtx,
    call: vaultCall(v, "acceptCurator", []),
    title: "A stranger accepts the change at once",
    expect: ["TimelockActive"],
    describe,
  });

  await settle("transferIssuer", {
    ctx,
    call: vaultCall(v, "transferIssuer", [o.issuer2.address]),
    title: "The issuer hands its role to a second key",
    detail: () => `pending until ${o.issuer2.address} accepts`,
  });
  await refuse("strangerIssuer", {
    ctx: keeperCtx,
    call: vaultCall(v, "acceptIssuer", []),
    title: "A stranger tries to take the issuer role",
    expect: ["NotPendingIssuer"],
    describe,
  });
  await settle("acceptIssuer", {
    ctx: iss2Ctx,
    call: vaultCall(v, "acceptIssuer", []),
    title: "The second key accepts the issuer role",
    detail: () => `${o.issuer2.address} is the issuer`,
  });
  await settle("transferBack", {
    ctx: iss2Ctx,
    call: vaultCall(v, "transferIssuer", [me]),
    title: "It hands the role back",
    detail: () => `pending until ${me} accepts`,
  });
  await settle("issuerBack", {
    ctx,
    call: vaultCall(v, "acceptIssuer", []),
    title: "The original issuer accepts it back",
    detail: () => `${me} is the issuer again`,
  });

  // The flash round trip: the oracle keys on seconds, so a dump and its buy-back inside one second leave the average
  // exactly where it was. Two transactions in a row with consecutive nonces, sent together; retried if they straddle
  // a second.
  if (!p.steps.flashSell || !p.steps.flashBuy) await flashRoundTrip();
  await view();
  if (!isAddressEqual(v.people.curator, me) && !p.steps.flashCheck)
    throw new Error("the curator changed before the flash check: it is the issuer-curator's reshape");
  await settle("flashCheck", {
    ctx,
    call: nudgeCall(v),
    title: "The curator reshapes: is the guard fooled?",
    detail: async () => `the guard passes: as far as the average is concerned nothing happened (TWAP ${(await view()).twap})`,
  });

  // The timelock runs out; a stranger completes the change.
  if (!p.steps.accept) {
    await hold({
      label: "waiting for the curator timelock",
      warp,
      log,
      check: async () => (
        await view(),
        {
          done: v.time >= v.people.curatorReadyAt || isAddressEqual(v.people.curator, o.curator2.address),
          left: v.people.curatorReadyAt - v.time,
        }
      ),
    });
  }
  await settle("accept", {
    ctx: keeperCtx,
    call: vaultCall(v, "acceptCurator", []),
    title: "A stranger accepts once the timelock has run",
    detail: () => `${o.curator2.address} is the curator`,
  });
  await view();
  await refuse("newCuratorRug", {
    ctx: cur2Ctx,
    call: softRugCall(v),
    title: "The new curator moves the support away",
    expect: ["SupportBroken"],
    describe,
    detail: (e) => `${e.signature}: support would have been ${pct(e.args[0])}, the covenant needs ${pct(e.args[1])}. A new curator is bound by the same rules`,
  });
  await refuse("curatorShares", {
    ctx: cur2Ctx,
    call: curatorSharesCall(v),
    title: "The new curator withdraws shares it does not hold",
    expect: ["InsufficientShares"],
    describe,
  });
  await refuse("curatorPrincipal", {
    ctx: cur2Ctx,
    call: curatorPrincipalCall(v),
    title: "The new curator asks for the issuer's principal",
    expect: ["NotIssuer"],
    describe,
  });

  // ----------------------------------------------------------------------------------------------- vested, setup over
  if (!p.steps.principalOut || !p.steps.lpJoin) {
    await hold({
      label: "waiting for the setup epoch to end and the principal to vest",
      warp,
      log,
      check: async () => (
        await view(),
        {
          done: v.time > v.pace.setupEndsAt && v.time >= v.lock.fullyVestedAt,
          left: Math.max(v.pace.setupEndsAt + 1, v.lock.fullyVestedAt) - v.time,
        }
      ),
    });
  }
  await settle("principalOut", {
    ctx,
    call: vaultCall(v, "withdrawPrincipal", [ONE / 4n, 0n, 0n, NEVER]),
    title: "The issuer takes a quarter of its vested principal",
    detail: (out) => {
      const ev = vaultEvent(out.receipt, vault, "PrincipalWithdrawn") as {
        amount0: bigint;
        amount1: bigint;
      } | null;
      if (!ev) return "withdrawn to the treasury";
      const [q, tk] = v.quoteIs0 ? [ev.amount0, ev.amount1] : [ev.amount1, ev.amount0];
      return `${amt(q)} ETH and ${amt(tk)} ${sym} to the treasury: a proportional slice of every range, so the shape and support are unchanged`;
    },
  });

  // An outside LP joins: tokens and ETH from the issuer first.
  await view();
  const lpTokens = parseEther((v.principal.token * 0.1 * 1.5 + 1).toFixed(18));
  const lpEth = parseEther((v.principal.quote * 0.1 * 2).toFixed(18)) + 2n * GAS_MONEY;
  if (!p.steps.lpFunds) {
    const prior = await kit.landed("lpFunds");
    if (prior)
      kit.record("lpFunds", {
        title: "The issuer funds the LP",
        status: "success",
        ...mined(prior.transactionHash, prior),
        detail: kit.onResume,
      });
    else {
      const [haveT, haveE] = await Promise.all([tokensOf(o.lp.address), ethOf(o.lp.address)]);
      let last: { hash: Hex; block: number } | null = null;
      if (haveE < lpEth) {
        const hash = await ctx.wallet("issuer").sendTransaction({ to: o.lp.address, value: lpEth - haveE } as never);
        const r = await ctx.pub.waitForTransactionReceipt({
          hash,
          pollingInterval: 1_000,
          timeout: 180_000,
        });
        last = { hash, block: Number(r.blockNumber) };
      }
      if (haveT < lpTokens) {
        const out = must(
          await send(
            ctx,
            me,
            {
              address: v.token,
              abi: testTokenAbi,
              functionName: "transfer",
              args: [o.lp.address, lpTokens - haveT],
            },
            kit.sending("lpFunds"),
          ),
          "the LP's tokens",
        );
        last = mined(out.hash, out.receipt);
      }
      if (last)
        kit.record("lpFunds", {
          title: "The issuer funds the LP",
          status: "success",
          ...last,
          detail: `${amt(lpTokens)} ${sym} and ${amt(lpEth)} ETH to ${o.lp.address}`,
        });
    }
  }
  if (!p.steps.lpJoin) {
    await view();
    await ensureAllowance(lpCtx, o.lp.address, v, lpTokens, true);
    const shares = v.raw.totalShares / 10n;
    const budget = quoteBudget(v, 0.1, (await ethOf(o.lp.address)) - GAS_FLOOR);
    const pre = await simulate(lpCtx, o.lp.address, depositCall(v, shares, budget), describe());
    if (!pre.ok) throw new Error(`the LP's deposit would be refused: ${pre.error?.signature}. Nothing was sent.`);
    const [a0, a1] = pre.value as readonly [bigint, bigint];
    const quote = v.quoteIs0 ? a0 : a1;
    await settle("lpJoin", {
      ctx: lpCtx,
      call: depositCall(v, shares, withSlack(quote)),
      title: "An outside LP joins for a tenth of the vault",
      detail: () => `${amt(quote)} ETH and ${amt(v.quoteIs0 ? a1 : a0)} ${sym}: a tenth of every range, in kind`,
    });
  }

  // The dump, then the guard's refusals and the exit it never blocks, then the buy-back, quickly: the longer the price
  // sits down, the further the TWAP follows it.
  if (!p.steps.buyBack) {
    await view();
    p.marks.homeTick ??= v.spotTick;
    kit.save();
    if (!p.steps.dump) {
      const before = v.spotTick;
      const prior = await kit.landed("dump");
      const out = prior
        ? ({ hash: prior.transactionHash, receipt: prior } as Outcome)
        : must(await pushTo(ctx, v, "issuer", v.spotTick - DUMP_TICKS, await tokensOf(me), kit.sending("dump")), "the dump");
      await view();
      kit.record("dump", {
        title: "The price is pushed 2,500 ticks down",
        status: "success",
        ...mined(out.hash, out.receipt),
        detail: `spot ${before} → ${v.spotTick}, ${Math.round(v.guard.diff)} ticks from the TWAP (the guard allows ${v.guard.limit})`,
      });
    }
    await view();
    if (!p.steps.guardReshape || !p.steps.guardDeposit || !p.steps.guardRestore) {
      if (v.guard.ok) throw new Error("the guard passes after the dump: nothing for it to refuse");
      const lpBudget = quoteBudget(v, 0.1, (await ethOf(o.lp.address)) - GAS_FLOOR);
      // Three keys, three refusals, at once.
      await Promise.all([
        refuse("guardReshape", {
          ctx: cur2Ctx,
          call: nudgeCall(v),
          title: "The curator reshapes at the manipulated price",
          expect: ["PriceGuard"],
          describe,
        }),
        refuse("guardDeposit", {
          ctx: lpCtx,
          call: depositCall(v, v.raw.totalShares / 10n, lpBudget),
          title: "The LP deposits at the manipulated price",
          expect: ["PriceGuard"],
          describe,
        }),
        refuse("guardRestore", {
          ctx: keeperCtx,
          call: farmCall(v),
          title: "A keeper calls restore at the manipulated price",
          expect: ["PriceGuard"],
          describe,
        }),
      ]);
    }
    if (!p.steps.lpExitTripped) {
      const shares = await sharesOf(o.lp.address);
      await settle("lpExitTripped", {
        ctx: lpCtx,
        call: vaultCall(v, "withdraw", [shares, 0n, 0n, NEVER]),
        title: "The LP leaves while the guard is tripped",
        detail: async () =>
          `every share out, with spot ${Math.round((await view()).guard.diff)} ticks from the TWAP: exits are never guarded, a proportional burn cannot be priced wrong`,
      });
    }
    const home = p.marks.homeTick;
    const out = p.steps.buyBack
      ? null
      : await (async () => {
          const prior = await kit.landed("buyBack");
          if (prior) return { hash: prior.transactionHash, receipt: prior } as Outcome;
          await view();
          return must(await pushTo(ctx, v, "issuer", home, (await ethOf(me)) - RESERVE, kit.sending("buyBack")), "the buy-back");
        })();
    if (out) {
      await view();
      kit.record("buyBack", {
        title: "The price is bought back",
        status: "success",
        ...mined(out.hash, out.receipt),
        detail: `spot back to ${v.spotTick} (it was ${home})`,
      });
    }
  }

  // ----------------------------------------------------------------------------------------------- the pump-ratchet
  if (!p.steps.pump) {
    await hold({
      label: "waiting for the guard to pass after the buy-back",
      warp,
      log,
      check: async () => (
        await view(),
        {
          done: v.guard.ok,
          left: guardStep,
          note: `spot ${Math.round(v.guard.diff)} ticks from the TWAP`,
        }
      ),
    });
    await checkPumpPlan(ctx, v, o.keeper.address, maxPump, log);
    // The attacker's own ETH: what the pump costs, with room for gas.
    if (!p.steps.attackerFunds) {
      const cost = await pumpCost(ctx, v, maxPump);
      const want = cost + cost / 5n + GAS_MONEY;
      const have = await ethOf(o.attacker.address);
      const prior = await kit.landed("attackerFunds");
      if (prior)
        kit.record("attackerFunds", {
          title: "The attacker's ETH",
          status: "success",
          ...mined(prior.transactionHash, prior),
          detail: kit.onResume,
        });
      else if (have < want) {
        const hash = await ctx.wallet("issuer").sendTransaction({
          to: o.attacker.address,
          value: want - have,
        } as never);
        kit.sending("attackerFunds").onHash(hash);
        const r = await ctx.pub.waitForTransactionReceipt({
          hash,
          pollingInterval: 1_000,
          timeout: 180_000,
        });
        kit.record("attackerFunds", {
          title: "The attacker's ETH",
          status: "success",
          hash,
          block: Number(r.blockNumber),
          detail: `${amt(want - have)} ETH: the pump costs about ${amt(cost)}`,
        });
      }
    }
    await view();
    p.marks.attackerEthBefore ??= (await ethOf(o.attacker.address)).toString();
    const tokensBefore = await tokensOf(o.attacker.address);
    const before = v.spotTick;
    const prior = await kit.landed("pump");
    const out = prior
      ? ({ hash: prior.transactionHash, receipt: prior } as Outcome)
      : await (async () => {
          const spendable = (await ethOf(o.attacker.address)) - RESERVE;
          return must(await pushTo(atkCtx, v, "attacker", v.spotTick + PUMP_TICKS, spendable < maxPump ? spendable : maxPump, kit.sending("pump")), "the pump");
        })();
    await view();
    const bought = (await tokensOf(o.attacker.address)) - tokensBefore;
    p.marks.tokensBought = bought.toString();
    p.marks.pumpAt = Number((await ctx.pub.getBlock({ blockNumber: out.receipt?.blockNumber })).timestamp);
    kit.record("pump", {
      title: "The attacker buys every ask and pushes 30,000 ticks up",
      status: "success",
      ...mined(out.hash, out.receipt),
      detail: `${amt(bought)} ${sym} bought; price ${fmt(priceAt(before))} → ${fmt(priceAt(v.spotTick))} ETH, through empty ticks`,
    });
  }

  // Two hours, nobody syncs the Anchor: the TWAP has followed the pump, but support still counts the filled asks.
  if (!p.steps.quickRestore) {
    const at = p.marks.pumpAt ?? 0;
    await hold({
      label: "holding the pump, nobody syncing",
      warp,
      log,
      check: async () => (
        await view(),
        {
          done: v.time >= at + QUICK_HOLD_S && v.guard.ok,
          left: Math.max(60, at + QUICK_HOLD_S - v.time),
          note: `support ${pct(v.support.have)}, Anchor ${v.anchor}`,
        }
      ),
    });
    await refuse("quickRestore", {
      ctx: keeperCtx,
      call: restoreUnderSpot(v),
      title: "Two hours on, a restore to drag the bids up under the pump",
      expect: ["NothingToRestore"],
      describe,
      detail: (e) =>
        `${e.signature}: support still reads ${pct(e.args[0])} against ${pct(e.args[1])}: the asks the attacker bought are quote just under the old price, and they count`,
    });
    p.marks.lastPokeAt ??= p.marks.pumpAt;
    kit.save();
  }

  // Held longer, with the Anchor synced every 25 minutes: it climbs at most a band per epoch. Once the band has floated
  // above every price the vault ever sold at, support reads as lapsed, but restore has nowhere honest to bid.
  if (!p.steps.patientRestore) {
    for (let i = 1; i <= POKES; i++) {
      const key = pokeKey(i);
      if (!p.steps[key]) {
        const last = p.marks.lastPokeAt ?? 0;
        await hold({
          label: `holding the pump, next sync (${i})`,
          warp,
          log,
          check: async () => (
            await view(),
            {
              done: v.time >= last + POKE_EVERY_S,
              left: last + POKE_EVERY_S - v.time,
              note: `Anchor ${v.anchor}, support ${pct(v.support.have)}`,
            }
          ),
        });
        const step: RunStep = await settle(key, {
          ctx: keeperCtx,
          call: vaultCall(v, "poke", []),
          title: `A keeper syncs the Anchor (${i})`,
          detail: async () =>
            `the Anchor is committed at tick ${(await view()).anchor}, ${v.anchor - (p.marks.homeTick ?? v.anchor)} above where the pump began; support reads ${pct(v.support.have)}`,
        });
        p.marks.lastPokeAt = Number((await ctx.pub.getBlock({ blockNumber: BigInt(step.block) })).timestamp);
        kit.save();
      }
      await view();
      const pre = await simulate(keeperCtx, o.keeper.address, restoreUnderSpot(v) as never, describe());
      log(
        `  after sync ${i}: Anchor ${v.anchor}, support ${pct(v.support.have)}; a restore now would ${pre.ok ? "settle" : `be refused with ${pre.error?.signature}`}`,
      );
      if (!pre.ok && pre.error?.name === "RestoreBandEmpty") break;
      if (i === POKES)
        throw new Error(
          `after ${POKES} syncs restore still answers ${pre.ok ? "that it would settle" : pre.error?.signature}, not RestoreBandEmpty. Nothing more was sent.`,
        );
    }
    await refuse("patientRestore", {
      ctx: keeperCtx,
      call: restoreUnderSpot(v),
      title: `Held ${((v.time - (p.marks.pumpAt ?? v.time)) / 3600).toFixed(1)} hours (${((v.time - (p.marks.pumpAt ?? v.time)) / t.epochLength).toFixed(1)} epochs), synced: a restore to drag the bids up`,
      expect: ["RestoreBandEmpty"],
      describe,
      detail: (e) =>
        `${e.signature}: support reads ${pct(v.support.have)}, lapsed, but the band sits above every price the vault has sold at. Restore refuses rather than chase the pump`,
    });
  }

  if (!p.steps.sellBack) {
    await view();
    const bought = BigInt(p.marks.tokensBought ?? "0");
    const before = v.spotTick;
    const prior = await kit.landed("sellBack");
    const out = prior
      ? ({ hash: prior.transactionHash, receipt: prior } as Outcome)
      : must(await swap(atkCtx, v, "attacker", false, bought, undefined, kit.sending("sellBack")), "the sell-back");
    await view();
    const pnl = (await ethOf(o.attacker.address)) - BigInt(p.marks.attackerEthBefore ?? "0");
    kit.record("sellBack", {
      title: "The attacker sells everything back",
      status: "success",
      ...mined(out.hash, out.receipt),
      value: pnl.toString(),
      detail: `${amt(bought)} ${sym} sold, price ${fmt(priceAt(before))} → ${fmt(priceAt(v.spotTick))} ETH. The attacker ends ${pnl < 0n ? "" : "+"}${amt(pnl)} ETH, gas included: the swap fees stay with the vault`,
    });
  }

  // ----------------------------------------------------------------------------------------------- wrap-up
  if (!p.steps.curatorFees) {
    await hold({
      label: "waiting for the guard to pass after the sell-back",
      warp,
      log,
      check: async () => (
        await view(),
        {
          done: v.guard.ok,
          left: guardStep,
          note: `spot ${Math.round(v.guard.diff)} ticks from the TWAP`,
        }
      ),
    });
  }
  const feeDetail = (name: string, to: string) => (out: Outcome) => {
    const ev = vaultEvent(out.receipt, vault, name) as {
      amount0?: bigint;
      amount1?: bigint;
      toTreasury0?: bigint;
      toTreasury1?: bigint;
    } | null;
    const a0 = ev?.amount0 ?? ev?.toTreasury0 ?? 0n;
    const a1 = ev?.amount1 ?? ev?.toTreasury1 ?? 0n;
    const [q, tk] = v.quoteIs0 ? [a0, a1] : [a1, a0];
    return `${amt(q)} ETH and ${amt(tk)} ${sym} to ${to}`;
  };
  await settle("curatorFees", {
    ctx: cur2Ctx,
    call: vaultCall(v, "claimCuratorFees", []),
    title: "The new curator claims its fee share",
    detail: feeDetail("CuratorFeesClaimed", "the curator"),
  });
  await settle("collect", {
    ctx: keeperCtx,
    call: vaultCall(v, "collectFees", []),
    title: "A stranger collects the principal's fees",
    detail: feeDetail("FeesCollected", "the treasury"),
  });
  await settle("lpClaim", {
    ctx: lpCtx,
    call: vaultCall(v, "claimFees", []),
    title: "The LP claims what it earned while it held",
    detail: feeDetail("FeesClaimed", "the LP"),
  });

  p.finishedAtBlock ??= Number(await ctx.pub.getBlockNumber());
  kit.save();
  if (o.recordSpan) {
    const rpath = runtimePath(o.records);
    const rt = JSON.parse(readFileSync(rpath, "utf8")) as Runtime;
    const launch = rt.launches.find((l) => isAddressEqual(l.vault, vault));
    if (launch) {
      const blocks = Object.values(p.steps)
        .filter((s): s is RunStep => !!s && s.status === "success" && s.block > 0)
        .map((s) => s.block);
      launch.spans = mergeSpans(launch.spans ?? [], blocks);
      writeFileSync(rpath, JSON.stringify(rt, null, 2) + "\n");
    }
  }
  log(`lifecycle proof complete: ${path}`);
  return p;

  // --------------------------------------------------------------------------------------------- the flash, in detail
  async function flashRoundTrip() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await view();
      const home = v.spotTick;
      const twapBefore = v.twap;
      const tokens = await tokensOf(me);
      const sell = swapCall(ctx, v, false, tokens / 2n, home - FLASH_TICKS);
      const buyBudget = (await ethOf(me)) - RESERVE;
      const buy = swapCall(ctx, v, true, buyBudget, home);
      // Both, in one simulated block: the sell's tokens, the buy-back's ETH, each one's gas.
      const latest = await ctx.pub.getBlock({ blockTag: "latest" });
      const router = ctx.net.manifest.swapRouter as Address;
      const allowance = await ctx.pub.readContract({
        address: v.token,
        abi: testTokenAbi,
        functionName: "allowance",
        args: [me, router],
      });
      if (allowance < tokens / 2n)
        must(
          await send(ctx, me, {
            address: v.token,
            abi: testTokenAbi,
            functionName: "approve",
            args: [router, tokens / 2n],
          }),
          "the router approval",
        );
      const [block] = (await ctx.pub.simulateBlocks({
        blockNumber: latest.number,
        blocks: [
          {
            blockOverrides: {
              number: latest.number + 1n,
              time: latest.timestamp + 1n,
            },
            calls: [
              {
                account: me,
                to: sell.address,
                abi: sell.abi as Abi,
                functionName: sell.functionName,
                args: sell.args,
                value: sell.value,
              },
              {
                account: me,
                to: buy.address,
                abi: buy.abi as Abi,
                functionName: buy.functionName,
                args: buy.args,
                value: buy.value,
              },
            ],
          },
        ],
      } as never)) as unknown as {
        calls: {
          status: string;
          result: unknown;
          gasUsed: bigint;
          error?: unknown;
        }[];
      }[];
      const [s1, s2] = block.calls;
      if (s1.status !== "success" || s2.status !== "success")
        throw new Error(`the flash round trip would fail: ${decodeRevert(s1.error ?? s2.error).signature}. Nothing was sent.`);
      const ethIn = paidIn0(s2.result as bigint);
      const buyExact = swapCall(ctx, v, true, ethIn + ethIn / 200n + 1n, home);
      const gas1 = (s1.gasUsed * 3n) / 2n + 100_000n;
      const gas2 = (s2.gasUsed * 3n) / 2n + 100_000n;
      const w = ctx.wallet("issuer");
      let h1: Hex;
      let h2: Hex;
      if (o.warp) {
        // A fork's impersonated account cannot sign raw transactions: hold the block open instead.
        await rpc(rpcUrl, "evm_setAutomine", [false]);
        try {
          h1 = await w.writeContract({
            ...sell,
            account: w.account,
            chain: ctx.chain,
            gas: gas1,
          } as never);
          h2 = await w.writeContract({
            ...buyExact,
            account: w.account,
            chain: ctx.chain,
            gas: gas2,
          } as never);
          await rpc(rpcUrl, "evm_mine", []);
        } finally {
          await rpc(rpcUrl, "evm_setAutomine", [true]);
        }
      } else {
        const nonce = await ctx.pub.getTransactionCount({
          address: me,
          blockTag: "pending",
        });
        const fees = await ctx.pub.estimateFeesPerGas();
        const common = {
          account: w.account,
          chain: ctx.chain,
          maxFeePerGas: fees.maxFeePerGas * 2n,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        };
        [h1, h2] = await Promise.all([
          w.writeContract({ ...sell, ...common, gas: gas1, nonce } as never),
          w.writeContract({
            ...buyExact,
            ...common,
            gas: gas2,
            nonce: nonce + 1,
          } as never),
        ]);
      }
      kit.sending("flashSell").onHash(h1);
      kit.sending("flashBuy").onHash(h2);
      const [r1, r2] = await Promise.all([
        ctx.pub.waitForTransactionReceipt({
          hash: h1,
          pollingInterval: 500,
          timeout: 180_000,
        }),
        ctx.pub.waitForTransactionReceipt({
          hash: h2,
          pollingInterval: 500,
          timeout: 180_000,
        }),
      ]);
      if (r1.status !== "success" || r2.status !== "success") throw new Error(`a flash swap reverted: ${h1} ${r1.status}, ${h2} ${r2.status}`);
      const [b1, b2] = await Promise.all([ctx.pub.getBlock({ blockNumber: r1.blockNumber }), ctx.pub.getBlock({ blockNumber: r2.blockNumber })]);
      await view();
      const same =
        r1.blockNumber === r2.blockNumber
          ? "in the same block"
          : b1.timestamp === b2.timestamp
            ? `in blocks ${r1.blockNumber} and ${r2.blockNumber}, the same second`
            : null;
      if (!same) {
        delete p.pending?.flashSell;
        delete p.pending?.flashBuy;
        kit.save();
        log(`  flash attempt ${attempt}: the swaps landed in different seconds (${b1.timestamp}, ${b2.timestamp}); waiting for the guard, then again`);
        await hold({
          label: "waiting for the guard after a split flash",
          warp,
          log,
          check: async () => (await view(), { done: v.guard.ok, left: guardStep }),
        });
        continue;
      }
      kit.record("flashSell", {
        title: "Dump 5,000 ticks…",
        status: "success",
        ...mined(h1, r1),
        detail: `${amt(tokens / 2n)} ${sym} offered, spot ${home} → ${home - FLASH_TICKS} at most, ${same}`,
      });
      kit.record("flashBuy", {
        title: "…and buy it straight back",
        status: "success",
        ...mined(h2, r2),
        detail: `${amt(ethIn)} ETH, spot back to ${v.spotTick}; TWAP before ${twapBefore}, after ${v.twap}`,
      });
      return;
    }
    throw new Error("three flash attempts landed in different seconds; the rest of the run waits for a rerun");
  }
}

/** What buying every ask up to 30,000 ticks above the price costs, simulated from the issuer's balance (capped). */
async function pumpCost(ctx: ChainCtx, v: VaultView, cap: bigint): Promise<bigint> {
  const me = ctx.signer as Address;
  const bal = await ctx.pub.getBalance({ address: me });
  const budget = bal - RESERVE < cap ? bal - RESERVE : cap;
  const pre = await simulate(ctx, me, swapCall(ctx, v, true, budget, v.spotTick + PUMP_TICKS) as never);
  if (!pre.ok) throw new Error(`the pump would fail: ${pre.error?.signature}`);
  const cost = paidIn0(pre.value as bigint);
  if (cost >= budget) throw new Error(`the pump would spend the whole ${formatEther(budget)} ETH cap before reaching 30,000 ticks`);
  return cost;
}

/**
 * The whole pump-ratchet, simulated on top of the head before anything is sent: the pump, a restore two hours later
 * (it must be NothingToRestore), then syncs every 25 minutes until restore answers RestoreBandEmpty. A restore that
 * would settle part-way is logged: nobody sends one on this vault, and the band floats past it.
 */
async function checkPumpPlan(ctx: ChainCtx, v: VaultView, keeper: Address, cap: bigint, log: (line: string) => void) {
  const me = ctx.signer as Address;
  const latest = await ctx.pub.getBlock({ blockTag: "latest" });
  const cost = await pumpCost(ctx, v, cap);
  const pump = swapCall(ctx, v, true, cost + cost / 100n + 1n, v.spotTick + PUMP_TICKS);
  const restore = (vv: VaultView) => ({
    account: keeper,
    to: vv.address,
    abi: covenantVaultAbi as Abi,
    functionName: "restore",
    args: [vv.ranges.filter((r) => r.priceLower < vv.spotTick + PUMP_TICKS).map((r) => BigInt(r.index)), NEVER],
  });
  const poke = {
    account: keeper,
    to: v.address,
    abi: covenantVaultAbi as Abi,
    functionName: "poke",
    args: [],
  };
  // Consecutive block numbers, hours apart: a public node fills any gap in the numbers with empty blocks, and caps how many.
  let n = 0;
  const at = (s: number) => ({ number: latest.number + BigInt(++n), time: latest.timestamp + BigInt(1 + s) });
  const blocks: {
    blockOverrides: { number: bigint; time: bigint };
    calls: unknown[];
    stateOverrides?: unknown[];
  }[] = [
    {
      blockOverrides: at(0),
      stateOverrides: [{ address: keeper, balance: parseEther("1") }],
      calls: [
        {
          account: me,
          to: pump.address,
          abi: pump.abi as Abi,
          functionName: pump.functionName,
          args: pump.args,
          value: pump.value,
        },
      ],
    },
    { blockOverrides: at(QUICK_HOLD_S), calls: [restore(v)] },
  ];
  for (let i = 1; i <= POKES; i++)
    blocks.push({
      blockOverrides: at(QUICK_HOLD_S + i * POKE_EVERY_S),
      calls: [poke, restore(v)],
    });
  const out = (await ctx.pub.simulateBlocks({
    blockNumber: latest.number,
    blocks,
  } as never)) as unknown as { calls: { status: string; error?: unknown }[] }[];
  if (out[0].calls[0].status !== "success") throw new Error(`plan: the pump would fail: ${decodeRevert(out[0].calls[0].error).signature}`);
  const quick = out[1].calls[0];
  const quickErr = quick.status === "success" ? "settles" : decodeRevert(quick.error).signature;
  log(`plan: pump costs ${formatEther(cost)} ETH; restore two hours on: ${quickErr}`);
  if (!quickErr.startsWith("NothingToRestore"))
    throw new Error(`plan: two hours after the pump a restore would answer ${quickErr}, not NothingToRestore. Nothing was sent.`);
  for (let i = 1; i <= POKES; i++) {
    const [pk, rs] = out[1 + i].calls;
    const r = rs.status === "success" ? "settles" : decodeRevert(rs.error).signature;
    log(`plan: sync ${i}${pk.status === "success" ? "" : " (fails)"}: restore ${r}`);
    if (r.startsWith("RestoreBandEmpty")) {
      log(`plan: restore is refused with RestoreBandEmpty after ${i} syncs`);
      return;
    }
  }
  throw new Error(`plan: after ${POKES} syncs restore never answers RestoreBandEmpty. Nothing was sent.`);
}
