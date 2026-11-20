// The live Base Sepolia deployment as the landing page shows it: the contracts' real addresses and the live proof's
// transactions. Read from deployments/ while the page is prerendered, so showing them calls no RPC.

import type { Address, Hex } from "viem";
import { BASE_SEPOLIA_CHAIN_ID, NETWORKS, type Runtime, parseManifest } from "@/chain/network";
import type { StoryKey } from "@/chain/scenarios/onchain";
import { readJson, recordFile } from "./deployments";

export interface LiveContract {
  label: string;
  address: Address;
}

/** One transaction of the live proof (web/scripts/lib/proof.ts writes them). */
export interface LiveStep {
  key: string;
  title: string;
  status: "success" | "reverted";
  hash: Hex;
  block: number;
  detail: string;
  /** The decoded revert, for the transaction meant to fail. */
  error?: string;
}

/** One recorded run on the live chain: a vault and the transactions that prove something about it. */
export interface LiveStory {
  key: StoryKey;
  /** False for the records that back the attack lab and the ledger but are not told as a walkthrough of their own. */
  listed?: boolean;
  title: string;
  vault: Address;
  symbol: string;
  steps: LiveStep[];
}

export interface LiveDeployment {
  network: string;
  chainId: number;
  /** Block explorer base URL, e.g. https://sepolia.basescan.org. */
  explorer: string;
  vault: Address;
  token: Address;
  symbol: string;
  hook: Address;
  contracts: LiveContract[];
  /** The covenant proof against the default vault, in story order; empty until one has run. */
  steps: LiveStep[];
  /** Every finished proof on record, the covenant proof first. */
  stories: LiveStory[];
}

/**
 * Each proof's story, in order. Gas and token top-ups are plumbing and left out. A proof file's name is
 * `<records><suffix>.proof.json`, written by web/scripts/lib/{proof,lpproof}.ts.
 */
const STORIES: { key: LiveStory["key"]; suffix: string; title: string; order: string[]; listed?: false }[] = [
  { key: "covenant", suffix: "", title: "A soft rug refused, support restored by a stranger", order: ["rug", "deepen", "crash", "restore", "fees", "refill"] },
  { key: "lp", suffix: "-lp", title: "An outside LP joins, earns and leaves, in kind", order: ["join", "buy", "sell", "collect", "claim", "leave"] },
  { key: "manage", suffix: "-manage", title: "Managed through a pump: what the curator may and may not do", order: ["pump", "chase", "recentre", "overpace"] },
  {
    key: "refusals",
    suffix: "-refusals",
    title: "The attack lab's one-call attacks, refused on chain",
    order: ["curatorWithdraw", "skim", "fragment", "issuerExit", "farm", "outsider", "vaultPays", "poke", "curatorFees"],
    listed: false,
  },
  {
    key: "lifecycle",
    suffix: "-lifecycle",
    title: "Every power used for real: handovers, the lock, the guard and the pump-ratchet",
    order: [
      ...["lockedEarly", "propose1", "cancel", "propose", "acceptEarly", "transferIssuer", "strangerIssuer", "acceptIssuer", "transferBack", "issuerBack"],
      ...["flashSell", "flashBuy", "flashCheck", "accept", "newCuratorRug", "curatorShares", "curatorPrincipal"],
      ...["principalOut", "lpJoin", "dump", "guardReshape", "guardDeposit", "guardRestore", "lpExitTripped", "buyBack"],
      ...["pump", "quickRestore", ...Array.from({ length: 14 }, (_, i) => `poke${i + 1}`), "patientRestore", "sellBack"],
      ...["curatorFees", "collect", "lpClaim"],
    ],
    listed: false,
  },
];
const STORY = STORIES[0].order;

type RawStep = Omit<LiveStep, "key">;
type RawProof = { vault?: string; finishedAtBlock?: number; steps?: Partial<Record<string, RawStep>> };

const stepsOf = (proof: RawProof, order: readonly string[]): LiveStep[] =>
  order.flatMap((key) => {
    const s = proof.steps?.[key];
    if (!s) return [];
    return [{ key, title: s.title, status: s.status, hash: s.hash, block: s.block, detail: s.detail, ...(s.error ? { error: s.error } : {}) }];
  });

/** Base Sepolia's deployment, its first live vault and its proof, or null if any of them is not on record. */
export async function liveDeployment(): Promise<LiveDeployment | null> {
  const info = NETWORKS["base-sepolia"];
  const raw = await readJson<unknown>(recordFile(`${info.records}.json`));
  const runtime = await readJson<Runtime>(recordFile(`${info.records}.runtime.json`));
  if (!raw || !runtime?.launches?.length) return null;
  let m;
  try {
    m = parseManifest(raw);
  } catch {
    return null;
  }
  if (m.chainId !== BASE_SEPOLIA_CHAIN_ID || !info.caps.explorer) return null;
  const same = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
  const launch = runtime.launches.find((l) => same(l.vault, runtime.defaultVault)) ?? runtime.launches.find((l) => l.adopted);
  if (!launch) return null;

  const proof = await readJson<RawProof>(recordFile(`${info.records}.proof.json`));
  const steps: LiveStep[] = proof && same(proof.vault, launch.vault) ? stepsOf(proof, STORY) : [];

  // Every finished proof whose vault is one of this chain's launches.
  const stories: LiveStory[] = [];
  for (const def of STORIES) {
    const p = await readJson<RawProof>(recordFile(`${info.records}${def.suffix}.proof.json`));
    const l = p && runtime.launches.find((x) => same(p.vault, x.vault));
    if (!p || !l || !p.finishedAtBlock) continue;
    const s = stepsOf(p, def.order);
    if (s.length) stories.push({ key: def.key, title: def.title, vault: l.vault, symbol: l.symbol, steps: s, ...(def.listed === false ? { listed: false } : {}) });
  }
  const others = runtime.launches.filter((l) => l.adopted && !same(l.vault, launch.vault));

  const contracts: (LiveContract | null)[] = [
    { label: `Vault · ${launch.symbol}/ETH`, address: launch.vault },
    { label: `${launch.symbol} token`, address: launch.token },
    { label: "Covenant hook", address: m.hook },
    { label: "Vault factory", address: m.factory },
    m.vaultImplementation ? { label: "Vault implementation", address: m.vaultImplementation } : null,
    { label: "Lens", address: m.lens },
    { label: "Seed planner", address: m.seedPlanner },
    { label: "CCA auction", address: launch.auction },
    // later launches on the same deployment, such as the LP proof's
    ...others.flatMap((l) => [
      { label: `Vault · ${l.symbol}/ETH`, address: l.vault },
      { label: `${l.symbol} token`, address: l.token },
    ]),
  ];

  return {
    network: info.name,
    chainId: m.chainId,
    explorer: info.caps.explorer,
    vault: launch.vault,
    token: launch.token,
    symbol: launch.symbol,
    hook: m.hook,
    contracts: contracts.filter((c): c is LiveContract => c !== null),
    steps,
    stories,
  };
}
