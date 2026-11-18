"use client";

// A page's send button, aware of the wallet. On a public chain it never shows an action it cannot take: with no wallet
// it connects one (or, in a browser without one, offers the Playground, which needs none); with the wallet on another
// network it switches it. Only then does it show the page's own label and run the page's action. On a dev chain (the
// local one, the Playground) the chain's own keys sign, so it is always the action.

import { ArrowLeftRight, FlaskConical, Wallet } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui";
import { offeredDevNetwork, useChain } from "@/store/chain";

type Props = Omit<ComponentProps<typeof Button>, "children" | "onClick"> & {
  /** The label once a wallet can send it, e.g. "Deposit". */
  children: ReactNode;
  /** The verb the wallet prompts use: "Connect a wallet to deposit". */
  verb: string;
  onClick: () => void;
  /** False when there is nothing to send right now: the page's own (disabled) label shows, with no wallet prompt. */
  gate?: boolean;
};

export function SendButton({ children, verb, onClick, disabled, gate = true, ...rest }: Props) {
  const net = useChain((s) => s.net);
  const wallet = useChain((s) => s.wallet);
  const wallets = useChain((s) => s.wallets);
  const walletError = useChain((s) => s.walletError);
  const busy = useChain((s) => s.busy);
  const connectWallet = useChain((s) => s.connectWallet);
  const switchWalletChain = useChain((s) => s.switchWalletChain);
  const setNetwork = useChain((s) => s.setNetwork);
  const devNet = useChain(offeredDevNetwork);
  const publicChain = !!net && !net.caps.devChain;
  const error = walletError ? <p className="mt-1.5 text-center text-xs text-breach">{walletError}</p> : null;

  if (publicChain && gate && !wallet) {
    if (!wallets.length) {
      return devNet === "playground" ? (
        <Button {...rest} disabled={!!busy} onClick={() => void setNetwork("playground")} title="This browser has no wallet. The Playground needs none.">
          <FlaskConical size={15} strokeWidth={1.7} />
          No wallet here: {verb} on the Playground
        </Button>
      ) : (
        <Button {...rest} disabled title="Install a browser wallet, such as MetaMask, Rabby or Coinbase Wallet">
          <Wallet size={15} strokeWidth={1.7} />
          Install a wallet to {verb}
        </Button>
      );
    }
    return (
      <>
        <Button {...rest} disabled={!!busy} onClick={() => void connectWallet(wallets[0].id)} title={`Connect ${wallets.map((w) => w.name).join(" or ")}`}>
          <Wallet size={15} strokeWidth={1.7} />
          Connect a wallet to {verb}
        </Button>
        {error}
      </>
    );
  }
  if (publicChain && gate && net && wallet && wallet.chainId !== net.chainId) {
    return (
      <>
        <Button {...rest} disabled={!!busy} onClick={() => void switchWalletChain()} title={`${wallet.name} is on chain ${wallet.chainId}`}>
          <ArrowLeftRight size={15} strokeWidth={1.7} />
          Switch your wallet to {net.name}
        </Button>
        {error}
      </>
    );
  }
  return (
    <Button {...rest} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}
