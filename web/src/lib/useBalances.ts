"use client";

import { useEffect, useMemo, useState } from "react";
import { type Address, formatEther } from "viem";
import { testTokenAbi } from "@/chain/abi.generated";
import type { Actor } from "@/chain/accounts";
import { useChain } from "@/store/chain";

/**
 * The quote (ETH) and token balance of a demo actor, or of `address` when one is given (a public chain's issuer or
 * curator, which is a fixed address rather than the connected wallet), refreshed whenever the vault view refreshes. A
 * balance read for another account or token (before a role or vault switch) is never returned as this one's.
 */
export function useBalances(actor: Actor, address?: Address) {
  const ctx = useChain((s) => s.ctx);
  const view = useChain((s) => s.view);
  const [bal, setBal] = useState<{ key: string; quote: number; token: number } | null>(null);
  // On a public chain every role is the connected wallet; with none connected there is no balance to show, unless an
  // address is asked for (reading one needs no wallet).
  const who = !ctx ? null : (address ?? (ctx.net.caps.devChain || ctx.signer ? ctx.address(actor) : null));
  const key = who && view ? `${who.toLowerCase()}:${view.token.toLowerCase()}` : null;
  useEffect(() => {
    if (!ctx || !view || !who || !key) return;
    let live = true;
    Promise.all([ctx.pub.getBalance({ address: who }), ctx.pub.readContract({ address: view.token, abi: testTokenAbi, functionName: "balanceOf", args: [who] })])
      .then(([q, t]) => live && setBal({ key, quote: Number(formatEther(q)), token: Number(formatEther(t)) }))
      // A failed read keeps the last one for this account, and the next view refresh asks again.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ctx, view, who, key]);
  return useMemo(() => (bal && bal.key === key ? { quote: bal.quote, token: bal.token } : null), [bal, key]);
}
