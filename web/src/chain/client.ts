import {
  type Account,
  type Address,
  type Chain,
  type PublicClient,
  type TestClient,
  type Transport,
  type WalletClient,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { type Actor, addressOf, devKey } from "./accounts";
import type { Network } from "./network";

/**
 * Who signs on a public chain, where there are no dev keys: a private key (the launch script), an address the node
 * signs for (an Anvil fork's unlocked accounts), or a browser wallet's account with the wallet's own transport.
 */
export interface ExternalSigner {
  account: Account | Address;
  /** Where transactions go. Defaults to the network's RPC, which is right for keys and unlocked accounts. */
  transport?: Transport;
}

/** Everything needed to talk to one chain: a reader, the signers and, on a dev chain, the Anvil controls. */
export interface ChainCtx {
  net: Network;
  chain: Chain;
  pub: PublicClient<Transport, Chain>;
  /** Anvil controls (time, snapshots, mining). Null on public chains. */
  test: TestClient<"anvil", Transport, Chain> | null;
  /** On a public chain, the one account that signs for every role. Null on the dev chain, or with no wallet. */
  signer: Address | null;
  /** On a public chain with no signer: the network a connected wallet is on instead, when it is on another one. */
  walletChainId: number | null;
  wallet(actor: Actor): WalletClient<Transport, Chain, Account>;
  /** The address acting as `actor`: its dev account locally; the signer, whatever the role, on a public chain. */
  address(actor: Actor): Address;
}

function chainOf(net: Network): Chain {
  const rpcUrls = { default: { http: [net.rpcUrl] } };
  // viem's definition carries Multicall3 and the OP-stack block and transaction formats (deposit transactions).
  if (net.chainId === baseSepolia.id) {
    return defineChain({ ...baseSepolia, name: net.name, rpcUrls, blockExplorers: net.caps.explorer ? baseSepolia.blockExplorers : undefined });
  }
  return defineChain({
    id: net.chainId,
    name: net.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls,
    // The local chain runs with a zero base fee, so transactions cost nothing and P&L figures are exact.
    fees: net.caps.devChain ? { baseFeeMultiplier: 1, maxPriorityFeePerGas: 0n } : undefined,
  });
}

/**
 * Base Sepolia's public endpoint answers more than 25 calls a second with JSON-RPC error -32007 ("request limit
 * reached"), or with HTTP 429. viem does not retry the first at all, and retries the second only three times within a
 * second, so a burst of reads (a page's first log scans) could fail outright. Retry both after a short, growing,
 * jittered pause; any other error passes straight through.
 */
export function patient(inner: Transport, tries = 6, baseMs = 200, perSecond = 12, burst = 4): Transport {
  return (opts) => {
    const t = inner(opts);
    // Paced under the limit to begin with, so a page's first burst of log scans queues for a moment instead of being
    // refused and retried. A batched request counts each call in it, so the pace is per call. Any one second carries at
    // most burst + perSecond calls (16), leaving the rest of the endpoint's 25 to whatever else shares the address.
    const turn = pacer(perSecond, burst);
    const request = async (args: unknown, options?: unknown): Promise<unknown> => {
      for (let attempt = 1; ; attempt++) {
        await turn();
        try {
          return await t.request(args as never, options as never);
        } catch (e) {
          if (attempt >= tries || !rateLimited(e)) throw e;
          await new Promise((r) => setTimeout(r, baseMs * 2 ** attempt + Math.random() * baseMs));
        }
      }
    };
    return { ...t, request: request as unknown as typeof t.request };
  };
}

/** Reads whose answers do not change once the chain has moved past them: logs, receipts, transactions, code, past blocks. */
const SHARED = new Set(["eth_getLogs", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getCode", "eth_chainId", "eth_getBlockByHash"]);
export function sharedRead(args: unknown): boolean {
  const { method, params } = args as { method?: string; params?: unknown };
  if (!method) return false;
  if (SHARED.has(method)) return true;
  return method === "eth_getBlockByNumber" && Array.isArray(params) && typeof params[0] === "string" && /^0x[0-9a-f]+$/i.test(params[0]);
}

/**
 * Base Sepolia's history through Covenant's backend, its shared cache (backend/src/readcache); everything else, and
 * whatever the backend cannot answer, from the public endpoint directly.
 *
 * Only reads that do not change go through the backend (sharedRead): the logs, receipts and blocks a page's feed scans,
 * which every visitor asks for alike, so after the first one they come from the cache at once. Reads of the head (calls,
 * balances, simulations, the block number) stay direct: each visitor's browser has its own rate budget at the public
 * endpoint, and pooling them all behind the backend's one address would only share a single budget and add a hop.
 *
 * A backend that gives no answer (asleep on Render's free plan, busy, restarting, not serving the method) is left alone
 * for `downMs`, so a sleeping one costs one slow call, not one per call. Only a failure to get an answer falls back; the
 * chain's own answer, a revert included, is the answer.
 */
export function preferBackend(backend: Transport, direct: Transport, downMs = 30_000, now: () => number = () => performance.now()): Transport {
  return (opts) => {
    const b = backend(opts);
    const d = direct(opts);
    let downUntil = -Infinity;
    const request = async (args: unknown, options?: unknown): Promise<unknown> => {
      if (sharedRead(args) && now() >= downUntil) {
        try {
          return await b.request(args as never, options as never);
        } catch (e) {
          if (!noAnswer(e)) throw e;
          downUntil = now() + downMs;
        }
      }
      return d.request(args as never, options as never);
    };
    return { ...d, request: request as unknown as typeof d.request };
  };
}

/** Whether `e` means no answer came: the request failed, timed out, was refused, or asked for something not served. */
function noAnswer(e: unknown): boolean {
  if (rateLimited(e)) return true;
  for (let x = e as { name?: unknown; code?: unknown; status?: unknown; cause?: unknown } | undefined, depth = 0; x && depth < 4; x = x.cause as typeof x, depth++) {
    if (x.name === "HttpRequestError" || x.name === "TimeoutError" || x.name === "AbortError" || x.name === "TypeError") return true;
    if (typeof x.status === "number" && x.status >= 400) return true;
    if (x.code === -32601) return true;
  }
  return false;
}

/** A token bucket: `burst` turns at once, then `perSecond` a second; the rest wait their turn, in order. */
export function pacer(perSecond: number, burst = perSecond): () => Promise<void> {
  let tokens = burst;
  // A monotonic clock: a wall clock stepped backwards would stall every call until it caught up.
  let last = performance.now();
  const queue: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pump = () => {
    timer = null;
    const now = performance.now();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * perSecond);
    last = now;
    while (queue.length && tokens >= 1) {
      tokens -= 1;
      queue.shift()!();
    }
    if (queue.length) timer = setTimeout(pump, Math.ceil(((1 - tokens) / perSecond) * 1000));
  };
  return () =>
    new Promise<void>((resolve) => {
      queue.push(resolve);
      if (!timer) pump();
    });
}

function rateLimited(e: unknown): boolean {
  for (let x = e as { code?: unknown; status?: unknown; message?: unknown; cause?: unknown } | undefined, depth = 0; x && depth < 4; x = x.cause as typeof x, depth++) {
    if (x.code === -32007 || x.code === 429 || x.status === 429) return true;
    if (typeof x.message === "string" && /request limit reached|rate limit/i.test(x.message)) return true;
  }
  return false;
}

/** What it takes to sign on `net` from here: the connect or switch a send would need, in a sentence. */
export const signerNeeded = (net: Pick<Network, "name" | "chainId">, walletChainId: number | null) =>
  walletChainId !== null && walletChainId !== net.chainId
    ? `Your wallet is on another network (chain ${walletChainId}): switch it to ${net.name} to send this.`
    : `Connect a wallet to send transactions on ${net.name}.`;

/** `opts.walletChainId`: a wallet is connected, but on that network rather than `net`'s, so nothing signs here yet. */
export function createChainCtx(net: Network, signer?: ExternalSigner, opts: { walletChainId?: number } = {}): ChainCtx {
  const chain = chainOf(net);
  const dev = net.caps.devChain;
  // Public RPCs rate-limit: batch concurrent reads into one request, retry transient failures, and back off when the
  // endpoint says it is busy. Anvil needs none of that, and a failed local call should fail at once.
  // The local chain answers at once: no retries. The Playground's chain is the same kind of chain behind an HTTPS hop to
  // the backend, so its calls are batched (one round trip for the many reads of a refresh) and retried on a dropped
  // connection or a 429. A public RPC gets its own pacing (patient).
  const direct = () => patient(http(net.rpcUrl, { retryCount: 3, timeout: 60_000, batch: { batchSize: 50, wait: 16 } }));
  const transport =
    net.key === "playground"
      ? http(net.rpcUrl, { retryCount: 3, retryDelay: 400, timeout: 120_000, batch: { batchSize: 50, wait: 8 } })
      : dev
        ? http(net.rpcUrl, { retryCount: 0, timeout: 120_000 })
        : net.backend
          ? // History through the backend's shared cache when it answers; the rest, and any fallback, direct and paced.
            preferBackend(http(`${net.backend}/rpc/${net.key}`, { retryCount: 0, timeout: 8_000, batch: { batchSize: 50, wait: 16 } }), direct())
          : direct();
  const pub = createPublicClient({ chain, transport, pollingInterval: net.caps.pollMs, cacheTime: 0 });
  const test = dev ? createTestClient({ chain, transport, mode: "anvil" }) : null;
  const external =
    !dev && signer ? createWalletClient({ chain, transport: signer.transport ?? transport, account: signer.account }) : null;

  const wallets = new Map<Actor, WalletClient<Transport, Chain, Account>>();
  const walletChainId = !dev && !signer ? (opts.walletChainId ?? null) : null;
  const noSigner = () => new Error(signerNeeded(net, walletChainId));
  return {
    net,
    chain,
    pub,
    test,
    signer: external ? external.account.address : null,
    walletChainId,
    wallet(actor) {
      if (!dev) {
        if (!external) throw noSigner();
        return external;
      }
      let w = wallets.get(actor);
      if (!w) {
        // Signing with dev keys is a local-chain feature only; devKey() refuses any other chain id.
        w = createWalletClient({ chain, transport, account: privateKeyToAccount(devKey(actor, net.chainId)) });
        wallets.set(actor, w);
      }
      return w;
    },
    address(actor) {
      if (dev) return addressOf(actor);
      if (!external) throw noSigner();
      return external.account.address;
    },
  };
}

/** The Anvil controls, or a clear error when the current chain has none. */
export function devControls(ctx: ChainCtx): TestClient<"anvil", Transport, Chain> {
  if (!ctx.test) throw new Error(`${ctx.net.name} is a public chain: time travel and snapshots are local-chain features`);
  return ctx.test;
}
