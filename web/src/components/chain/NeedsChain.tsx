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
  playground: {
    where: "on your own Playground chain, which Covenant's backend runs from the same seed as the local demo",
    how: "cd backend && npm run dev            # the backend, on :8080\nCOVENANT_BACKEND_URL=http://localhost:8080 npm run dev   # this app, in web/",
  },
};

export function NeedsChain({ what = "this page" }: { what?: string }) {
  const status = useChain((s) => s.status);
  const reason = useChain((s) => s.reason);
  const netKey = useChain((s) => s.netKey) ?? "local";
  const served = useChain((s) => s.networks);
  const start = START[netKey];
  // A hosted copy offers no local chain, and its public network is deployed: offline there means the RPC did not
  // answer, which retries on its own. Deploy commands would only be noise to a visitor.
  const hosted = served.length > 0 && !served.some((n) => n.key === "local");
  const rpcTrouble = netKey !== "local" && !!reason && /not answering|is chain|429|rate/i.test(reason);
  // The Playground's backend sleeps when idle and wakes in about a minute; busy and waking both retry on their own.
  if (netKey === "playground" && status !== "ready" && (status === "connecting" || /busy|in use|not answering|Waking|stopped|redeploy/i.test(reason ?? ""))) {
    return (
      <div className="mx-auto max-w-2xl py-16">
        <Panel eyebrow={status === "connecting" ? "Opening the Playground" : "Playground"} title={`${what[0].toUpperCase()}${what.slice(1)}, on a chain of your own`}>
          <p className="text-[14px] leading-relaxed text-muted">
            The Playground is a private chain on Covenant&apos;s backend, loaded from the same seed as the local demo: every button sends a real transaction there,
            and you can act as anyone, move the clock and reset it whenever you like. Nothing touches Base Sepolia.
          </p>
          <p className="mt-3 text-[13px] text-ink">{reason ?? "Opening your Playground chain…"}</p>
          {status === "offline" && <p className="mt-1 text-xs text-faint">Retrying on its own.</p>}
        </Panel>
      </div>
    );
  }
  if ((hosted || rpcTrouble) && status === "offline") {
    return (
      <div className="mx-auto max-w-2xl py-16">
        <Panel eyebrow="Reconnecting" title={`${what[0].toUpperCase()}${what.slice(1)} reads the live contracts`}>
          <p className="text-[14px] leading-relaxed text-muted">
            The network&apos;s public RPC did not answer just now. The app retries on its own, so nothing is needed from you; this page fills in as soon as it
            answers.
          </p>
          {/* the first sentence only: what follows is the server's how-to-deploy hint */}
          {reason && <p className="mt-3 text-xs text-faint">{reason.split(/(?<=\.)\s/)[0]}</p>}
        </Panel>
      </div>
    );
  }
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
