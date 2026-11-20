"use client";

// Whether the backend's relayer can send for the visitor here, and a way to ask it: on Base Sepolia only, with a backend
// configured and its relayer funded and on. A send goes through the store's run(), so it gets the same busy guard,
// honest toast and activity line as any other action.

import { useEffect, useState } from "react";
import type { BeatInput } from "@/chain/beat";
import { type RelayAction, type RelayStatus, relay, relayOff, relayRefusal, relayStatus, sentNote } from "@/chain/relay";
import { useChain } from "@/store/chain";

/**
 * One status per backend, shared by every button on the page. A backend that does not answer is asleep: it is asked
 * again with backoff (10 s, 20 s, 40 s, then every minute) and the buttons say it is waking meanwhile. After about seven
 * minutes they say it did not answer, and it is still asked every minute. Once it answers, it is asked again every two
 * minutes while a button is on screen, so a relayer that spends its day's budget, or is switched off, says so.
 */
const answers = new Map<string, RelayStatus>();
const waking = new Set<string>();
const listeners = new Map<string, Set<() => void>>();
const polling = new Set<string>();
function watch(backend: string, cb: () => void): () => void {
  let set = listeners.get(backend);
  if (!set) {
    set = new Set();
    listeners.set(backend, set);
  }
  set.add(cb);
  if (!polling.has(backend)) {
    polling.add(backend);
    void poll(backend, 10_000, 0);
  }
  return () => set.delete(cb);
}
async function poll(backend: string, delay: number, tries: number) {
  const s = await relayStatus(backend);
  const tell = () => listeners.get(backend)?.forEach((f) => f());
  // Asked again only while a button is on screen; the next one to mount starts it afresh.
  const again = (ms: number, nextDelay: number, nextTries: number) => {
    if (!listeners.get(backend)?.size) return void polling.delete(backend);
    setTimeout(() => void poll(backend, nextDelay, nextTries), ms);
  };
  if (s) {
    answers.set(backend, s);
    waking.delete(backend);
    tell();
    return again(120_000, 10_000, 0);
  }
  if (tries >= 8) {
    waking.delete(backend);
    answers.set(backend, { enabled: false, reason: "Covenant's backend did not answer. It is asked again every minute." });
    tell();
    return again(60_000, 60_000, tries);
  }
  waking.add(backend);
  tell();
  again(delay, Math.min(delay * 2, 60_000), tries + 1);
}

export function useRelay() {
  const net = useChain((s) => s.net);
  const vault = useChain((s) => s.view?.address);
  // The relayer's own address, set whenever the hosted copy has a backend, whether or not reads go through its cache.
  const backend = net?.key === "base-sepolia" ? (net.relay ?? net.backend) : undefined;
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!backend) return;
    return watch(backend, () => rerender((n) => n + 1));
  }, [backend]);
  const status = backend ? answers.get(backend) : undefined;
  // It acts only on the vaults on record: anywhere else its buttons would only be refused.
  const serves = !status?.vaults || !vault || status.vaults.some((v) => v.toLowerCase() === vault.toLowerCase());

  /** Resolves true once the relayer's transaction has settled; false when it was refused, failed or is still pending. */
  const send = (action: RelayAction, title: string, body: { to?: `0x${string}`; indices?: number[] } = {}): Promise<boolean> =>
    useChain.getState().run(title, async (_ctx, rec) => {
      if (!backend) return false;
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
          // A mined revert is the chain's own refusal ("Reverted"), not an error the app could not read ("Failed").
          error: r.status === "success" ? undefined : { name: pending ? "Pending" : "MinedRevert", args: [], signature: pending ? "Sent, not mined yet" : "Mined, but reverted", rule: "Other", reason: pending ? "It may still land: follow it on the explorer." : "The transaction reverted when mined." },
        };
      } else if (r.revertData || r.revert) {
        // The relayer's simulation found the contract's refusal: decoded into the app's own sentence when the backend
        // sent the revert (relayRefusal), else named as the backend wrote it.
        const v = useChain.getState().view;
        const decoded = relayRefusal(r, { now: v?.time, tokenSymbol: v?.tokenSymbol, quoteSymbol: v?.quoteSymbol });
        const note = sentNote(r.reason);
        beat = decoded
          ? { actor: "anyone", title, ok: false, error: { ...decoded, reason: note ? `${decoded.reason} ${note}` : decoded.reason } }
          : r.revert
            ? { actor: "anyone", title, ok: false, error: { name: r.revert.split("(")[0], args: [], signature: r.revert, rule: "Other", reason: r.reason } }
            : { actor: "anyone", title, ok: false, error: { name: "NotSent", args: [], signature: "Not sent", rule: "Other", reason: r.reason } };
      } else {
        beat = { actor: "anyone", title, ok: false, error: { name: r.status === 0 ? "NoAnswer" : "NotSent", args: [], signature: "Not sent", rule: "Other", reason: r.reason } };
      }
      rec.record(beat, { toast: true });
      return beat.ok;
    }).then((ok) => ok === true);

  const off = relayOff(status);
  return { enabled: !!backend && !!status?.enabled && !off && serves, waking: !!backend && !status && waking.has(backend), off: backend && serves ? off : null, status, send };
}
