"use client";

// "Have the backend send it": for a visitor on Base Sepolia with no wallet, the backend's relayer sends the action from
// its own small key, as a real transaction with a hash and a Basescan link. Shown only when the relayer is on.

import { Send } from "lucide-react";
import type { RelayAction } from "@/chain/relay";
import { Button } from "@/components/ui";
import { useRelay } from "@/lib/useRelay";
import { useChain } from "@/store/chain";

export function RelayButton({ action, title, body, className }: { action: RelayAction; title: string; body?: { indices?: number[] }; className?: string }) {
  const relay = useRelay();
  const wallet = useChain((s) => s.wallet);
  const busy = useChain((s) => s.busy);
  if (!relay.enabled || wallet) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      className={className}
      disabled={!!busy}
      onClick={() => void relay.send(action, title, body)}
      title="Sent on Base Sepolia by Covenant's backend, from its own small key: no wallet needed"
    >
      <Send size={13} strokeWidth={1.8} />
      Have the backend send it
    </Button>
  );
}
