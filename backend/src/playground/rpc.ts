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
  // the chain's instance id and the snapshots it lists, for the app's save points: nothing about the host
  "anvil_metadata",
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
  /**
   * The snapshots the chain still holds for the visitor, by id, oldest first: taken by evm_snapshot, given back by an
   * evm_revert. Exact for the calls that come through here (`exclusive` keeps them in order), so a revert to any other
   * id is answered here and never reaches Anvil. The baseline a reset reverts to is not among them.
   */
  usage: { held: bigint[] };
  limits: { height: number; snapshots: number; memoryMb?: number };
  /** Told of each call refused, for the log. */
  onRefuse?: (why: string) => void;
  /** Runs calls that take or revert a snapshot one at a time on this chain, and with its resets. */
  exclusive?: <T>(job: () => Promise<T>) => Promise<T>;
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
  let height = mines && Number.isFinite(meter.limits.height) ? await meter.height() : 0;
  let held = meter.usage.held.length;
  // Memory is what takes the instance down: past the limit, nothing that grows the chain goes on until it is reset.
  const mb = grows && meter.limits.memoryMb !== undefined ? (meter.memoryMb?.() ?? null) : null;
  const full = mb !== null && mb > meter.limits.memoryMb!;
  const keep: Request[] = [];
  forward.forEach((r, k) => {
    const blocks = blocksOf(String(r.method), r.params) ?? 0;
    if (full && (blocks > 0 || r.method === "evm_snapshot")) {
      refused.set(at[k], refuse(r.id, USED_UP, `This Playground chain has used the memory one chain may (${meter.limits.memoryMb} MB). ${RESET}`));
      meter.onRefuse?.(`${r.method}: memory ${Math.round(mb!)} MB, past ${meter.limits.memoryMb}`);
      return;
    }
    if (blocks > 0 && height + blocks > meter.limits.height) {
      refused.set(at[k], refuse(r.id, USED_UP, `This Playground chain is ${meter.limits.height} blocks past its seed, as far as one chain may go. ${RESET}`));
      meter.onRefuse?.(`${r.method}: ${blocks} more blocks at height ${height}, past ${meter.limits.height}`);
      return;
    }
    if (r.method === "evm_snapshot" && held + 1 > meter.limits.snapshots) {
      refused.set(at[k], refuse(r.id, USED_UP, `This Playground chain holds ${meter.limits.snapshots} snapshots and save points, the most one chain may: go back to one of them. ${RESET}`));
      meter.onRefuse?.(`evm_snapshot: ${held} held, the most is ${meter.limits.snapshots}`);
      return;
    }
    height += blocks;
    if (r.method === "evm_snapshot") held++;
    keep.push(r);
  });
  forward.splice(0, forward.length, ...keep);
}

/**
 * A snapshot id as Anvil reads it: a hex string or a whole number. Null for anything else, which is then never sent: an
 * id read one way here and another way by Anvil could revert to a snapshot that was never checked.
 */
export function snapshotId(v: unknown): bigint | null {
  if (typeof v === "string" && /^0x[0-9a-f]{1,64}$/i.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
}

const takesOrReverts = (r: Request) => r.method === "evm_snapshot" || r.method === "evm_revert";

/**
 * After any revert Anvil ran, whatever it answered, the chain holds none of the snapshots from that id on. A revert
 * consumes its own snapshot, and Anvil's state store drops every later one even when it answers false.
 */
function giveBack(meter: Meter, req: Request): void {
  const id = snapshotId((req.params as unknown[] | undefined)?.[0]);
  if (id !== null) meter.usage.held = meter.usage.held.filter((h) => h < id);
}

/** Keep the held snapshots in step with what the chain answered: a new id for each snapshot, and a revert gives back its own and every later one. */
export function track(meter: Meter, req: Request, reply: Reply): void {
  if (req.method === "evm_snapshot") {
    const id = snapshotId(reply.result);
    if (id !== null) meter.usage.held.push(id);
  }
  if (req.method === "evm_revert") giveBack(meter, req);
}

/**
 * Split the calls into pieces sent one after another: each snapshot or revert alone, the calls between them together.
 * Anvil runs a batch's calls concurrently, so only between pieces does a batch's order hold on the chain. Then the held
 * snapshots follow the chain, and a read before a snapshot sees the chain before it, a read after, after.
 */
export function pieces(calls: Request[]): Request[][] {
  const out: Request[][] = [];
  let cur: Request[] = [];
  for (const r of calls) {
    if (!takesOrReverts(r)) {
      cur.push(r);
      continue;
    }
    if (cur.length) out.push(cur);
    out.push([r]);
    cur = [];
  }
  if (cur.length) out.push(cur);
  return out;
}

async function send(url: string, calls: Request[], timeoutMs: number): Promise<Reply[]> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(calls),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const got = (await res.json()) as Reply | Reply[];
  // Anvil answers a batch in order; match by id all the same, since ids need not be unique or present.
  const byId = new Map<string, Reply[]>();
  for (const a of Array.isArray(got) ? got : [got]) {
    const k = JSON.stringify(a.id ?? null);
    byId.set(k, [...(byId.get(k) ?? []), a]);
  }
  return calls.map((c) => byId.get(JSON.stringify(c.id ?? null))?.shift() ?? refuse(c.id, -32603, "No answer from the chain"));
}

/**
 * Answer the calls in order, piece by piece. A revert goes to Anvil only if the chain still holds its snapshot, checked
 * just before its piece is sent. Anvil handles a revert to any other id badly. To an id that a revert to an earlier one
 * made stale, it takes the blocks and the clock back but not the state, or leaves its head on a block it no longer has.
 * To an id already consumed, it drops every later snapshot. Either way it answers false, as it does here.
 */
async function answer(url: string, forward: Request[], timeoutMs: number, meter?: Meter): Promise<Reply[]> {
  if (!meter) return forward.length ? send(url, forward, timeoutMs) : [];
  const replies: Reply[] = [];
  for (const piece of pieces(forward)) {
    const here = new Map<Request, Reply>();
    for (const r of piece) {
      if (r.method !== "evm_revert") continue;
      const id = snapshotId((r.params as unknown[] | undefined)?.[0]);
      if (id !== null && meter.usage.held.includes(id)) continue;
      here.set(r, { jsonrpc: "2.0", id: r.id ?? null, result: false });
      meter.onRefuse?.(`evm_revert(${String((r.params as unknown[] | undefined)?.[0]).slice(0, 24)}): not a snapshot this chain holds`);
    }
    const go = piece.filter((r) => !here.has(r));
    let got: Reply[] = [];
    if (go.length) {
      try {
        got = await send(url, go, timeoutMs);
      } catch (e) {
        // No answer: the revert may have run, so its snapshots are given back as if it had.
        for (const r of go) if (r.method === "evm_revert") giveBack(meter, r);
        throw e;
      }
    }
    let g = 0;
    for (const r of piece) {
      const mine = here.get(r);
      if (mine) {
        replies.push(mine);
        continue;
      }
      const reply = got[g++];
      track(meter, r, reply);
      replies.push(reply);
    }
  }
  return replies;
}

/**
 * Forward the allowed calls to the chain at `url` and answer every call, in the order it was asked. `url` may be read
 * late: a call that waited for a reset to finish goes to the chain the reset left.
 */
export async function proxy(url: string | (() => string), body: string, timeoutMs = 120_000, meter?: Meter): Promise<unknown> {
  const { batch, forward, refused, size } = screen(body);
  const run = async (): Promise<unknown> => {
    if (meter && forward.length) await hold(forward, refused, size, meter);
    const replies = await answer(typeof url === "function" ? url() : url, forward, timeoutMs, meter);
    const out: Reply[] = [];
    let f = 0;
    for (let i = 0; i < size; i++) out.push(refused.get(i) ?? replies[f++]);
    return batch ? out : out[0];
  };
  return meter?.exclusive && forward.some(takesOrReverts) ? meter.exclusive(run) : run();
}
