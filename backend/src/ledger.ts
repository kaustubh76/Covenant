// The live end of the app's ledger: the newest Base Sepolia transactions the relayer sent and that anyone sent to the
// recorded vaults, read from Blockscout's public API and cached for everyone. The committed record of the project's own
// keys (deployments/84532.ledger.json, `npm run ledger`) covers the past; this covers what visitors are doing now.

import { type AbiFunction, type Address, type Hex, toFunctionSelector } from "viem";
import { covenantVaultAbi } from "../../web/src/chain/abi.generated";

/**
 * Blockscout names most calls, but not those to a vault: each vault is a minimal clone, so a call to it comes back as
 * its raw selector ("0x18178358"). The vault's own ABI names them: poke, collectFees, restore and the rest.
 */
const VAULT_FUNCTIONS = new Map(
  (covenantVaultAbi as readonly { type: string }[]).filter((x): x is AbiFunction => x.type === "function").map((f) => [toFunctionSelector(f).toLowerCase(), f.name]),
);
export const methodName = (m: string | null): string | null => (m && /^0x[0-9a-fA-F]{8}$/.test(m) ? (VAULT_FUNCTIONS.get(m.toLowerCase()) ?? m) : m);

export interface FeedTx {
  hash: Hex;
  block: number;
  time: string;
  from: Address;
  to: Address | null;
  /** The function, as Blockscout decodes it from the verified sources, or the selector. */
  method: string | null;
  status: "success" | "reverted" | "pending";
  /** The revert's name, when it reverted. */
  error?: string;
  /** Sent by the backend's relayer. */
  relayed: boolean;
  /** The recorded vault it went to, if any. */
  vault?: Address;
  symbol?: string;
}

interface BsTx {
  hash: Hex;
  block_number: number | null;
  timestamp: string | null;
  from: { hash: Address };
  to: { hash: Address } | null;
  status: "ok" | "error" | null;
  method: string | null;
  revert_reason: { method_call?: string } | null;
}

export interface LedgerOptions {
  relayer: Address | null;
  vaults: { vault: Address; symbol: string }[];
  api?: string;
  ttlMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export class LedgerFeed {
  private readonly o: Required<Omit<LedgerOptions, "relayer">> & { relayer: Address | null };
  private cache: { at: number; value: { updatedAt: string; relayer: Address | null; txs: FeedTx[] } } | null = null;
  private inflight: Promise<{ updatedAt: string; relayer: Address | null; txs: FeedTx[] }> | null = null;

  constructor(o: LedgerOptions) {
    this.o = { api: "https://base-sepolia.blockscout.com/api/v2", ttlMs: 30_000, fetch: globalThis.fetch.bind(globalThis), now: Date.now, ...o };
  }

  /** The newest transactions, at most 30 seconds old; the last good answer if Blockscout does not answer. */
  async latest() {
    const t = this.o.now();
    if (this.cache && t - this.cache.at < this.o.ttlMs) return this.cache.value;
    this.inflight ??= this.fresh()
      .then((value) => {
        this.cache = { at: this.o.now(), value };
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    try {
      return await this.inflight;
    } catch (e) {
      if (this.cache) return this.cache.value;
      throw e;
    }
  }

  private async page(address: Address, filter: "from" | "to"): Promise<BsTx[]> {
    const res = await this.o.fetch(`${this.o.api}/addresses/${address}/transactions?filter=${filter}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Blockscout answered ${res.status} for ${address}`);
    return ((await res.json()) as { items?: BsTx[] }).items ?? [];
  }

  private async fresh() {
    const vaultOf = new Map(this.o.vaults.map((v) => [v.vault.toLowerCase(), v]));
    const relayer = this.o.relayer?.toLowerCase() ?? null;
    const lists = await Promise.all([
      ...(this.o.relayer ? [this.page(this.o.relayer, "from")] : []),
      ...this.o.vaults.map((v) => this.page(v.vault, "to")),
    ]);
    const seen = new Map<string, FeedTx>();
    for (const t of lists.flat()) {
      if (seen.has(t.hash)) continue;
      const v = t.to ? vaultOf.get(t.to.hash.toLowerCase()) : undefined;
      const status = t.status === "ok" ? "success" : t.status === "error" ? "reverted" : "pending";
      seen.set(t.hash, {
        hash: t.hash,
        block: t.block_number ?? 0,
        time: t.timestamp ?? "",
        from: t.from.hash,
        to: t.to?.hash ?? null,
        method: methodName(t.method),
        status,
        ...(status === "reverted" ? { error: t.revert_reason?.method_call?.split("(")[0] ?? "reverted" } : {}),
        relayed: t.from.hash.toLowerCase() === relayer,
        ...(v ? { vault: v.vault, symbol: v.symbol } : {}),
      });
    }
    const txs = [...seen.values()].sort((a, b) => (b.block || Number.MAX_SAFE_INTEGER) - (a.block || Number.MAX_SAFE_INTEGER)).slice(0, 40);
    return { updatedAt: new Date(this.o.now()).toISOString(), relayer: this.o.relayer, txs };
  }
}
