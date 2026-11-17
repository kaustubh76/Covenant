// Browser wallets, for signing on a public chain (the local chain signs with dev keys instead). Wallets are found the
// EIP-6963 way, so several installed extensions each announce themselves; a lone window.ethereum is the fallback.

import { type Address, type EIP1193Provider, getAddress } from "viem";
import type { Network } from "./network";

export interface DiscoveredWallet {
  /** EIP-6963's id for this page load, or "injected" for a lone window.ethereum. */
  id: string;
  name: string;
  /** A data: URI, from the wallet itself. */
  icon?: string;
  rdns?: string;
  provider: EIP1193Provider;
}

interface Announcement extends Event {
  detail: { info: { uuid: string; name: string; icon: string; rdns: string }; provider: EIP1193Provider };
}

/** Every wallet on the page, reported now and again whenever another announces itself. Returns an unsubscribe. */
export function discoverWallets(onChange: (wallets: DiscoveredWallet[]) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const found = new Map<string, DiscoveredWallet>();
  const emit = () => {
    const list = [...found.values()];
    const injected = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
    if (!list.length && injected) list.push({ id: "injected", name: "Browser wallet", provider: injected });
    onChange(list);
  };
  const onAnnounce = (e: Event) => {
    const { info, provider } = (e as Announcement).detail;
    if (found.has(info.uuid)) return;
    found.set(info.uuid, { id: info.uuid, name: info.name, icon: info.icon, rdns: info.rdns, provider });
    emit();
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  emit();
  return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
}

/** Ask the wallet for its account; the wallet shows its own prompt. */
export async function requestAccount(provider: EIP1193Provider): Promise<Address> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts[0]) throw new Error("The wallet did not share an account.");
  return getAddress(accounts[0]);
}

export async function walletChainId(provider: EIP1193Provider): Promise<number> {
  return Number(await provider.request({ method: "eth_chainId" }));
}

/** Switch the wallet to `net`'s chain, adding the chain first if the wallet does not know it. */
export async function switchWalletTo(provider: EIP1193Provider, net: Network): Promise<void> {
  const chainId = `0x${net.chainId.toString(16)}` as const;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    // 4902: the wallet has no such chain yet.
    if ((e as { code?: number }).code !== 4902) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: net.name,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [net.rpcUrl],
          blockExplorerUrls: net.caps.explorer ? [net.caps.explorer] : undefined,
        },
      ],
    });
  }
}

/** Follow the wallet's account and chain; returns an unsubscribe. */
export function watchWallet(provider: EIP1193Provider, on: { accounts(a: Address[]): void; chain(id: number): void }): () => void {
  const accounts = (a: string[]) => on.accounts(a.map((x) => getAddress(x)));
  const chain = (id: string) => on.chain(Number(id));
  provider.on("accountsChanged", accounts);
  provider.on("chainChanged", chain);
  return () => {
    provider.removeListener("accountsChanged", accounts);
    provider.removeListener("chainChanged", chain);
  };
}

/** A wallet error in one sentence: the user's own refusal (4001) reads as that, not as a failure. */
export function walletMessage(e: unknown): string {
  const code = (e as { code?: number }).code;
  if (code === 4001) return "You declined in the wallet.";
  if (code === -32002) return "The wallet already has a request open; check its window.";
  return e instanceof Error ? e.message.split("\n")[0] : String(e);
}
