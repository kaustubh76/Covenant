// The attack lab on a public chain. Every attack that fits in a few simulated blocks is rebuilt from the live vault as
// it is now and run with eth_simulateV1 on top of the chain's head: the vault's real curator and issuer act as
// themselves, while stand-ins with no role (an attacker, an outside LP, a keeper) are given ETH by state override and
// tokens by a transfer from the real issuer, inside the simulation. Blocks can sit hours or days later, so the setup
// epoch, the curator timelock and a TWAP window pass as they would on chain. Nothing is ever sent: what a card shows is
// what the deployed contracts would do. The one attack that needs days of pokes stays the suite's recorded run.

import { type Abi, type Address, maxUint256, parseEther } from "viem";
import type { Who } from "../accounts";
import { covenantLensAbi, covenantVaultAbi, liquidityRouterAbi, testTokenAbi } from "../abi.generated";
import type { BeatInput } from "../beat";
import type { ChainCtx } from "../client";
import { CRASH_DEPTHS, type SimCall } from "../crashsim";
import { type DecodedError, decodeRevert } from "../errors";
import { NEVER } from "../launch";
import { swapCall } from "../market";
import { type Leg, type Plan, SINK, bidLeg, chasePump, cut, moveEverything, reserveIndex, skim, softRug } from "../plans";
import { type ActionCall, preflight } from "../preflight";
import type { Party } from "../tx";
import { type LensState, type VaultView, viewFromSnapshot } from "../view";
import type { AttackRun } from "./attacks";
import { restoreCandidates } from "./restore";

/** Stand-ins with no role in the vault. They hold nothing on chain; a simulation funds them. (Lowercase: a mixed-case address must be a valid checksum.) */
export const OUTSIDER: Address = "0x000000000000000000000000000000000000dEaD";
export const ATTACKER: Address = "0x000000000000000000000000000000000000bad1";
export const LP: Address = "0x0000000000000000000000000000000000001a1f";
export const KEEPER: Address = "0x000000000000000000000000000000000000beef";
export const NEW_CURATOR: Address = "0x000000000000000000000000000000000000c0de";
const STAND_INS = [OUTSIDER, ATTACKER, LP, KEEPER, NEW_CURATOR];
/** What each stand-in is given to spend, by state override. */
const STAND_IN_ETH = parseEther("100");
/** The most ranges a reshape may leave (CovenantVault's cap, test_13_2_08). */
const MAX_RANGES = 14;

const vaultAbi = covenantVaultAbi as Abi;
const tokenAbi = testTokenAbi as Abi;

// ------------------------------------------------------------------------------------------------- the simulator

interface SimResult {
  status: string;
  result?: unknown;
  error?: unknown;
}

/** One call in a simulated block. `quiet` calls (funding, approvals) set the scene and are not shown as steps. */
interface Step {
  who: Who;
  title: string;
  call: SimCall;
  quiet?: boolean;
  detail?: (r: SimResult) => string | undefined;
}

export interface Scene {
  ctx: ChainCtx;
  v: VaultView;
  base: { number: bigint; timestamp: bigint };
  /** The issuer's token balance: what the stand-ins can be handed. */
  issuerTokens: bigint;
}

/** Seconds after the head at which the setup epoch is over (at least one). */
export const pastSetup = (s: Pick<Scene, "v" | "base">) => Math.max(1, s.v.pace.setupEndsAt - Number(s.base.timestamp) + 1);

/** Run `blocks` on top of the head, each `after` seconds past it, in order. Stand-ins are funded in the first. */
async function play(s: Scene, blocks: { after: number; steps: Step[] }[]): Promise<{ results: SimResult[][]; beats: BeatInput[] }> {
  const out = (await s.ctx.pub.simulateBlocks({
    blockNumber: s.base.number,
    blocks: blocks.map((b, i) => ({
      blockOverrides: { number: s.base.number + BigInt(i + 1), time: s.base.timestamp + BigInt(b.after) },
      ...(i === 0 ? { stateOverrides: STAND_INS.map((address) => ({ address, balance: STAND_IN_ETH })) } : {}),
      calls: b.steps.map((x) => x.call),
    })),
  } as never)) as unknown as { calls: SimResult[] }[];
  const results = out.map((b) => b.calls);
  const beats: BeatInput[] = [];
  blocks.forEach((b, i) =>
    b.steps.forEach((x, j) => {
      if (x.quiet) return;
      const r = results[i][j];
      const ok = r.status === "success";
      beats.push({ actor: x.who, title: x.title, ok, error: ok ? undefined : describeError(s, r.error, b.after), detail: ok ? x.detail?.(r) : undefined });
    }),
  );
  return { results, beats };
}

const describeError = (s: Scene, e: unknown, after: number): DecodedError =>
  decodeRevert(e, { now: Number(s.base.timestamp) + after, quoteSymbol: s.v.quoteSymbol, tokenSymbol: s.v.tokenSymbol });

const ok = (r: SimResult | undefined) => r?.status === "success";

// ------------------------------------------------------------------------------------------------- calls

const vaultCall = (v: VaultView, functionName: string, args: readonly unknown[]): ActionCall => ({ address: v.address, abi: covenantVaultAbi, functionName, args });
const reshape = (v: VaultView, p: Plan) => vaultCall(v, "reshape", [p.cuts, p.legs, NEVER]);
const asSim = (account: Address, c: ActionCall): SimCall => ({ account, to: c.address, abi: c.abi, functionName: c.functionName, args: c.args, value: c.value });
const snapshot = (s: Scene): SimCall => ({ to: s.ctx.net.manifest.lens, abi: covenantLensAbi as Abi, functionName: "snapshot", args: [s.v.address] });
// sqrtP 0: the price comes from the simulated snapshot, not the pool as it was read before the simulation
const viewAt = (s: Scene, r: SimResult, after: number) =>
  viewFromSnapshot({ ...s.v, extras: { ...s.v.extras, time: Number(s.base.timestamp) + after, block: s.base.number + 1n, sqrtP: 0n } }, r.result as LensState);
const wei = (eth: number) => parseEther(Math.max(0, eth).toFixed(18));

/** The issuer hands `to` some of its tokens, then `to` approves `spender` for them. */
function funded(s: Scene, to: Address, amount: bigint, spender: Address): Step[] {
  return [
    { who: "issuer", title: "", quiet: true, call: { account: s.v.people.issuer, to: s.v.token, abi: tokenAbi, functionName: "transfer", args: [to, amount] } },
    { who: "anyone", title: "", quiet: true, call: { account: to, to: s.v.token, abi: tokenAbi, functionName: "approve", args: [spender, maxUint256] } },
  ];
}
const router = (s: Scene) => s.ctx.net.manifest.swapRouter as Address;

/** `who` sells tokens until the price is `ticks` lower (or `amount` runs out), funded by the issuer. */
function dump(s: Scene, who: Address, ticks: number, title: string, amount = s.issuerTokens / 2n): Step[] {
  const c = swapCall(s.ctx, s.v, false, amount, s.v.spotTick - ticks);
  return [...funded(s, who, amount, router(s)), { who: "attacker", title, call: asSim(who, { ...c, abi: c.abi as Abi, args: c.args }) }];
}
/** `who` buys with ETH until the price is `ticks` higher. */
function pump(s: Scene, who: Address, ticks: number, title: string, eth = STAND_IN_ETH / 2n): Step {
  const c = swapCall(s.ctx, s.v, true, eth, s.v.spotTick + ticks);
  return { who: "attacker", title, call: asSim(who, { ...c, abi: c.abi as Abi, args: c.args }) };
}
/** An outside LP's deposit for `fraction` of today's shares, its ETH sent generously (the vault refunds the rest). */
function deposit(s: Scene, fraction: number, value?: bigint): { shares: bigint; call: SimCall; tokens: bigint } {
  const v = s.v;
  const shares = (v.raw.totalShares * BigInt(Math.round(fraction * 1e6))) / 1_000_000n;
  const quote = (v.principal.quote + v.idle.quote) * fraction;
  const tokens = wei((v.principal.token + v.idle.token) * fraction * 1.2 + 1e-6);
  return { shares, tokens, call: { account: LP, to: v.address, abi: vaultAbi, functionName: "deposit", args: [shares, maxUint256, maxUint256, NEVER], value: value ?? wei(quote * 1.5 + 0.01) } };
}

/** Slivers enough that the vault would end up over the range cap, whatever it holds now. */
export function overTheCap(v: VaultView): Plan {
  const slivers = Math.max(12, MAX_RANGES + 1 - (v.ranges.length - 1));
  const legs: Leg[] = [];
  let top = v.spotTick - v.terms.supportBandTicks;
  for (let i = 0; i < slivers; i++) {
    legs.push(bidLeg(v, top - 60, top, i === 0 ? SINK : 300));
    top -= 60;
  }
  return { cuts: [cut(reserveIndex(v))], legs };
}

const pctOf = (x: number) => `${(x * 100).toFixed(3)}%`;

// ------------------------------------------------------------------------------------------------- the checks

export interface LiveCheck {
  /** The attack card (ATTACKS id) this stands for. */
  id: string;
  /** Why it cannot be checked on this vault right now, or null. */
  skip?: (v: VaultView) => string | null;
  /**
   * The attack, simulated. Null when the scene could not be set (say a dump that did not move the price): the card
   * then keeps its recorded run rather than claim anything about the live vault.
   */
  run: (s: Scene) => Promise<AttackRun | null>;
}

/** A single call, pre-flighted in the next block as `party`. */
function single(id: string, summary: string, attempt: (s: Scene) => { party: Party; who: Who; title: string; call: ActionCall; setup?: ActionCall[] } | null, skip?: LiveCheck["skip"]): LiveCheck {
  return {
    id,
    skip,
    async run(s) {
      const a = attempt(s);
      if (!a) return null;
      const p = await preflight(s.ctx, a.party, a.call, s.v, a.setup ?? []);
      const beats: BeatInput[] = [{ actor: a.who, title: a.title, ok: p.ok, error: p.error, detail: p.ok ? "The live contracts would accept this" : undefined }];
      return { blocked: !p.ok, summary: p.ok ? "The live contracts would accept this: see the step above" : summary, beats: beats as AttackRun["beats"] };
    },
  };
}

const run = (blocked: boolean, summary: string, beats: BeatInput[]): AttackRun => ({ blocked, summary, beats: beats as AttackRun["beats"] });

export const LIVE_CHECKS: LiveCheck[] = [
  // ---- one call each
  single("curator-withdraw", "The curator manages the vault but owns none of it: the principal only ever leaves to the treasury, once vested", (s) => ({
    party: s.v.people.curator,
    who: "curator",
    title: "The curator asks for the issuer's principal",
    call: vaultCall(s.v, "withdrawPrincipal", [10n ** 16n, 0n, 0n, NEVER]),
  })),
  single("skim", "What is lifted must all go back in: principal is conserved on every reshape", (s) => ({
    party: s.v.people.curator,
    who: "curator",
    title: "Reshape, re-adding 90% of the support",
    call: reshape(s.v, skim(s.v)),
  })),
  single("softrug", "Support is checked on the layout the reshape would leave", (s) => ({
    party: s.v.people.curator,
    who: "curator",
    title: "Move the support 9,000 ticks below the price",
    call: reshape(s.v, softRug(s.v)),
  })),
  single(`fragment`, `A reshape may leave ${MAX_RANGES} ranges at most, so restore always has room`, (s) => ({
    party: s.v.people.curator,
    who: "curator",
    title: "Split the reserve into slivers, over the range cap",
    call: reshape(s.v, overTheCap(s.v)),
  })),
  single("issuer-exit", "Nothing leaves before it vests", (s) => ({
    party: s.v.people.issuer,
    who: "issuer",
    title: "Withdraw more principal than has vested",
    call: vaultCall(s.v, "withdrawPrincipal", [s.v.raw.principalWithdrawable + 10n ** 16n, 0n, 0n, NEVER]),
  })),
  single(
    "farm",
    "Healthy support pays nothing",
    (s) => ({ party: KEEPER, who: "keeper", title: "Call restore on a healthy vault", call: vaultCall(s.v, "restore", [s.v.ranges.map((r) => BigInt(r.index)), NEVER]) }),
    (v) => (v.support.have < v.support.need ? "Support has lapsed right now, so a restore is owed" : null),
  ),
  single(
    "outsider",
    "Positions are keyed to their owner: the vault's are out of anyone else's reach",
    (s) => {
      const r = s.v.ranges[0];
      const lr = s.ctx.net.manifest.liquidityRouter;
      if (!r || !lr) return null;
      // a modest amount: the whole of a launch's full-range position would overflow int128 first
      const delta = r.liquidity < 10n ** 18n ? r.liquidity : 10n ** 18n;
      return {
        party: OUTSIDER,
        who: "attacker",
        title: "Remove one of the vault's ranges directly, through a router",
        call: { address: lr, abi: liquidityRouterAbi, functionName: "modifyLiquidity", args: [s.v.key, { tickLower: r.tickLower, tickUpper: r.tickUpper, liquidityDelta: -delta, salt: `0x${"0".repeat(64)}` }, "0x"] },
      };
    },
    (v) => (v.ranges.length ? null : "The vault holds no ranges yet"),
  ),

  // ---- across blocks and time
  {
    id: "pace",
    skip: (v) => (v.terms.paceBps >= 10_000 ? "These terms let the whole vault move in one epoch" : null),
    async run(s) {
      const t = pastSetup(s);
      const { beats } = await play(s, [{ after: t, steps: [{ who: "curator", title: "After the setup epoch, move 100% of the vault at once", call: asSim(s.v.people.curator, reshape(s.v, moveEverything(s.v))) }] }]);
      return run(!beats[0].ok, `No more than ${(s.v.terms.paceBps / 100).toFixed(0)}% of the vault's value moves per epoch under these terms`, beats);
    },
  },
  {
    id: "instant-curator",
    async run(s) {
      const later = 2 + s.v.terms.curatorTimelock;
      const { results, beats } = await play(s, [
        {
          after: 1,
          steps: [
            { who: "issuer", title: "Propose a friendly curator", call: asSim(s.v.people.issuer, vaultCall(s.v, "proposeCurator", [NEW_CURATOR])), detail: () => "The timelock starts, in public" },
            { who: "keeper", title: "Accept it in the same block", call: asSim(KEEPER, vaultCall(s.v, "acceptCurator", [])) },
          ],
        },
        {
          after: later,
          steps: [
            { who: "keeper", title: "Accept once the timelock has run", call: asSim(KEEPER, vaultCall(s.v, "acceptCurator", [])), detail: () => "The new curator is in place" },
            { who: "newCurator", title: "The new curator moves the support away", call: asSim(NEW_CURATOR, reshape(s.v, softRug(s.v))) },
          ],
        },
      ]);
      if (!ok(results[0][0]) || !ok(results[1][0])) return null;
      return run(!ok(results[0][1]) && !ok(results[1][1]), "Timelocked, then bound by exactly the same rules", beats);
    },
  },
  {
    id: "manipulate",
    async run(s) {
      const t = pastSetup(s);
      const d = deposit(s, 0.1);
      const steps: Step[] = [
        ...dump(s, ATTACKER, 2000, "Dump the token 2,000 ticks"),
        ...funded(s, LP, d.tokens, s.v.address),
        { who: "curator", title: "Reshape at the new spot", call: asSim(s.v.people.curator, reshape(s.v, { cuts: [cut(0, 1n)], legs: [] })) },
        { who: "lp", title: "Deposit at the manipulated price", call: d.call },
        { who: "keeper", title: "Call restore", call: asSim(KEEPER, vaultCall(s.v, "restore", [[0n], NEVER])) },
        { who: "anyone", title: "", quiet: true, call: snapshot(s) },
      ];
      const { results, beats } = await play(s, [{ after: t, steps }]);
      const r = results[0];
      const after = ok(r[r.length - 1]) ? viewAt(s, r[r.length - 1], t) : null;
      if (!ok(r[2]) || !after || after.guard.ok) return null; // the dump did not trip the guard: nothing shown
      beats[0].detail = `Spot is now ${Math.round(after.guard.diff)} ticks from the TWAP (the guard allows ${after.guard.limit})`;
      return run(!ok(r[5]) && !ok(r[6]) && !ok(r[7]), "The guard blocks all three until the price has held", beats);
    },
  },
  {
    id: "flash",
    async run(s) {
      const sell = swapCall(s.ctx, s.v, false, s.issuerTokens / 2n, s.v.spotTick - 5000);
      const buyBack = swapCall(s.ctx, s.v, true, STAND_IN_ETH / 2n, s.v.spotTick);
      const { results, beats } = await play(s, [
        {
          after: 1,
          steps: [
            ...funded(s, ATTACKER, s.issuerTokens / 2n, router(s)),
            { who: "attacker", title: "Dump 5,000 ticks", call: asSim(ATTACKER, { ...sell, abi: sell.abi as Abi, args: sell.args }) },
            { who: "attacker", title: "And buy straight back, in the same block", call: asSim(ATTACKER, { ...buyBack, abi: buyBack.abi as Abi, args: buyBack.args }) },
          ],
        },
        {
          after: 2,
          steps: [
            { who: "anyone", title: "", quiet: true, call: snapshot(s) },
            { who: "curator", title: "Reshape: is the guard fooled?", call: asSim(s.v.people.curator, reshape(s.v, { cuts: [cut(0, 1n)], legs: [] })), detail: () => "The guard passes: as far as the average is concerned, nothing happened" },
          ],
        },
      ]);
      if (!ok(results[0][2]) || !ok(results[0][3]) || !ok(results[1][0])) return null;
      const after = viewAt(s, results[1][0], 2);
      beats.splice(2, 0, { actor: "anyone", title: "The average, a block later", ok: true, detail: `TWAP tick ${s.v.twap} before, ${after.twap} after` });
      if (!ok(results[1][1])) return null; // a reshape refused for some other reason says nothing about the oracle
      return run(Math.abs(after.twap - s.v.twap) <= 1, "Same-block writes add no weight to the average", beats);
    },
  },
  {
    id: "cheap-shares",
    async run(s) {
      const t = pastSetup(s);
      const d = deposit(s, 0.1);
      const { results, beats } = await play(s, [{ after: t, steps: [...funded(s, LP, d.tokens, s.v.address), { who: "lp", title: "Deposit for a tenth of the shares", call: d.call }] }]);
      const r = results[0][2];
      if (!ok(r)) return null;
      const [a0, a1] = r.result as readonly [bigint, bigint];
      const [q, tk] = s.v.quoteIs0 ? [a0, a1] : [a1, a0];
      const fq = Number(q) / 1e18 / (s.v.principal.quote + s.v.idle.quote);
      const ft = Number(tk) / 1e18 / (s.v.principal.token + s.v.idle.token);
      beats.push({ actor: "lp", title: "What a tenth of the shares cost", ok: true, detail: `${pctOf(fq)} of the quote and ${pctOf(ft)} of the tokens` });
      return run(Math.abs(fq - 0.1) < 1e-4 && Math.abs(ft - 0.1) < 1e-4, "A tenth of the shares costs exactly a tenth of every range", beats);
    },
  },
  {
    id: "lp-exit",
    async run(s) {
      const t = pastSetup(s);
      const d = deposit(s, 0.1);
      const steps: Step[] = [
        ...funded(s, LP, d.tokens, s.v.address),
        { who: "lp", title: "Join for a tenth of the shares", call: d.call },
        { who: "anyone", title: "", quiet: true, call: snapshot(s) },
        { who: "lp", title: "Leave with every share", call: { account: LP, to: s.v.address, abi: vaultAbi, functionName: "withdraw", args: [d.shares, 0n, 0n, NEVER] } },
        { who: "anyone", title: "", quiet: true, call: snapshot(s) },
      ];
      const { results, beats } = await play(s, [{ after: t, steps }]);
      const r = results[0];
      if (!ok(r[2]) || !ok(r[3]) || !ok(r[5])) return null;
      const before = viewAt(s, r[3], t);
      const after = viewAt(s, r[5], t);
      beats.push({
        actor: "anyone",
        title: "After the exit",
        ok: true,
        detail: `Support ${before.support.have} → ${after.support.have} bps. The issuer's principal shares ${after.raw.principalShares === s.v.raw.principalShares ? "untouched" : "changed"}`,
      });
      return run(ok(r[4]) && Math.abs(after.support.have - before.support.have) <= 1 && after.raw.principalShares === s.v.raw.principalShares, "A proportional exit leaves the shape and the issuer untouched", beats);
    },
  },
  {
    id: "big-dump",
    async run(s) {
      const amount = wei(s.v.principal.token * 0.2);
      if (amount === 0n || amount > s.issuerTokens) return null;
      const held: SimCall = { to: s.v.token, abi: tokenAbi, functionName: "balanceOf", args: [s.v.address] };
      const c = swapCall(s.ctx, s.v, false, amount, s.v.spotTick - 30_000);
      const steps: Step[] = [
        { who: "anyone", title: "", quiet: true, call: held },
        ...funded(s, ATTACKER, amount, router(s)),
        { who: "attacker", title: `Dump ${(s.v.principal.token * 0.2).toFixed(2)} ${s.v.tokenSymbol}, a fifth of what the vault holds`, call: asSim(ATTACKER, { ...c, abi: c.abi as Abi, args: c.args }) },
        { who: "anyone", title: "", quiet: true, call: held },
        { who: "anyone", title: "", quiet: true, call: snapshot(s) },
      ];
      const { results, beats } = await play(s, [{ after: 1, steps }]);
      const r = results[0];
      if (!ok(r[3]) || !ok(r[5])) return null;
      const after = viewAt(s, r[5], 1);
      const same = (r[0].result as bigint) === (r[4].result as bigint);
      beats.push({
        actor: "anyone",
        title: "The vault's bids bought the dump",
        ok: true,
        detail: `Quote in the pool ${s.v.principal.quote.toFixed(4)} → ${after.principal.quote.toFixed(4)} ETH, tokens ${s.v.principal.token.toFixed(2)} → ${after.principal.token.toFixed(2)}`,
      });
      return run(same && after.principal.token > s.v.principal.token, "Absorbed inside the pool: nothing left the vault", beats);
    },
  },
  {
    id: "freeze-exits",
    async run(s) {
      const t = pastSetup(s);
      const d = deposit(s, 0.1);
      const steps: Step[] = [
        ...funded(s, LP, d.tokens, s.v.address),
        { who: "lp", title: "Join for a tenth of the shares", call: d.call },
        ...dump(s, ATTACKER, 2500, "Hold spot 2,500 ticks below the average"),
        { who: "anyone", title: "", quiet: true, call: snapshot(s) },
        {
          who: "lp",
          title: "Withdraw anyway",
          call: { account: LP, to: s.v.address, abi: vaultAbi, functionName: "withdraw", args: [d.shares, 0n, 0n, NEVER] },
          detail: () => "Exits are never guarded: a proportional burn cannot be priced wrong",
        },
      ];
      const { results, beats } = await play(s, [{ after: t, steps }]);
      const r = results[0];
      if (!ok(r[2]) || !ok(r[5]) || !ok(r[6])) return null;
      const mid = viewAt(s, r[6], t);
      if (mid.guard.ok) return null;
      beats.splice(2, 0, { actor: "anyone", title: "The guard is tripped", ok: true, detail: `Spot is ${Math.round(mid.guard.diff)} ticks from the TWAP` });
      return run(ok(r[7]), "The LP leaves while the guard is tripped", beats);
    },
  },
  {
    id: "vault-pays",
    async run(s) {
      const t = pastSetup(s);
      const d = deposit(s, 0.1, 1n);
      const { results, beats } = await play(s, [{ after: t, steps: [...funded(s, LP, d.tokens, s.v.address), { who: "lp", title: "Deposit for 10% with 1 wei of ETH attached", call: d.call }] }]);
      if (!ok(results[0][0])) return null;
      return run(!ok(results[0][2]), "The vault never pays for a depositor", beats);
    },
  },
  {
    id: "colluding-curator",
    async run(s) {
      const hold = 1 + s.v.terms.twapWindow + 3600;
      const pumpUp = pump(s, ATTACKER, 15_000, "An accomplice pumps 15,000 ticks through the asks");
      // first the pumped vault, a window later, so the curator's chase can be built from it
      const seen = await play(s, [
        { after: 1, steps: [pumpUp] },
        { after: hold, steps: [{ who: "anyone", title: "", quiet: true, call: snapshot(s) }] },
      ]);
      if (!ok(seen.results[0][0]) || !ok(seen.results[1][0])) return null;
      const pumped = viewAt(s, seen.results[1][0], hold);
      const { results, beats } = await play(s, [
        { after: 1, steps: [pumpUp] },
        { after: hold, steps: [{ who: "curator", title: "Hold it a TWAP window, then move the bids up under the fake price", call: asSim(s.v.people.curator, reshape(pumped, chasePump(pumped))) }] },
      ]);
      if (!ok(results[0][0])) return null;
      return run(!ok(results[1][0]), "No bid above the Anchor plus the guard, and the Anchor climbs a band a day at most", beats);
    },
  },
  {
    id: "pump-quick",
    async run(s) {
      const later = 1 + 2 * 3600;
      const pumpUp = pump(s, ATTACKER, 30_000, "Buy the asks and push the price 30,000 ticks");
      const seen = await play(s, [
        { after: 1, steps: [pumpUp] },
        { after: later, steps: [{ who: "anyone", title: "", quiet: true, call: snapshot(s) }] },
      ]);
      if (!ok(seen.results[0][0]) || !ok(seen.results[1][0])) return null;
      const held = viewAt(s, seen.results[1][0], later);
      const quote = held.ranges.filter((r) => r.quote > 1e-12).map((r) => BigInt(r.index));
      const { results, beats } = await play(s, [
        { after: 1, steps: [pumpUp] },
        { after: later, steps: [{ who: "attacker", title: "Two hours later, call restore to drag the bids up", call: asSim(ATTACKER, vaultCall(s.v, "restore", [quote.length ? quote : [0n], NEVER])) }] },
      ]);
      if (!ok(results[0][0])) return null;
      beats.splice(1, 0, { actor: "anyone", title: "Two hours later the TWAP has followed the pump", ok: true, detail: `Support still reads ${(held.support.have / 100).toFixed(1)}%: the filled asks are quote just under the old price, and count` });
      return run(!ok(results[1][0]), "Nothing to restore: the pump cannot drag the vault's bids up under it", beats);
    },
  },
  {
    id: "dust-restore",
    async run(s) {
      const hold = 1 + s.v.terms.twapWindow + 3600;
      // the shallowest sell-off that, once it has held, strands quote below the band (as Keep's crash finder does);
      // a layout whose bids all sit inside the band never strands any, and then there is nothing to show
      let found: { sale: Step[]; crashed: VaultView; indices: number[]; depth: number } | null = null;
      for (const depth of CRASH_DEPTHS) {
        const sale = dump(s, ATTACKER, depth, `Dump ${depth.toLocaleString("en-US")} ticks and hold it a TWAP window`);
        const seen = await play(s, [
          { after: 1, steps: sale },
          { after: hold, steps: [{ who: "anyone", title: "", quiet: true, call: snapshot(s) }] },
        ]);
        if (!ok(seen.results[0][2]) || !ok(seen.results[1][0])) continue;
        const crashed = viewAt(s, seen.results[1][0], hold);
        const indices = restoreCandidates(crashed);
        if (indices.length && crashed.support.have < crashed.support.need && crashed.guard.ok) {
          found = { sale, crashed, indices, depth };
          break;
        }
      }
      if (!found) return null;
      const { sale, crashed, indices } = found;
      const { results, beats } = await play(s, [
        { after: 1, steps: sale },
        {
          after: hold,
          steps: [
            { who: "keeper", title: `Restore with support at ${(crashed.support.have / 100).toFixed(1)}%`, call: asSim(KEEPER, vaultCall(crashed, "restore", [[...indices].sort((a, b) => a - b).map(BigInt), NEVER])) },
            { who: "anyone", title: "", quiet: true, call: snapshot(s) },
          ],
        },
      ]);
      if (!ok(results[1][0]) || !ok(results[1][1])) return null;
      const after = viewAt(s, results[1][1], hold);
      const paid = crashed.fees.bountyPool - after.fees.bountyPool;
      const cap = Number(s.v.terms.bounty) / 1e18;
      beats.push({ actor: "keeper", title: `Bounty paid: ${paid.toPrecision(3)} ETH`, ok: true, detail: `Never more than ${cap} ETH, and never more than 1% of the quote moved. Support now ${(after.support.have / 100).toFixed(1)}%` });
      return run(paid > 0 && paid <= cap + 1e-12, "The bounty is capped, so dust earns dust", beats);
    },
  },
];

/** Each check that applies to `v`, in turn. Results arrive one by one; checks with nothing to show are left out. */
export async function runLiveChecks(ctx: ChainCtx, v: VaultView, onResult: (id: string, r: AttackRun) => void, checks: LiveCheck[] = LIVE_CHECKS): Promise<void> {
  const head = await ctx.pub.getBlock({ blockTag: "latest" });
  const issuerTokens = (await ctx.pub.readContract({ address: v.token, abi: testTokenAbi, functionName: "balanceOf", args: [v.people.issuer] })) as bigint;
  const scene: Scene = { ctx, v, base: { number: head.number, timestamp: head.timestamp }, issuerTokens };
  for (const c of checks) {
    if (c.skip?.(v)) continue;
    try {
      const r = await c.run(scene);
      if (r) onResult(c.id, r);
    } catch (e) {
      // one check that cannot run (an RPC without eth_simulateV1, say) leaves its card recorded; the rest go on
      console.warn(`live check ${c.id}:`, e instanceof Error ? e.message.split("\n")[0] : e);
    }
  }
}
