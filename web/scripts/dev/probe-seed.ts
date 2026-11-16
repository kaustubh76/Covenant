import { covenantVaultAbi } from "../../src/chain/abi.generated";
import { createChainCtx } from "../../src/chain/client";
import { defaultLaunchSpec, launchAndAdopt, planSeed, seedParamsFor, NEVER } from "../../src/chain/launch";
import { preflight } from "../../src/chain/preflight";
import { PRESETS } from "../../src/chain/terms";
import { sandbox } from "../../src/chain/time";
import { readVaultView } from "../../src/chain/view";
import { readNetwork } from "../lib/localchain";

async function main() {
  const ctx = createChainCtx(readNetwork("http://127.0.0.1:8545"));
  await sandbox(ctx, async () => {
    for (const key of ["conservative", "aggressive"] as const) {
      const t = PRESETS[key];
      const launch = await launchAndAdopt(ctx, defaultLaunchSpec(t, { symbol: key.slice(0, 4).toUpperCase() }));
      const v = await readVaultView(ctx, launch.vault);
      for (const share of [5000, 6500, 8000, 9000]) {
        const params = { ...seedParamsFor(t), supportShareBps: share };
        try {
          const { cuts, legs } = await planSeed(ctx, launch, params);
          const p = await preflight(ctx, "curator", { address: v.address, abi: covenantVaultAbi, functionName: "reshape", args: [cuts, legs, NEVER] }, v);
          console.log(key, "share", share, p.ok ? `ok support ${p.after?.support.have}` : p.error?.signature, `legs ${legs.length}`);
        } catch (e) {
          console.log(key, "share", share, "plan failed:", (e as Error).message.split("\n")[0]);
        }
      }
    }
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
