// npm run record
// Replays the landing page's scenarios on a fresh local chain of its own and writes src/fixtures/recorded.json, so the
// landing page shows outcomes the real contracts returned, with no chain running.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEther } from "viem";
import { covenantVaultAbi } from "../src/chain/abi.generated";
import type { ChainCtx } from "../src/chain/client";
import { NEVER, defaultLaunchSpec, launchAndAdopt, seed } from "../src/chain/launch";
import { spotOf, swap } from "../src/chain/market";
import { cutAll, honestLegs, skim, softRug } from "../src/chain/plans";
import { preflight } from "../src/chain/preflight";
import { ATTACKS, runAttacks } from "../src/chain/scenarios/attacks";
import { crash, findLapsingCrash, planRestore, restoreCall } from "../src/chain/scenarios/restore";
import { PRESETS } from "../src/chain/terms";
import { advance, sandbox } from "../src/chain/time";
import { must, send } from "../src/chain/tx";
import { type VaultView, readVaultView } from "../src/chain/view";
import { type Recorded, recordBeat, recordError, recordView } from "../src/fixtures/types";
import { startLocalChain } from "./lib/localchain";

const OUT = join(process.cwd(), "src/fixtures/recorded.json");
const SIZES = Array.from({ length: 40 }, (_, i) => i + 1);

/** Sell `tokens` into the pool in a sandbox: how far the price falls, in ticks. */
const drop = (ctx: ChainCtx, v: VaultView, tokens: number) =>
  sandbox(ctx, async () => {
    const before = await spotOf(ctx, v);
    must(await swap(ctx, v, "attacker", false, parseEther(String(tokens))), "dump");
    return before - (await spotOf(ctx, v));
  });

const reshapeCall = (v: VaultView, plan: { cuts: unknown[]; legs: unknown[] }) => ({
  address: v.address,
  abi: covenantVaultAbi,
  functionName: "reshape",
  args: [plan.cuts, plan.legs, NEVER] as readonly unknown[],
});

async function refusal(ctx: ChainCtx, v: VaultView, plan: { cuts: unknown[]; legs: unknown[] }) {
  const p = await preflight(ctx, "curator", reshapeCall(v, plan), v);
  if (p.ok || !p.error) throw new Error("expected the contract to refuse this plan");
  return recordError(p.error);
}

async function main() {
  const t0 = Date.now();
  const chain = await startLocalChain({ port: Number(process.env.RECORD_PORT ?? 8547), name: "31337-record", log: (s) => console.log(`record: ${s}`) });
  const ctx = chain.ctx;
  try {
    // A: the demo's launch and its demand-shaped seed, for the proof numbers and the impact table.
    console.log("record: launch A (demand-shaped seed)");
    const a = await launchAndAdopt(ctx, defaultLaunchSpec(PRESETS.standard, { name: "Record A" }));
    const rawA = await readVaultView(ctx, a.vault);
    const full: number[] = [];
    for (const n of SIZES) full.push(await drop(ctx, rawA, n));
    must(await seed(ctx, a), "seed A");
    const shapedA = await readVaultView(ctx, a.vault);
    const managed: number[] = [];
    for (const n of SIZES) managed.push(await drop(ctx, shapedA, n));

    // B: the honest layout with a deep reserve, for the hero and the story (its reserve is what a crash strands).
    console.log("record: launch B (honest seed, story)");
    const b = await launchAndAdopt(ctx, defaultLaunchSpec(PRESETS.standard, { name: "Record B" }));
    const rawB = await readVaultView(ctx, b.vault);
    const fullDumpDropTicks = await drop(ctx, rawB, 20);
    must(await send(ctx, "curator", reshapeCall(rawB, { cuts: cutAll(rawB), legs: honestLegs(rawB, rawB.spotTick, 6000) }) as never), "honest seed B");
    const shapedB = await readVaultView(ctx, b.vault);
    const tries = [
      { key: "pull", label: "Pull the liquidity", error: await refusal(ctx, shapedB, { cuts: cutAll(shapedB), legs: [] }) },
      { key: "skim", label: "Keep 10% of it", error: await refusal(ctx, shapedB, skim(shapedB)) },
      { key: "soft", label: "Hide the support", error: await refusal(ctx, shapedB, softRug(shapedB)) },
    ];
    const dumpDropTicks = await drop(ctx, shapedB, 20);
    const dumped = await sandbox(ctx, async () => {
      must(await swap(ctx, shapedB, "attacker", false, parseEther("20")), "dump 20");
      return readVaultView(ctx, b.vault);
    });

    must(await send(ctx, "issuer", { address: b.vault, abi: covenantVaultAbi, functionName: "fundBounty", args: [parseEther("0.1")], value: parseEther("0.1") }), "bounty");
    await advance(ctx, 3600);
    const ready = await readVaultView(ctx, b.vault);
    const depth = await findLapsingCrash(ctx, ready);
    if (depth === null) throw new Error("no crash lapses support on the honest layout");
    must(await crash(ctx, ready, depth), "crash");
    const crashed = await readVaultView(ctx, b.vault);
    const plan = await planRestore(ctx, crashed, "holder");
    must(await send(ctx, "holder", restoreCall(crashed, [...(plan?.indices ?? [])].sort((x, y) => x - y)) as never), "restore");
    const restored = await readVaultView(ctx, b.vault);

    console.log("record: attack lab");
    const attacks: Recorded["attacks"] = {};
    await runAttacks(ctx, ATTACKS, (id, r) => {
      attacks[id] = { blocked: r.blocked, summary: r.summary, beats: r.beats.map(recordBeat) };
    });
    const tape = new Set<string>();
    for (const r of Object.values(attacks)) for (const beat of r.beats) if (beat.error) tape.add(beat.error.signature);

    const at5 = SIZES.indexOf(5);
    const recorded: Recorded = {
      recordedAt: new Date().toISOString(),
      hero: { migrated: recordView(rawB), shaped: recordView(shapedB), tries },
      story: {
        raw: recordView(rawB),
        shaped: recordView(shapedB),
        dumped: recordView(dumped),
        crashed: recordView(crashed),
        restored: recordView(restored),
        dumpTokens: 20,
        dumpDropTicks,
        fullDumpDropTicks,
        softRug: tries[2].error,
        crashTicks: depth,
        bounty: Number((crashed.fees.bountyPool - restored.fees.bountyPool).toFixed(6)),
      },
      proof: {
        supportFrom: rawA.support.have,
        supportTo: shapedA.support.have,
        ratio: full[at5] / managed[at5],
        blocked: Object.values(attacks).filter((r) => r.blocked).length,
        total: ATTACKS.length,
      },
      impact: SIZES.map((size, i) => ({ size, full: full[i], managed: managed[i] })),
      revertTape: [...tape],
      attacks,
    };
    writeFileSync(OUT, JSON.stringify(recorded, null, 2) + "\n");
    const p = recorded.proof;
    console.log(`record: support ${p.supportFrom} → ${p.supportTo} bps, ${p.ratio.toFixed(1)}× less impact, ${p.blocked}/${p.total} attacks blocked`);
    console.log(`record: wrote ${OUT} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    await chain.stop();
  }
}

main().catch((e) => {
  console.error(`record: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
