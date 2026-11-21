// The live Base Sepolia deployment as the landing page shows it: the contracts' real addresses and the live proof's
// transactions. Read from deployments/ while the page is prerendered, so showing them calls no RPC; each transaction's
// time comes from the ledger on record (deployments/84532.ledger.json), which read it back from the chain.

import type { Address, Hex } from "viem";
import type { Ledger } from "@/chain/ledger";
import { BASE_SEPOLIA_CHAIN_ID, NETWORKS, type Runtime, parseManifest } from "@/chain/network";
import type { StoryKey } from "@/chain/scenarios/onchain";
import { readJson, recordFile } from "./deployments";
import { liveLedger } from "./ledger";

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
  /** When its block was made (ISO), from the ledger on record; missing for a transaction the ledger does not list. */
  time?: string;
}

/** A transaction on record that the contracts refused, for the landing page's ticker. */
export interface LiveRefusal {
  hash: Hex;
  error: string;
  time: string;
  /** The launch it was sent to, when it names one. */
  symbol?: string;
}

/** A transaction on record that played one of the attack lab's attacks on the live chain. */
export interface LiveAttackTx {
  hash: Hex;
  status: "success" | "reverted";
  error?: string;
  symbol: string;
  time?: string;
}

/** What Sourcify said, while the page was built, about the core contracts' source. */
export interface SourcifyCheck {
  checkedAt: string;
  verified: LiveContract[];
  /** How many core contracts were asked about. */
  of: number;
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
  /** When the ledger on record was read back from the chain, and up to which block; null without a ledger. */
  asOf: { time: string; block: number } | null;
  /** Every refused transaction on record, oldest first. */
  refusals: LiveRefusal[];
  /** Each attack lab card's transactions on the live chain, by attack id. */
  attacks: Record<string, LiveAttackTx[]>;
  /** Sourcify's answer for the core contracts, checked while the page was built; null when it did not answer. */
  sourcify: SourcifyCheck | null;
}

/**
 * Each proof's story, in order. Gas and token top-ups are plumbing and left out. A proof file's name is
 * `<records><suffix>.proof.json`, written by web/scripts/lib/{proof,lpproof}.ts.
 */
const STORIES: { key: LiveStory["key"]; suffix: string; title: string; order: string[]; listed?: false }[] = [
  // The restore was sent by a second address the project funded (the proof's "keeper" step), not by a stranger.
  { key: "covenant", suffix: "", title: "A soft rug refused, support restored by a keeper for the bounty", order: ["rug", "deepen", "crash", "restore", "fees", "refill"] },
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

const stepsOf = (proof: RawProof, order: readonly string[], times: Map<string, string>): LiveStep[] =>
  order.flatMap((key) => {
    const s = proof.steps?.[key];
    if (!s) return [];
    const time = times.get(s.hash.toLowerCase());
    return [{ key, title: s.title, status: s.status, hash: s.hash, block: s.block, detail: s.detail, ...(s.error ? { error: s.error } : {}), ...(time ? { time } : {}) }];
  });

/** The core contracts whose source Sourcify matches, asked while the page is built. Null when Sourcify did not answer. */
export async function checkSourcify(chainId: number, contracts: LiveContract[]): Promise<SourcifyCheck | null> {
  const ask = async (c: LiveContract) => {
    const res = await fetch(`https://sourcify.dev/server/v2/contract/${chainId}/${c.address}`, { signal: AbortSignal.timeout(8000) });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`Sourcify answered ${res.status}`);
    const body = (await res.json()) as { match?: unknown; runtimeMatch?: unknown };
    return body.match === "match" || body.match === "exact_match" || body.runtimeMatch === "match" || body.runtimeMatch === "exact_match";
  };
  try {
    const answers = await Promise.all(contracts.map(ask));
    return { checkedAt: new Date().toISOString(), verified: contracts.filter((_, i) => answers[i]), of: contracts.length };
  } catch {
    return null; // no answer while building: the page then makes no claim about verification
  }
}

/** The ledger's refused transactions and each attack's transactions, with the times the ledger read back. */
function fromLedger(ledger: Ledger | null) {
  const times = new Map((ledger?.txs ?? []).map((t) => [t.hash.toLowerCase(), t.time]));
  const symbolOf = new Map((ledger?.vaults ?? []).map((v) => [v.vault.toLowerCase(), v.symbol]));
  const refusals: LiveRefusal[] = (ledger?.txs ?? [])
    .filter((t) => t.status === "reverted" && !!t.error)
    .map((t) => {
      const symbol = t.vault ? symbolOf.get(t.vault.toLowerCase()) : undefined;
      return { hash: t.hash, error: t.error!, time: t.time, ...(symbol ? { symbol } : {}) };
    });
  const attacks: Record<string, LiveAttackTx[]> = {};
  for (const [id, txs] of Object.entries(ledger?.attacks ?? {})) {
    attacks[id] = txs.map((t) => {
      const time = times.get(t.hash.toLowerCase());
      return { hash: t.hash, status: t.status, symbol: t.symbol, ...(t.error ? { error: t.error } : {}), ...(time ? { time } : {}) };
    });
  }
  const asOf = ledger ? { time: ledger.generatedAt, block: ledger.generatedAtBlock } : null;
  return { times, refusals, attacks, asOf };
}

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

  const ledger = await liveLedger();
  const { times, refusals, attacks, asOf } = fromLedger(ledger);
  const proof = await readJson<RawProof>(recordFile(`${info.records}.proof.json`));
  const steps: LiveStep[] = proof && same(proof.vault, launch.vault) ? stepsOf(proof, STORY, times) : [];

  // Every finished proof whose vault is one of this chain's launches.
  const stories: LiveStory[] = [];
  for (const def of STORIES) {
    const p = await readJson<RawProof>(recordFile(`${info.records}${def.suffix}.proof.json`));
    const l = p && runtime.launches.find((x) => same(p.vault, x.vault));
    if (!p || !l || !p.finishedAtBlock) continue;
    const s = stepsOf(p, def.order, times);
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

  const listed = contracts.filter((c): c is LiveContract => c !== null);
  // The deployment's own contracts (the hook, the factory, the implementation, the lens, the seed planner), not a
  // launch's token or vault clone.
  const core = listed.filter((c) => [m.hook, m.factory, m.vaultImplementation, m.lens, m.seedPlanner].some((a) => !!a && same(a, c.address)));
  return {
    network: info.name,
    chainId: m.chainId,
    explorer: info.caps.explorer,
    vault: launch.vault,
    token: launch.token,
    symbol: launch.symbol,
    hook: m.hook,
    contracts: listed,
    steps,
    stories,
    asOf,
    refusals,
    attacks,
    sourcify: await sourcifyOnce(m.chainId, core),
  };
}

// Three pages are prerendered from this (the landing page, the demo and the attack lab): ask Sourcify once per build.
// The unit tests (and COVENANT_SOURCIFY=off) make no network call.
let sourcify: Promise<SourcifyCheck | null> | null = null;
function sourcifyOnce(chainId: number, core: LiveContract[]): Promise<SourcifyCheck | null> {
  if (process.env.COVENANT_SOURCIFY === "off" || process.env.VITEST) return Promise.resolve(null);
  sourcify ??= checkSourcify(chainId, core);
  return sourcify;
}
