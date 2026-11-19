"use client";

// "Have the backend send it": for a visitor on Base Sepolia with no wallet, the backend's relayer sends the action from
// its own small key, as a real transaction with a hash and a Basescan link. Shown only when the relayer is on.
//
// It is the one live action such a visitor has, so it never reads as an afterthought: bordered by default, and the
// primary button where the page's own send button can only ask for a wallet (`prominent`).

import { Send } from "lucide-react";
import type { RelayAction } from "@/chain/relay";
import { Button } from "@/components/ui";
import { useRelay } from "@/lib/useRelay";
import { useChain } from "@/store/chain";

export function RelayButton({
  action,
  title,
  body,
  className,
  prominent = false,
}: {
  action: RelayAction;
  title: string;
  body?: { indices?: number[] };
  className?: string;
  /** The page's send button beside it is in its no-wallet state: this is the action to take. */
  prominent?: boolean;
}) {
  const relay = useRelay();
  const wallet = useChain((s) => s.wallet);
  const busy = useChain((s) => s.busy);
  if (!relay.enabled || wallet) return null;
  return (
    <Button
      size="sm"
      variant={prominent ? "primary" : "secondary"}
      className={className}
      disabled={!!busy}
      onClick={() => void relay.send(action, title, body)}
      title="Sent on Base Sepolia by Covenant's backend, from its own small key: no wallet needed"
    >
      <Send size={13} strokeWidth={1.8} className={prominent ? undefined : "text-accent"} />
      Have the backend send it
    </Button>
  );
}
