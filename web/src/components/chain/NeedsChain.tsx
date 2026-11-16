"use client";

import { Panel } from "@/components/ui";
import { useChain } from "@/store/chain";

/** Shown in place of a live page while the app connects, or when no local chain is running. */
export function NeedsChain({ what = "this page" }: { what?: string }) {
  const status = useChain((s) => s.status);
  const reason = useChain((s) => s.reason);
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
          Every number and every refusal here comes from the deployed Covenant contracts on a local chain, with Uniswap&apos;s v4, the Liquidity Launcher and
          the CCA deployed beside them. Start it, and this page connects on its own.
        </p>
        <pre className="num mt-4 overflow-x-auto rounded-md border border-line bg-bg px-4 py-3 text-[13px] leading-relaxed text-ink">
          {"make demo          # from the repository root: chain, contracts, a seeded launch and this app\nnpm run chain      # in web/, if the app is already running"}
        </pre>
        {reason && <p className="mt-3 text-xs text-faint">{reason}</p>}
      </Panel>
    </div>
  );
}
