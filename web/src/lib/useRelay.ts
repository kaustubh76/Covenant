"use client";

// Whether the backend's relayer can send for the visitor here, and a way to ask it: on Base Sepolia only, with a backend
// configured and its relayer funded and on. A send goes through the store's run(), so it gets the same busy guard,
// honest toast and activity line as any other action.

import { useEffect, useState } from "react";
import type { BeatInput } from "@/chain/beat";
import { type RelayAction, type RelayStatus, relay, relayStatus } from "@/chain/relay";
import { useChain } from "@/store/chain";

const known = new Map<string, Promise<RelayStatus>>();

export function useRelay() {
  const net = useChain((s) => s.net);
  const backend = net?.key === "base-sepolia" ? net.backend : undefined;
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!backend) {
      setEnabled(false);
      return;
    }
    let live = true;
    let status = known.get(backend);
    if (!status) {
      status = relayStatus(backend);
      known.set(backend, status);
    }
    void status.then((s) => live && setEnabled(s.enabled));
    return () => {
      live = false;
    };
  }, [backend]);

  const send = (action: RelayAction, title: string, body: { to?: `0x${string}`; indices?: number[] } = {}) =>
    useChain.getState().run(title, async (_ctx, rec) => {
      if (!backend) return;
      const r = await relay(backend, action, { vault: useChain.getState().view?.address, ...body });
      let beat: BeatInput;
      if (r.ok) {
        const pending = r.status === "pending";
        beat = {
          actor: "anyone",
          by: "Covenant's relayer",
          title,
          ok: r.status === "success",
          hash: r.hash,
          detail: r.title,
          error: r.status === "success" ? undefined : { name: pending ? "Pending" : "Error", args: [], signature: pending ? "Sent, not mined yet" : "Mined, but reverted", rule: "Other", reason: pending ? "It may still land: follow it on the explorer." : "The transaction reverted when mined." },
        };
      } else if (r.revert) {
        // The relayer's simulation found the contract's refusal: nothing was sent.
        beat = { actor: "anyone", title, ok: false, error: { name: r.revert.split("(")[0], args: [], signature: r.revert, rule: "Other", reason: `${r.reason}` } };
      } else {
        beat = { actor: "anyone", title, ok: false, error: { name: r.status === 0 ? "NoAnswer" : "NotSent", args: [], signature: "Not sent", rule: "Other", reason: r.reason } };
      }
      rec.record(beat, { toast: true });
    });

  return { enabled: !!backend && enabled, send };
}
