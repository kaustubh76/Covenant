// npm run verify:records [-- --rpc <url>]
//
// Re-reads, on Base Sepolia itself, everything the app shows "on record": every transaction in the proof records and
// the ledger (deployments/84532*.json) and every contract address the records name. Read-only.
//   - each transaction's receipt: its status, block, sender and target, as recorded;
//   - each refusal on record: replayed as a call against the state before its block and decoded, so the error the app
//     names is the one the chain gives (a mismatch only in the arguments is reported apart, since a block can hold other
//     transactions before it);
//   - each address: code is deployed there.
// Exits 1 on any mismatch, so it can gate a deploy.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, type Hex, createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { decodeRevert } from "../src/chain/errors";

const argv = process.argv.slice(2);
const at = argv.indexOf("--rpc");
const RPC = at >= 0 ? argv[at + 1] : (process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org");
const DIR = join(process.cwd(), "..", "deployments");
const read = (f: string) => JSON.parse(readFileSync(join(DIR, f), "utf8"));

interface Claim {
  hash: Hex;
  status: "success" | "reverted";
  block?: number;
  from?: string;
  to?: string;
  error?: string;
  where: string;
}

/** Every transaction the records claim, from the proofs' steps and the ledger, with where each claim was made. */
function claims(): Claim[] {
  const out: Claim[] = [];
  for (const f of ["84532.proof.json", "84532-lp.proof.json", "84532-manage.proof.json", "84532-refusals.proof.json", "84532-lifecycle.proof.json"]) {
    const r = read(f) as { steps: Record<string, { hash?: Hex; status?: string; block?: number; error?: string }> };
    for (const [name, s] of Object.entries(r.steps ?? {})) {
      if (!s.hash) continue;
      out.push({ hash: s.hash, status: s.status === "reverted" ? "reverted" : "success", block: s.block, error: s.error, where: `${f} ${name}` });
    }
  }
  const ledger = read("84532.ledger.json") as { txs: { hash: Hex; block: number; from: string; to: string; status: string; error?: string }[] };
  for (const t of ledger.txs) out.push({ hash: t.hash, status: t.status === "reverted" ? "reverted" : "success", block: t.block, from: t.from, to: t.to, error: t.error, where: `84532.ledger.json ${t.hash.slice(0, 10)}` });
  return out;
}

/** Every contract address the records name: the deployment, and each launch's vault, token and auction. */
function addresses(): { address: Address; what: string }[] {
  const m = read("84532.json") as Record<string, unknown>;
  const out = Object.entries(m)
    .filter(([k, v]) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && k !== "deployer")
    .map(([k, v]) => ({ address: v as Address, what: `84532.json ${k}` }));
  const rt = read("84532.runtime.json") as { launches: { vault: Address; token: Address; auction: Address; symbol: string }[] };
  for (const l of rt.launches) for (const k of ["vault", "token", "auction"] as const) out.push({ address: l[k], what: `${l.symbol} ${k}` });
  return out;
}

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC, { retryCount: 4, retryDelay: 600, batch: { batchSize: 20, wait: 25 } }) });
const lower = (x: string | null | undefined) => (x ?? "").toLowerCase();

async function main() {
  const all = claims();
  const byHash = new Map<string, Claim[]>();
  for (const c of all) byHash.set(lower(c.hash), [...(byHash.get(lower(c.hash)) ?? []), c]);
  const failures: string[] = [];
  const notes: string[] = [];
  let checked = 0;

  const hashes = [...byHash.keys()];
  for (let i = 0; i < hashes.length; i += 20) {
    await Promise.all(
      hashes.slice(i, i + 20).map(async (h) => {
        const cs = byHash.get(h)!;
        const [receipt, tx] = await Promise.all([pub.getTransactionReceipt({ hash: h as Hex }), pub.getTransaction({ hash: h as Hex })]);
        checked++;
        for (const c of cs) {
          if (receipt.status !== c.status) failures.push(`${c.where}: recorded ${c.status}, the chain says ${receipt.status}`);
          if (c.block !== undefined && Number(receipt.blockNumber) !== c.block) failures.push(`${c.where}: recorded block ${c.block}, mined in ${receipt.blockNumber}`);
          if (c.from && lower(c.from) !== lower(receipt.from)) failures.push(`${c.where}: recorded from ${c.from}, sent by ${receipt.from}`);
          if (c.to && lower(c.to) !== lower(receipt.to)) failures.push(`${c.where}: recorded to ${c.to}, sent to ${receipt.to}`);
        }
        const named = cs.find((c) => c.error)?.error;
        if (receipt.status === "reverted" && named) {
          // Replayed against the state its block started from: the refusal the chain gives for that call.
          const replay = await pub
            .call({ account: tx.from, to: tx.to ?? undefined, data: tx.input, value: tx.value, gas: tx.gas, blockNumber: receipt.blockNumber - 1n })
            .then(() => null)
            .catch((e: unknown) => decodeRevert(e).signature);
          const name = (s: string) => s.slice(0, s.indexOf("(") < 0 ? undefined : s.indexOf("("));
          if (replay === null) notes.push(`${cs[0].where}: the replay before its block went through (a transaction earlier in the same block set up the refusal); recorded ${named}`);
          else if (name(replay) !== name(named)) failures.push(`${cs[0].where}: recorded ${named}, the chain refuses with ${replay}`);
          else if (replay !== named) notes.push(`${cs[0].where}: ${name(named)} as recorded; arguments at the block's start ${replay} vs recorded ${named}`);
        }
      }),
    );
  }

  const where = addresses();
  const codes = await Promise.all(where.map((a) => pub.getCode({ address: a.address })));
  where.forEach((a, i) => {
    if (!codes[i] || codes[i] === "0x") failures.push(`${a.what}: no contract at ${a.address}`);
  });

  console.log(`verify:records against ${RPC}`);
  console.log(`  ${checked} transactions (${all.length} claims) re-read: status, block, sender and target`);
  console.log(`  ${all.filter((c) => c.status === "reverted" && c.error).length} refusal claims replayed and decoded`);
  console.log(`  ${where.length} contract addresses checked for code`);
  for (const n of notes) console.log(`  note: ${n}`);
  if (failures.length) {
    console.log(`\n${failures.length} mismatch${failures.length === 1 ? "" : "es"}:`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log("  ✓ every record matches the chain");
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
