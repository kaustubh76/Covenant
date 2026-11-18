"use client";

import { ArrowRight, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ShapeChart, ShapeLegend, chartDomain } from "@/components/covenant/ShapeChart";
import { RevertCard } from "@/components/covenant/Verdict";
import { Button, Tag } from "@/components/ui";
import { recorded } from "@/fixtures";
import { amt, pct } from "@/lib/format";
import { useChain } from "@/store/chain";

/** The landing page's vault: reshape it, then try to take it. Every outcome was recorded from the deployed contracts. */
export function HeroStage({ live = false }: { live?: boolean }) {
  const { migrated, shaped, tries } = recorded.hero;
  const [isShaped, setShaped] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [tried, setTried] = useState<string[]>([]);
  const domain = useMemo(() => chartDomain([migrated, shaped]), [migrated, shaped]);
  // the store reads ?net= when the app loads, not on an in-app link: the live link switches it
  const setNetwork = useChain((s) => s.setNetwork);
  const world = isShaped ? shaped : migrated;
  const s = world.support;
  const lastTry = tries.find((t) => t.key === last);

  const attack = (key: string) => {
    setLast(key);
    setNonce((n) => n + 1);
    setTried((x) => (x.includes(key) ? x : [...x, key]));
  };
  const again = () => {
    setShaped(false);
    setLast(null);
    setTried([]);
  };

  return (
    <div className="glass rounded-2xl border border-line-strong">
      <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5 md:px-7">
        <div className="flex min-w-0 items-center gap-3">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-support opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-support" />
          </span>
          <span className="eyebrow !text-ink">A launch vault · you are the curator</span>
          <span className="hidden truncate text-[13px] text-faint md:inline">
            {amt(migrated.principal.quote)} ETH and {amt(migrated.principal.token)} tokens of launch liquidity
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isShaped && (
            <button onClick={again} aria-label="Start over" className="grid h-7 w-7 place-items-center rounded text-faint hover:text-ink">
              <RotateCcw size={14} />
            </button>
          )}
          <Tag tone={s.have >= s.need ? "pass" : "breach"}>Support {pct(s.have)}</Tag>
        </div>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="px-3 pb-4 pt-5 md:px-6">
          <ShapeChart world={world} ghost={isShaped ? migrated : undefined} domain={domain} height={330} />
          <div className="mt-2 px-2">
            <ShapeLegend ghost={isShaped ? "Before" : undefined} />
          </div>
        </div>

        <div className="flex flex-col border-t border-line p-5 md:p-7 lg:border-l lg:border-t-0">
          {!isShaped ? (
            <>
              <div className="eyebrow">Step 1 · Manage it</div>
              <p className="display mt-2 text-[26px] leading-tight text-ink">This is how a launch seeds a pool today.</p>
              <p className="mt-3 text-[14px] leading-relaxed text-muted">
                One position spread across every price. Only <span className="num text-ink">{pct(migrated.support.have)}</span> of its ETH sits close enough to the price to catch a sell.
              </p>
              <Button variant="primary" size="lg" className="mt-auto w-full" onClick={() => setShaped(true)}>
                Reshape it <ArrowRight size={16} />
              </Button>
            </>
          ) : (
            <>
              <div className="eyebrow">Step 2 · Now try to take it</div>
              <p className="display mt-2 text-[26px] leading-tight text-ink">Same assets, moved to where they work.</p>
              <p className="mt-3 text-[14px] leading-relaxed text-muted">Not one wei left the pool. You hold the curator&apos;s keys. Use them.</p>
              <div className="mt-5 grid gap-2">
                {tries.map((t) => (
                  <Button key={t.key} variant="danger" className="w-full justify-between" onClick={() => attack(t.key)}>
                    {t.label}
                    <span className="num text-[11px] opacity-70">{tried.includes(t.key) ? "reverted" : "try"}</span>
                  </Button>
                ))}
              </div>
              {lastTry && <RevertCard key={nonce} error={lastTry.error} className="mt-4" />}
              {tried.length === tries.length && (
                <Link href="/attacks" className="mt-4 text-[13.5px] text-accent underline-offset-4 hover:underline">
                  Three for three. {recorded.proof.total - tries.length} more in the attack lab →
                </Link>
              )}
            </>
          )}
        </div>
      </div>
      <div className="border-t border-line px-5 py-2.5 text-[11.5px] text-faint md:px-7">
        {live ? (
          <>
            Recorded from the same contracts on a local chain. They are live on Base Sepolia:{" "}
            <Link href="/vault?net=base-sepolia" onClick={() => void setNetwork("base-sepolia")} className="text-muted underline-offset-2 hover:text-ink hover:underline">
              open the vault →
            </Link>
          </>
        ) : (
          <>
            Recorded from the deployed contracts on a local chain. Run it live with <span className="num text-muted">make demo</span>.
          </>
        )}
      </div>
    </div>
  );
}
