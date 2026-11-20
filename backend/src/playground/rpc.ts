// The JSON-RPC a visitor may send to their Playground chain: everything the app uses, nothing that reaches the host.
//
// Denied by default, so a method Anvil adds later stays off until it is listed here. Off on purpose:
// - anvil_reset and anvil_setRpcUrl, which make Anvil fetch from any URL (server-side request forgery);
// - anvil_loadState and anvil_dumpState, which can exhaust the host's memory;
// - account impersonation, code and storage edits, and debug or trace calls, which the app does not need.

export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  // reads
  "eth_chainId", "net_version", "web3_clientVersion", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash",
  "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getTransactionCount", "eth_call", "eth_estimateGas",
  "eth_createAccessList", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_getTransactionByHash",
  "eth_getTransactionReceipt", "eth_getLogs", "eth_simulateV1", "eth_accounts", "eth_fillTransaction", "eth_blobBaseFee",
  "eth_syncing", "eth_getProof", "eth_getBlockTransactionCountByNumber", "eth_getBlockTransactionCountByHash",
  "eth_getTransactionByBlockNumberAndIndex", "eth_getBlockReceipts",
  "eth_newBlockFilter", "eth_newFilter", "eth_getFilterChanges", "eth_getFilterLogs", "eth_uninstallFilter",
  // writes, signed in the browser with the chain's dev keys
  "eth_sendRawTransaction",
  // the dev controls the app uses on its own chain: snapshots for the guided demo and the attack lab, the clock, mining
  "evm_snapshot", "evm_revert", "evm_mine", "anvil_mine", "evm_increaseTime", "evm_setNextBlockTimestamp",
  "anvil_setNextBlockTimestamp", "evm_setAutomine", "anvil_setAutomine",
  // the faucet
  "anvil_setBalance",
]);

export const MAX_BATCH = 100;

/**
 * The most blocks one call may mine. The app's largest is a launch's auction, about two hundred; Anvil keeps every block
 * in memory, so one unbounded anvil_mine could take the whole instance down, and every visitor's chain with it.
 */
export const MAX_MINE_PER_CALL = 1_000;

/**
 * How a chain is held to its share of the instance. Its memory follows its height above the seed (a revert gives the
 * room back to the next blocks), and every snapshot holds a copy of its state, so both are limited.
 */
export interface Meter {
  /** Blocks the chain stands above its seed right now. */
  height: () => Promise<number>;
  /** The chain's resident memory in MB, or null where it cannot be read. */
  memoryMb?: () => number | null;
  /** The snapshots the visitor holds, by id, oldest first: taken by evm_snapshot, given back by an evm_revert. */
  usage: { held: bigint[] };
  limits: { height: number; snapshots: number; memoryMb?: number };
}

/** How many blocks a call mines: anvil_mine's count, evm_mine's (a count in its options object, else one), one per raw transaction. Null when the count is not a number. */
export function blocksOf(method: string, params: unknown): number | null {
  const p = Array.isArray(params) ? params : [];
  const count = (v: unknown): number | null => {
    if (v === undefined || v === null) return 1;
    let b: bigint;
    try {
      if (typeof v === "number") {
        if (!Number.isSafeInteger(v)) return null;
        b = BigInt(v);
      } else if (typeof v === "string") b = BigInt(v);
      else return null;
    } catch {
      return null;
    }
    if (b < 0n) return null;
    return b > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(b);
  };
  if (method === "anvil_mine") return count(p[0]);
  if (method === "evm_mine") return p[0] && typeof p[0] === "object" ? count((p[0] as { blocks?: unknown }).blocks) : 1;
  if (method === "eth_sendRawTransaction") return 1;
  return 0;
}

const TOO_MANY_AT_ONCE = -32602;
const USED_UP = -32000;

interface Request {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}
interface Reply {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const refuse = (id: unknown, code: number, message: string): Reply => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Split a request body into the calls to forward and the refusals to answer directly. */
export function screen(body: string): { batch: boolean; forward: Request[]; refused: Map<number, Reply>; size: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw Object.assign(new Error("The body is not JSON."), { status: 400 });
  }
  const batch = Array.isArray(parsed);
  const items = (batch ? parsed : [parsed]) as unknown[];
  if (items.length === 0 || items.length > MAX_BATCH) throw Object.assign(new Error(`A batch holds 1 to ${MAX_BATCH} calls.`), { status: 400 });
  const forward: Request[] = [];
  const refused = new Map<number, Reply>();
  items.forEach((raw, i) => {
    const r = raw as Request;
    if (!r || typeof r !== "object" || typeof r.method !== "string") refused.set(i, refuse(r?.id, -32600, "Invalid request"));
    else if (!ALLOWED_METHODS.has(r.method)) refused.set(i, refuse(r.id, -32601, `${r.method} is not available on a Playground chain`));
    else {
      const params = r.params ?? [];
      const blocks = blocksOf(r.method, params);
      if (blocks === null) refused.set(i, refuse(r.id, TOO_MANY_AT_ONCE, `${r.method}: the number of blocks to mine is not a number.`));
      else if (blocks > MAX_MINE_PER_CALL) refused.set(i, refuse(r.id, TOO_MANY_AT_ONCE, `Mining ${blocks} blocks in one call is more than a Playground chain allows (${MAX_MINE_PER_CALL}).`));
      else forward.push({ jsonrpc: "2.0", id: r.id, method: r.method, params });
    }
  });
  return { batch, forward, refused, size: items.length };
}

const RESET = "Reset it to start again: the Reset button in the bar at the top of the page.";

/**
 * Refuse, in place, the forwarded calls that would take the chain past its limits: blocks mined past its height, or a
 * snapshot past those it may hold. `forward` keeps the calls that may go, in order.
 */
export async function hold(forward: Request[], refused: Map<number, Reply>, size: number, meter: Meter): Promise<void> {
  const at: number[] = [];
  for (let i = 0; i < size; i++) if (!refused.has(i)) at.push(i);
  const mines = forward.some((r) => (blocksOf(String(r.method), r.params) ?? 0) > 0);
  const grows = mines || forward.some((r) => r.method === "evm_snapshot");
  let height = mines ? await meter.height() : 0;
  let held = meter.usage.held.length;
  // Memory is what takes the instance down: past the limit, nothing that grows the chain goes on until it is reset.
  const mb = grows && meter.limits.memoryMb !== undefined ? (meter.memoryMb?.() ?? null) : null;
  const full = mb !== null && mb > meter.limits.memoryMb!;
  const keep: Request[] = [];
  forward.forEach((r, k) => {
    const blocks = blocksOf(String(r.method), r.params) ?? 0;
    if (full && (blocks > 0 || r.method === "evm_snapshot")) {
      refused.set(at[k], refuse(r.id, USED_UP, `This Playground chain has used the memory one chain may (${meter.limits.memoryMb} MB). ${RESET}`));
      return;
    }
    if (blocks > 0 && height + blocks > meter.limits.height) {
      refused.set(at[k], refuse(r.id, USED_UP, `This Playground chain is ${meter.limits.height} blocks past its seed, as far as one chain may go. ${RESET}`));
      return;
    }
    if (r.method === "evm_snapshot" && held + 1 > meter.limits.snapshots) {
      refused.set(at[k], refuse(r.id, USED_UP, `This Playground chain holds ${meter.limits.snapshots} snapshots and save points, the most one chain may: go back to one of them. ${RESET}`));
      return;
    }
    height += blocks;
    if (r.method === "evm_snapshot") held++;
    keep.push(r);
  });
  forward.splice(0, forward.length, ...keep);
}

/** Keep the held snapshots in step with what the chain answered: a new id for each snapshot, and a revert gives back its own and every later one. */
export function track(meter: Meter, req: Request, reply: Reply): void {
  try {
    if (req.method === "evm_snapshot" && typeof reply.result === "string") meter.usage.held.push(BigInt(reply.result));
    if (req.method === "evm_revert" && reply.result === true) {
      const id = BigInt((req.params as unknown[])[0] as string);
      meter.usage.held = meter.usage.held.filter((h) => h < id);
    }
  } catch {
    /* an id that is not a number: nothing to track */
  }
}

/** Forward the allowed calls to `url` and answer every call, in the order it was asked. */
export async function proxy(url: string, body: string, timeoutMs = 120_000, meter?: Meter): Promise<unknown> {
  const { batch, forward, refused, size } = screen(body);
  if (meter && forward.length) await hold(forward, refused, size, meter);
  let answers: Reply[] = [];
  if (forward.length) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(forward),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const got = (await res.json()) as Reply | Reply[];
    answers = Array.isArray(got) ? got : [got];
  }
  // Anvil answers a batch in order; match by id all the same, since ids need not be unique or present.
  const byId = new Map<string, Reply[]>();
  for (const a of answers) {
    const k = JSON.stringify(a.id ?? null);
    byId.set(k, [...(byId.get(k) ?? []), a]);
  }
  const out: Reply[] = [];
  let f = 0;
  for (let i = 0; i < size; i++) {
    const r = refused.get(i);
    if (r) {
      out.push(r);
      continue;
    }
    const req = forward[f++];
    const queue = byId.get(JSON.stringify(req.id ?? null));
    const reply = queue?.shift() ?? refuse(req.id, -32603, "No answer from the chain");
    if (meter) track(meter, req, reply);
    out.push(reply);
  }
  return batch ? out : out[0];
}
