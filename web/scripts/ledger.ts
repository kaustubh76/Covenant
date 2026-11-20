// npm run ledger [-- --relayer 0x…]
//
// Every transaction Covenant's own keys have sent on Base Sepolia, read back from Blockscout's public API, decoded with
// the app's ABIs, matched to the proof steps that explain them, and written to deployments/84532.ledger.json with a
// coverage table: each state-changing function and the transactions that settled or were refused calling it, and each
// attack card with the transactions that played it. Read-only: it sends nothing.
//
// The keys: the deployer (deployments/84532.json), the helpers the proofs derived from it (their records name them),
// and the backend's relayer (from RELAYER_PRIVATE_KEY in the repository's .env, which is never printed, or --relayer).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Abi, type Address, type Hex, decodeFunctionData, getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ccaAbi,
  covenantFactoryAbi,
  covenantVaultAbi,
  launchTokenAbi,
  lbpStrategyAbi,
  liquidityRouterAbi,
  poolSwapTestAbi,
  positionManagerAbi,
} from "../src/chain/abi.generated";
import { CATALOGUE, type CoverageRow, type Ledger, type LedgerRole, type LedgerTx, fnNames } from "../src/chain/ledger";
import { NETWORKS, type Runtime, parseManifest } from "../src/chain/network";
import { ATTACK_TXS, type StoryKey } from "../src/chain/scenarios/onchain";
import { ROOT, manifestPath, runtimePath } from "./lib/localchain";

const API = "https://base-sepolia.blockscout.com/api/v2";
const RECORDS = NETWORKS["base-sepolia"].records;
const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const log = (s: string) => console.log(`ledger: ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The proofs on record, by story: deployments/<records><suffix>.proof.json. */
const STORY_FILES: Record<StoryKey, string> = {
  covenant: "",
  lp: "-lp",
  manage: "-manage",
  refusals: "-refusals",
  lifecycle: "-lifecycle",
};

interface ProofFile {
  vault: Address;
  signer?: Address;
  issuer?: Address;
  curator?: Address;
  keeper?: Address;
  lp?: Address;
  curator2?: Address;
  issuer2?: Address;
  attacker?: Address;
  steps: Record<
    string,
    {
      title: string;
      status: "success" | "reverted";
      hash: Hex;
      block: number;
      error?: string;
    }
  >;
}

interface BsTx {
  hash: Hex;
  block_number: number;
  timestamp: string;
  from: { hash: Address };
  to: { hash: Address } | null;
  created_contract: { hash: Address } | null;
  status: "ok" | "error" | null;
  method: string | null;
  raw_input: Hex;
  value: string;
  revert_reason: {
    method_call?: string;
    parameters?: { value: unknown }[];
    raw?: string;
  } | null;
}

async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
    }).catch((e) => ({ ok: false, status: 0, statusText: String(e) }) as Response);
    if (res.ok) return (await res.json()) as T;
    if (attempt >= 6) throw new Error(`${url}: ${res.status} ${res.statusText}`);
    await sleep(1000 * attempt);
  }
}

/** Every transaction `address` sent, oldest first. */
async function sentBy(address: Address): Promise<BsTx[]> {
  const out: BsTx[] = [];
  let next: Record<string, unknown> | null = null;
  do {
    const params: Record<string, string> = { filter: "from" };
    for (const [k, v] of Object.entries(next ?? {})) params[k] = String(v);
    const page: { items: BsTx[]; next_page_params: Record<string, unknown> | null } = await getJson(`${API}/addresses/${address}/transactions?${new URLSearchParams(params)}`);
    out.push(...page.items.filter((t: BsTx) => t.from.hash.toLowerCase() === address.toLowerCase()));
    next = page.next_page_params;
    await sleep(250);
  } while (next);
  return out.reverse();
}

/** Blockscout's decoded revert, as the chain's own signature: IdleTooLarge(738550211640646, 9). */
function revertOf(t: BsTx): string | undefined {
  const r = t.revert_reason;
  if (!r?.method_call) return undefined;
  const name = r.method_call.split("(")[0];
  const args = (r.parameters ?? []).map((p) => (Array.isArray(p.value) ? `[${p.value.join(", ")}]` : String(p.value)));
  return `${name}(${args.join(", ")})`;
}

function relayerAddress(): Address | null {
  const given = arg("relayer");
  if (given && isAddress(given)) return getAddress(given);
  const env = join(ROOT, ".env");
  if (existsSync(env)) process.loadEnvFile(env);
  const key = process.env.RELAYER_PRIVATE_KEY?.trim().replace(/^0x/i, "");
  return key && /^[0-9a-fA-F]{64}$/.test(key) ? privateKeyToAccount(`0x${key}`).address : null;
}

async function main() {
  const info = NETWORKS["base-sepolia"];
  const manifest = parseManifest(JSON.parse(readFileSync(manifestPath(RECORDS), "utf8")));
  const runtime = JSON.parse(readFileSync(runtimePath(RECORDS), "utf8")) as Runtime;
  if (!manifest.deployer) throw new Error(`deployments/${RECORDS}.json records no deployer`);

  // The proofs, and the helpers they name.
  const stories: Partial<Record<StoryKey, ProofFile>> = {};
  for (const [story, suffix] of Object.entries(STORY_FILES) as [StoryKey, string][]) {
    const path = join(ROOT, "deployments", `${RECORDS}${suffix}.proof.json`);
    if (existsSync(path)) stories[story] = JSON.parse(readFileSync(path, "utf8")) as ProofFile;
  }
  const roles = new Map<string, LedgerRole>([[manifest.deployer.toLowerCase(), "deployer"]]);
  const addRole = (a: Address | undefined, r: LedgerRole) => {
    if (a && !roles.has(a.toLowerCase())) roles.set(a.toLowerCase(), r);
  };
  for (const s of Object.values(stories)) {
    addRole(s?.keeper, "keeper");
    addRole(s?.lp, "lp");
    addRole(s?.curator2, "curator2");
    addRole(s?.issuer2, "issuer2");
    addRole(s?.attacker, "attacker");
  }
  const relayer = relayerAddress();
  if (relayer) addRole(relayer, "relayer");
  else log("no relayer address (pass --relayer 0x…): its transactions are left out");

  // What each address the keys talk to is.
  const vaults = runtime.launches.map((l) => ({
    vault: getAddress(l.vault),
    symbol: l.symbol,
  }));
  const targets = new Map<string, { name: string; abi?: Abi; contract?: string; vault?: Address }>();
  const put = (a: Address | undefined, name: string, abi?: Abi, contract?: string, vault?: Address) =>
    a && targets.set(a.toLowerCase(), { name, abi, contract, vault });
  put(manifest.factory, "CovenantFactory", covenantFactoryAbi as Abi, "CovenantFactory");
  put(manifest.lbpStrategy, "LBPStrategy", lbpStrategyAbi as Abi, "LBPStrategy");
  put(manifest.swapRouter, "PoolSwapTest", poolSwapTestAbi as Abi, "PoolSwapTest");
  put(manifest.liquidityRouter, "PoolModifyLiquidityTest", liquidityRouterAbi as Abi, "PoolModifyLiquidityTest");
  put(manifest.positionManager, "PositionManager", positionManagerAbi as Abi, "PositionManager");
  for (const l of runtime.launches) {
    put(l.vault, `${l.symbol} vault`, covenantVaultAbi as Abi, "CovenantVault", getAddress(l.vault));
    put(l.token, `${l.symbol} token`, launchTokenAbi as Abi, "LaunchToken", getAddress(l.vault));
    if (l.auction) put(l.auction, `${l.symbol} auction`, ccaAbi as Abi, "CCA", getAddress(l.vault));
  }
  for (const [a, r] of roles) targets.set(a, { name: r });

  // Which proof step each hash is.
  const steps = new Map<string, { story: StoryKey; step: string; title: string; error?: string }>();
  for (const [story, s] of Object.entries(stories) as [StoryKey, ProofFile][]) {
    for (const [step, x] of Object.entries(s.steps))
      steps.set(x.hash.toLowerCase(), {
        story,
        step,
        title: x.title,
        error: x.error,
      });
  }

  const txs: LedgerTx[] = [];
  for (const [address, role] of roles) {
    const sent = await sentBy(address as Address);
    log(`${role} ${address}: ${sent.length} transactions`);
    for (const t of sent) {
      if (t.block_number < (manifest.deployedAtBlock ?? 0) - 1000) continue;
      const to = t.to?.hash ? getAddress(t.to.hash) : null;
      const tgt = to ? targets.get(to.toLowerCase()) : undefined;
      let fn: string;
      if (t.created_contract) fn = "deploy";
      else if (!t.raw_input || t.raw_input === "0x") fn = "transfer";
      else if (tgt?.abi) {
        try {
          fn = `${tgt.contract}.${decodeFunctionData({ abi: tgt.abi, data: t.raw_input }).functionName}`;
        } catch {
          fn = `${tgt.contract}.${t.method ?? t.raw_input.slice(0, 10)}`;
        }
      } else fn = t.method ?? t.raw_input.slice(0, 10);
      const known = steps.get(t.hash.toLowerCase());
      const status = t.status === "error" ? "reverted" : "success";
      txs.push({
        hash: t.hash,
        block: t.block_number,
        time: t.timestamp,
        from: getAddress(t.from.hash),
        role,
        to,
        target: t.created_contract ? `new contract ${getAddress(t.created_contract.hash)}` : (tgt?.name ?? (to ? "other" : "?")),
        ...(tgt?.vault ? { vault: tgt.vault } : {}),
        fn,
        status,
        ...(status === "reverted" ? { error: known?.error ?? revertOf(t) ?? "reverted" } : {}),
        ...(known ? { story: known.story, step: known.step, title: known.title } : {}),
      });
    }
  }
  txs.sort((a, b) => a.block - b.block || a.hash.localeCompare(b.hash));

  const coverage: CoverageRow[] = CATALOGUE.map((c) => {
    const names = fnNames(c).map((f) => `${c.contract}.${f}`);
    const mine = txs.filter((t) => names.includes(t.fn));
    return {
      contract: c.contract,
      fn: fnNames(c).join(" / "),
      who: c.who,
      what: c.what,
      settled: mine.filter((t) => t.status === "success").map((t) => ({ hash: t.hash, ...(t.vault ? { vault: t.vault } : {}) })),
      refused: mine
        .filter((t) => t.status === "reverted")
        .map((t) => ({
          hash: t.hash,
          error: t.error ?? "reverted",
          ...(t.vault ? { vault: t.vault } : {}),
        })),
    };
  });

  const symbolOf = (vault: Address) => vaults.find((x) => x.vault.toLowerCase() === vault.toLowerCase())?.symbol ?? "?";
  const attacks: Ledger["attacks"] = {};
  for (const [card, refs] of Object.entries(ATTACK_TXS)) {
    attacks[card] = refs.flatMap(([story, step]) => {
      const s = stories[story];
      const x = s?.steps[step];
      return x && s
        ? [
            {
              story,
              step,
              hash: x.hash,
              status: x.status,
              ...(x.error ? { error: x.error } : {}),
              vault: getAddress(s.vault),
              symbol: symbolOf(s.vault),
            },
          ]
        : [];
    });
  }

  const latest = txs.at(-1)?.block ?? 0;
  const addresses: Ledger["addresses"] = {};
  for (const [a, r] of roles) (addresses[r] ??= []).push(getAddress(a));
  const ledger: Ledger = {
    network: info.name,
    chainId: info.chainId,
    explorer: info.caps.explorer ?? "",
    generatedAt: new Date().toISOString(),
    generatedAtBlock: latest,
    addresses,
    vaults,
    txs,
    coverage,
    attacks,
  };
  const out = join(ROOT, "deployments", `${RECORDS}.ledger.json`);
  writeFileSync(out, JSON.stringify(ledger, null, 2) + "\n");

  const missing = coverage.filter((c) => !c.settled.length);
  const bare = Object.entries(attacks).filter(([, l]) => !l.length);
  log(`${txs.length} transactions, ${txs.filter((t) => t.status === "reverted").length} of them refusals; written to ${out}`);
  log(
    `functions settled: ${coverage.length - missing.length} of ${coverage.length}${missing.length ? ` (none yet: ${missing.map((c) => `${c.contract}.${c.fn}`).join(", ")})` : ""}`,
  );
  log(
    `attack cards with a transaction: ${Object.keys(attacks).length - bare.length} of ${Object.keys(attacks).length}${bare.length ? ` (none yet: ${bare.map(([k]) => k).join(", ")})` : ""}`,
  );
}

main().catch((e) => {
  console.error(`ledger: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
