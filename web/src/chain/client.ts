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

export function createChainCtx(net: Network, signer?: ExternalSigner): ChainCtx {
  const chain = chainOf(net);
  const dev = net.caps.devChain;
  // Public RPCs rate-limit: batch concurrent reads into one request and retry transient failures. Anvil needs neither,
  // and a failed local call should fail at once.
  const transport = dev
    ? http(net.rpcUrl, { retryCount: 0, timeout: 120_000 })
    : http(net.rpcUrl, { retryCount: 3, timeout: 60_000, batch: { batchSize: 50, wait: 16 } });
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
