"use client";

// The Playground's bar, under the top bar. On a public network it offers a Playground chain, where every button can be
// pressed without a wallet; on the Playground it says what the chain is, and offers a reset and the way back.

import { ArrowLeft, ArrowRight, FlaskConical, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui";
import { useChain } from "@/store/chain";

export function PlaygroundBar() {
  const netKey = useChain((s) => s.netKey);
  const status = useChain((s) => s.status);
  const busy = useChain((s) => s.busy);
  const networks = useChain((s) => s.networks);
  const setNetwork = useChain((s) => s.setNetwork);
  const reset = useChain((s) => s.reset);
  const offered = networks.some((n) => n.key === "playground" && n.state === "ready");
  const live = networks.some((n) => n.key === "base-sepolia" && n.state === "ready");

  if (netKey === "playground") {
    return (
      <Bar
        here
        text={
          <>
            <span className="font-medium text-ink">Playground.</span> Your own chain
            <span className="hidden sm:inline"> on Covenant&apos;s backend, loaded with the demo&apos;s launch</span>
            <span className="sm:hidden">: real transactions</span>
            <span className="hidden sm:inline">. Every button sends a real transaction here: act as any role, trade, move the clock. Nothing touches Base Sepolia</span>.
          </>
        }
      >
        <Button size="xs" variant="ghost" disabled={!!busy || status !== "ready"} onClick={() => void reset()} title="Put this chain back to the seeded launch" aria-label="Reset the Playground">
          <RotateCcw size={13} strokeWidth={1.8} />
          <span className="hidden sm:inline">Reset</span>
        </Button>
        {live && (
          <Button size="xs" variant="ghost" disabled={!!busy} onClick={() => void setNetwork("base-sepolia")} title="Leave the Playground for the live deployment">
            <ArrowLeft size={13} strokeWidth={1.8} />
            <span className="hidden sm:inline">Back to</span> Base Sepolia
          </Button>
        )}
      </Bar>
    );
  }
  // Offered from a public network only: the local chain already has every control.
  if (!offered || netKey === "local" || netKey === null) return null;
  return (
    <Bar
      text={
        <>
          <span className="font-medium text-ink">Press every button.</span>{" "}
          <span className="hidden sm:inline">A Playground is a private chain with the same contracts and a seeded launch: real transactions, no wallet needed, any role, a clock you can move.</span>
          <span className="sm:hidden">No wallet needed.</span>
        </>
      }
    >
      <Button size="xs" variant="primary" disabled={!!busy} onClick={() => void setNetwork("playground")}>
        Open the Playground <ArrowRight size={13} strokeWidth={1.8} />
      </Button>
    </Bar>
  );
}

/**
 * One row at every width: the text takes what the buttons leave. On the Playground the bar carries the accent, so a
 * page never reads as the live deployment.
 */
function Bar({ text, here = false, children }: { text: React.ReactNode; here?: boolean; children: React.ReactNode }) {
  return (
    // Positioned, so the pages' header backdrops (absolutely placed behind the top bar) cannot paint over it.
    <div className={`relative z-30 border-b backdrop-blur-md ${here ? "border-accent/30 bg-raised/90" : "border-line bg-surface/90"}`}>
      {here && <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent" />}
      <div className="mx-auto flex max-w-[1320px] items-center gap-3 px-4 py-1.5 md:px-8">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <FlaskConical size={15} strokeWidth={1.6} className="shrink-0 text-accent" />
          <p className="text-[12.5px] leading-snug text-muted sm:text-[13px]">{text}</p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">{children}</div>
      </div>
    </div>
  );
}
