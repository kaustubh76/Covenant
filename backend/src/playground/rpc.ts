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
    else forward.push({ jsonrpc: "2.0", id: r.id, method: r.method, params: r.params ?? [] });
  });
  return { batch, forward, refused, size: items.length };
}

/** Forward the allowed calls to `url` and answer every call, in the order it was asked. */
export async function proxy(url: string, body: string, timeoutMs = 120_000): Promise<unknown> {
  const { batch, forward, refused, size } = screen(body);
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
    out.push(queue?.shift() ?? refuse(req.id, -32603, "No answer from the chain"));
  }
  return batch ? out : out[0];
}
