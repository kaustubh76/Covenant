"use client";

import { Panel } from "@/components/ui";
import type { NetworkKey } from "@/chain/network";
import { useChain } from "@/store/chain";

/** Shown in place of a live page while the app connects, or when no local chain is running. */
const START: Record<NetworkKey, { where: string; how: string }> = {
  local: {
    where: "on a local chain, with Uniswap's v4, the Liquidity Launcher and the CCA deployed beside them",
    how: "make demo          # from the repository root: chain, contracts, a seeded launch and this app\nnpm run chain      # in web/, if the app is already running",
  },
  "base-sepolia": {
    where: "on Base Sepolia, beside Uniswap's deployed v4, LBPStrategy and CCA factory",
    how: "make deploy-sepolia   # Covenant itself, with the funded PRIVATE_KEY in .env\nmake launch-sepolia   # a launch through the live LBPStrategy, about a minute",
  },
  "base-sepolia-fork": {
    where: "on a local fork of Base Sepolia, beside Uniswap's deployed contracts",
    how: "make fork          # forks Base Sepolia, deploys Covenant and runs a launch in real blocks",
  },
};

export function NeedsChain({ what = "this page" }: { what?: string }) {
  const status = useChain((s) => s.status);
  const reason = useChain((s) => s.reason);
  const start = START[useChain((s) => s.netKey) ?? "local"];
  if (status === "connecting" || status === "ready") {
    return (
      <div className="py-24 text-center">
        <div className="eyebrow">Connecting</div>
        <p className="mt-2 text-[15px] text-muted">Reading the vault from the chain…</p>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-2xl py-16">
      <Panel eyebrow="Offline" title={`${what[0].toUpperCase()}${what.slice(1)} runs on the real contracts`}>
        <p className="text-[14px] leading-relaxed text-muted">
          Every number and every refusal here comes from the deployed Covenant contracts {start.where}. Start it, and this page connects on its own, or switch
          networks at the top.
        </p>
        <pre className="num mt-4 overflow-x-auto rounded-md border border-line bg-bg px-4 py-3 text-[13px] leading-relaxed text-ink">{start.how}</pre>
        {reason && <p className="mt-3 text-xs text-faint">{reason}</p>}
      </Panel>
    </div>
  );
}
