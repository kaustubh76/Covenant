"use client";

// Whether the backend's relayer can send for the visitor here, and a way to ask it: on Base Sepolia only, with a backend
// configured and its relayer funded and on. A send goes through the store's run(), so it gets the same busy guard,
// honest toast and activity line as any other action.

import { useEffect, useState } from "react";
import type { BeatInput } from "@/chain/beat";
import { type RelayAction, type RelayStatus, relay, relayStatus } from "@/chain/relay";
import { useChain } from "@/store/chain";

/**
 * One status per backend, shared by every button on the page. A backend that does not answer is asleep: it is asked
 * again with backoff (10 s, 20 s, 40 s, then every minute, for about five minutes) and the buttons say it is waking
 * meanwhile, rather than vanishing until a reload.
 */
const answers = new Map<string, RelayStatus>();
const waking = new Set<string>();
const listeners = new Map<string, Set<() => void>>();
function watch(backend: string, cb: () => void): () => void {
  let set = listeners.get(backend);
  if (!set) {
    set = new Set();
    listeners.set(backend, set);
    void poll(backend, 10_000, 0);
  }
  set.add(cb);
  return () => set.delete(cb);
}
async function poll(backend: string, delay: number, tries: number) {
  const s = await relayStatus(backend);
  const tell = () => listeners.get(backend)?.forEach((f) => f());
  if (s) {
    answers.set(backend, s);
    waking.delete(backend);
    tell();
    return;
  }
  if (tries >= 8) {
    waking.delete(backend);
    answers.set(backend, { enabled: false, reason: "Covenant's backend did not answer." });
    tell();
    return;
  }
  waking.add(backend);
  tell();
  setTimeout(() => void poll(backend, Math.min(delay * 2, 60_000), tries + 1), delay);
}

export function useRelay() {
  const net = useChain((s) => s.net);
  const vault = useChain((s) => s.view?.address);
  // The relayer's own address, set whenever the hosted copy has a backend, whether or not reads go through its cache.
  const backend = net?.key === "base-sepolia" ? (net.relay ?? net.backend) : undefined;
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!backend || answers.has(backend)) return;
    return watch(backend, () => rerender((n) => n + 1));
  }, [backend]);
  const status = backend ? answers.get(backend) : undefined;
  // It acts only on the vaults on record: anywhere else its buttons would only be refused.
  const serves = !status?.vaults || !vault || status.vaults.some((v) => v.toLowerCase() === vault.toLowerCase());

  const send = (action: RelayAction, title: string, body: { to?: `0x${string}`; indices?: number[] } = {}) =>
    useChain.getState().run(title, async (_ctx, rec) => {
      if (!backend) return;
      const r = await relay(backend, action, { vault: useChain.getState().view?.address, ...body });
      let beat: BeatInput;
      if (r.ok) {
        // A trade's approval, or the drip's ETH before its tokens: each earlier transaction gets its own line and link.
        r.hashes.slice(0, -1).forEach((hash, i) => rec.record({ actor: "anyone", by: "Covenant's relayer", title: `${title}: step ${i + 1} of ${r.hashes.length}`, ok: true, hash }));
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

  return { enabled: !!backend && !!status?.enabled && serves, waking: !!backend && !status && waking.has(backend), status, send };
}
