"use client";

import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { testTokenAbi } from "@/chain/abi.generated";
import type { Actor } from "@/chain/accounts";
import { useChain } from "@/store/chain";

/** The quote (ETH) and token balance of a demo actor, refreshed whenever the vault view refreshes. */
export function useBalances(actor: Actor) {
  const ctx = useChain((s) => s.ctx);
  const view = useChain((s) => s.view);
  const [bal, setBal] = useState<{ quote: number; token: number } | null>(null);
  useEffect(() => {
    if (!ctx || !view) return;
    let live = true;
    const who = ctx.address(actor);
    Promise.all([ctx.pub.getBalance({ address: who }), ctx.pub.readContract({ address: view.token, abi: testTokenAbi, functionName: "balanceOf", args: [who] })])
      .then(([q, t]) => live && setBal({ quote: Number(formatEther(q)), token: Number(formatEther(t)) }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ctx, view, actor]);
  return bal;
}
