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

export function createChainCtx(net: Network, signer?: ExternalSigner): ChainCtx {
  const chain = chainOf(net);
  const dev = net.caps.devChain;
  // Public RPCs rate-limit: batch concurrent reads into one request, retry transient failures, and back off when the
  // endpoint says it is busy. Anvil needs none of that, and a failed local call should fail at once.
  // The local chain answers at once: no retries. The Playground's chain is the same kind of chain behind an HTTPS hop to
  // the backend, so its calls are batched (one round trip for the many reads of a refresh) and retried on a dropped
  // connection or a 429. A public RPC gets its own pacing (patient).
  const transport =
    net.key === "playground"
      ? http(net.rpcUrl, { retryCount: 3, retryDelay: 400, timeout: 120_000, batch: { batchSize: 50, wait: 8 } })
      : dev
        ? http(net.rpcUrl, { retryCount: 0, timeout: 120_000 })
        : patient(http(net.rpcUrl, { retryCount: 3, timeout: 60_000, batch: { batchSize: 50, wait: 16 } }));
  const pub = createPublicClient({ chain, transport, pollingInterval: net.caps.pollMs, cacheTime: 0 });
  const test = dev ? createTestClient({ chain, transport, mode: "anvil" }) : null;
  const external =
    !dev && signer ? createWalletClient({ chain, transport: signer.transport ?? transport, account: signer.account }) : null;

  const wallets = new Map<Actor, WalletClient<Transport, Chain, Account>>();
  const noSigner = () => new Error(`Connect a wallet to send transactions on ${net.name}.`);
  return {
    net,
    chain,
    pub,
    test,
    signer: external ? external.account.address : null,
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
