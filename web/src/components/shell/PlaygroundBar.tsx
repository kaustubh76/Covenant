"use client";

// The Playground's bar, under the top bar. On a public network it offers a Playground chain, where every button can be
// pressed without a wallet; on the Playground it says what the chain is, and offers a reset and the way back.

import { ArrowLeft, FlaskConical, RotateCcw } from "lucide-react";
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
        text={
          <>
            <span className="font-medium text-ink">Playground.</span> Your own chain on Covenant&apos;s backend
            <span className="hidden sm:inline">, loaded with the demo&apos;s launch</span>. Every button sends a real transaction here
            <span className="hidden sm:inline">: act as any role, trade, move the clock. Nothing touches Base Sepolia</span>.
          </>
        }
      >
        <Button size="sm" variant="ghost" disabled={!!busy || status !== "ready"} onClick={() => void reset()} title="Put this chain back to the seeded launch">
          <RotateCcw size={14} strokeWidth={1.8} />
          Reset
        </Button>
        {live && (
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void setNetwork("base-sepolia")}>
            <ArrowLeft size={14} strokeWidth={1.8} />
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
          <span className="sm:hidden">A private chain of your own: real transactions, no wallet.</span>
        </>
      }
    >
      <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void setNetwork("playground")}>
        Open the Playground
      </Button>
    </Bar>
  );
}

/** The text takes the whole row on a phone, with the buttons wrapping under it; side by side from `sm` up. */
function Bar({ text, children }: { text: React.ReactNode; children: React.ReactNode }) {
  return (
    // Positioned, so the pages' header backdrops (absolutely placed behind the top bar) cannot paint over it.
    <div className="relative z-30 border-b border-line bg-surface/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1320px] flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 md:px-8">
        <div className="flex min-w-0 flex-1 basis-full items-start gap-2.5 sm:basis-0">
          <FlaskConical size={15} strokeWidth={1.6} className="mt-0.5 shrink-0 text-accent" />
          <p className="text-[13px] leading-snug text-muted">{text}</p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">{children}</div>
      </div>
    </div>
  );
}
