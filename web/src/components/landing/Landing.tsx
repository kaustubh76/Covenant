"use client";

import { motion } from "framer-motion";
import { ArrowDown, ArrowRight, FlaskConical } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ATTACKS } from "@/chain/scenarios/attacks";
import { FluidField } from "@/components/landing/FluidField";
import { HeroStage } from "@/components/landing/HeroStage";
import { LiveSection, day } from "@/components/landing/Live";
import { Lifecycle, ProblemTriptych, RevertTape, RuleExplorer, Seats } from "@/components/landing/Sections";
import { Container, Reveal, SectionHead } from "@/components/landing/motion";
import { useLiveVault } from "@/components/landing/useLiveVault";
import { Button } from "@/components/ui";
import { pct } from "@/lib/format";
import type { LiveDeployment } from "@/server/live";
import { useChain } from "@/store/chain";

const LINES: { text: string; accent?: boolean }[][] = [
  [{ text: "Locked" }, { text: "for" }, { text: "holders." }],
  [{ text: "Managed", accent: true }, { text: "for" }, { text: "the" }, { text: "market." }],
];

/**
 * The landing page. `live` is the real Base Sepolia deployment (server/live.ts), or null when none is on record. Its
 * vault is read live from the chain (the hero and the first figure); every other figure is a transaction on record
 * there, linked to the explorer and dated.
 */
export function Landing({ live }: { live: LiveDeployment | null }) {
  const vault = useLiveVault(live?.vault ?? null);
  const v = vault.view;
  const sym = v?.tokenSymbol ?? live?.symbol ?? "";
  const rug = live?.steps.find((s) => s.key === "rug" && s.status === "reverted");
  const played = live ? ATTACKS.filter((a) => (live.attacks[a.id]?.length ?? 0) > 0).length : 0;
  const stats: { big: ReactNode; small: ReactNode }[] = live
    ? [
        {
          big: v ? pct(v.support.have) : "—",
          small: v
            ? `of ${sym}'s ${v.quoteSymbol} bids in the band under the price right now, read at block ${v.block.toLocaleString("en-US")}; the covenant needs ${pct(v.support.need)}`
            : vault.error
              ? `of ${sym}'s liquidity in the band: not read yet (${vault.error})`
              : `of ${sym}'s liquidity in the band: reading ${live.network}…`,
        },
        ...(rug
          ? [
              {
                big: "Refused",
                small: (
                  <>
                    the curator&apos;s soft rug on {live.symbol}, by the pool itself on {live.network}
                    {rug.time ? `, ${day(rug.time)}` : ""}:{" "}
                    <a href={`${live.explorer}/tx/${rug.hash}`} target="_blank" rel="noreferrer" className="num text-breach underline-offset-2 hover:underline">
                      {rug.error} ↗
                    </a>
                  </>
                ),
              },
            ]
          : []),
        {
          big: `${played} of ${ATTACKS.length}`,
          small: (
            <>
              attacks from the contracts&apos; test suite played for real on {live.network}.{" "}
              <Link href="/ledger" className="text-accent underline-offset-2 hover:underline">
                The ledger
              </Link>{" "}
              lists every transaction{live.asOf ? `, read back from the chain on ${day(live.asOf.time)}` : ""}.
            </>
          ),
        },
        { big: "Fees only", small: "what a curator can take out: its share of the swap fees. No function pays it the liquidity, which the suite pins (test_13_2_01)." },
      ]
    : [];
  // A Playground chain, when this copy's backend offers one right now (the top bar loads the list): the page is static,
  // so the offer appears once the list says it is ready, and never links to a chain that is not there.
  const playground = useChain((s) => s.networks.some((n) => n.key === "playground" && n.state === "ready"));
  // The store reads ?net= when the app loads; an in-app link does not reload it, so the links below switch it too.
  const setNetwork = useChain((s) => s.setNetwork);
  const toPlayground = () => void setNetwork("playground");
  let word = 0;

  return (
    <>
      {/* ---------------------------------------------------------------- hero */}
      {/* under the header: its bar and, below xl, its tab row (AppShell) */}
      <section className="relative -mt-[104px] overflow-hidden pt-[104px] xl:-mt-14 xl:pt-14">
        <FluidField className="h-[1040px]" />
        <Container className="relative">
          <div className="mx-auto flex max-w-5xl flex-col items-center pb-14 pt-20 text-center md:pt-28">
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }} className="glass flex items-center gap-2.5 rounded-full border border-line-strong px-4 py-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              <span className="text-[12.5px] tracking-wide text-muted">
                A Uniswap v4 hook for launch liquidity · UHI11
                {live && (
                  <a href="#live" className="hidden text-pass underline-offset-2 hover:underline sm:inline">
                    {" "}
                    · live on {live.network}
                  </a>
                )}
              </span>
            </motion.div>
            <h1 className="display mt-8 text-[48px] leading-[0.98] text-ink sm:text-[76px] lg:text-[104px]">
              {LINES.map((line, li) => (
                <span key={li} className="block">
                  {line.map((w) => {
                    const i = word++;
                    return (
                      <span key={w.text + i} className="inline-block overflow-hidden pb-[0.12em] align-bottom">
                        <motion.span
                          className={`inline-block ${w.accent ? "italic text-accent" : ""}`}
                          initial={{ y: "105%" }}
                          animate={{ y: 0 }}
                          transition={{ duration: 0.9, delay: 0.15 + i * 0.07, ease: [0.2, 0.7, 0.2, 1] }}
                        >
                          {w.text}
                          {" "}
                        </motion.span>
                      </span>
                    );
                  })}
                </span>
              ))}
            </h1>
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, delay: 0.75 }} className="mt-7 max-w-2xl text-[17px] leading-relaxed text-muted md:text-[19px]">
              Covenant lets a curator keep launch liquidity deep around the price, and never lets it out early: the curator cannot withdraw it at all, and the issuer&apos;s share unlocks only on its schedule. The pool
              itself enforces the rules on every move.
            </motion.p>
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.95 }} className="mt-9 flex flex-wrap justify-center gap-3">
              <Link href="/demo">
                <Button variant="primary" size="lg">
                  Watch it in ten steps <ArrowRight size={16} />
                </Button>
              </Link>
              <Link href={live ? "/vault?net=base-sepolia" : "/vault"} onClick={live ? () => void setNetwork("base-sepolia") : undefined}>
                <Button size="lg" className="glass">
                  {live ? "Open the live vault" : "Open the vault"}
                </Button>
              </Link>
            </motion.div>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.4, duration: 0.8 }} className="mt-12 flex items-center gap-2 text-[13px] text-faint">
              <ArrowDown size={14} className="bob" /> Or take the curator&apos;s keys yourself
            </motion.div>
          </div>

          <motion.div initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.9, delay: 1.05, ease: [0.2, 0.7, 0.2, 1] }} className="mx-auto max-w-[1120px]">
            <HeroStage deployment={live} live={vault} />
          </motion.div>
        </Container>
      </section>

      {/* ---------------------------------------------------------------- tape + proof */}
      {live && live.refusals.length > 0 && (
        <div className="mt-20">
          <RevertTape refusals={live.refusals} explorer={live.explorer} network={live.network} asOf={live.asOf} />
        </div>
      )}
      {stats.length > 0 && (
        <Container>
          <section className="grid grid-cols-2 gap-x-8 gap-y-10 py-16 lg:grid-cols-4">
            {stats.map((s, i) => (
              <Reveal key={i} delay={i * 0.08}>
                <div className="display text-[46px] leading-none text-ink md:text-[60px]">{s.big}</div>
                <div className="mt-3 max-w-[260px] text-[14px] leading-snug text-muted">{s.small}</div>
              </Reveal>
            ))}
          </section>
        </Container>
      )}

      {/* ---------------------------------------------------------------- live deployment */}
      {live && <LiveSection live={live} />}

      {/* ---------------------------------------------------------------- problem */}
      <Container>
        <section className="border-t border-line py-24">
          <SectionHead eyebrow="The problem" title="Today a launch picks one: liquidity nobody can pull, or liquidity that works." />
          <div className="mt-12">
            <ProblemTriptych />
          </div>
        </section>
      </Container>

      {/* ---------------------------------------------------------------- rules */}
      <Container>
        <section className="border-t border-line py-24">
          <SectionHead eyebrow="The mechanism" title="Five rules, fixed before the auction. Pick one and see it attacked." />
          <div className="mt-12">
            <RuleExplorer attacks={live?.attacks ?? null} explorer={live?.explorer ?? ""} network={live?.network ?? ""} />
          </div>
        </section>

        <section className="border-t border-line py-24">
          <SectionHead eyebrow="The lifecycle" title="Seed, reshape, enforce, release." />
          <div className="mt-14">
            <Lifecycle epoch={v?.terms.epochLength ?? null} symbol={sym} />
          </div>
        </section>

        <section className="border-t border-line py-24">
          <SectionHead eyebrow="One vault, five seats" title="Take any of them." />
          <div className="mt-12">
            <Seats />
          </div>
          {playground && (
            <Reveal className="mt-4">
              <div className="flex flex-col gap-5 rounded-xl border border-accent/40 bg-raised p-5 sm:flex-row sm:items-center sm:justify-between md:p-6">
                <div className="flex items-start gap-3.5">
                  <FlaskConical size={20} strokeWidth={1.6} className="mt-0.5 shrink-0 text-accent" />
                  <div>
                    <div className="text-[16px] font-medium text-ink">Take every seat for real, on a chain of your own.</div>
                    <p className="mt-1.5 max-w-2xl text-[13.5px] leading-relaxed text-muted">
                      A Playground is a private chain with the same contracts and a seeded launch. Every button sends a real transaction with no wallet: switch roles, trade, move the clock, reset when you
                      like. Nothing touches {live?.network ?? "the public chain"}.
                    </p>
                  </div>
                </div>
                <Link href="/vault?net=playground" onClick={toPlayground} className="shrink-0 self-start sm:self-auto">
                  <Button variant="primary">
                    Open a Playground <ArrowRight size={15} />
                  </Button>
                </Link>
              </div>
            </Reveal>
          )}
        </section>
      </Container>

      {/* ---------------------------------------------------------------- close */}
      <section className="relative overflow-hidden border-t border-line">
        <FluidField fade="both" />
        <Container className="relative py-32 text-center">
          <Reveal>
            <h2 className="display mx-auto max-w-4xl text-[44px] leading-[1.02] text-ink md:text-[76px]">
              It can move. <span className="italic text-accent">It cannot leave.</span>
            </h2>
            <div className="mt-10 flex flex-wrap justify-center gap-3">
              <Link href="/demo">
                <Button variant="primary" size="lg">
                  Run the ten-step demo <ArrowRight size={16} />
                </Button>
              </Link>
              <Link href="/attacks">
                <Button size="lg" className="glass">
                  Try to break it
                </Button>
              </Link>
              {playground && (
                <Link href="/vault?net=playground" onClick={toPlayground}>
                  <Button size="lg" className="glass">
                    <FlaskConical size={16} strokeWidth={1.6} /> Open a Playground
                  </Button>
                </Link>
              )}
            </div>
          </Reveal>
        </Container>
      </section>

      <Container>
        <footer className="border-t border-line py-8 text-[13px] leading-relaxed text-faint">
          {live ? (
            <>
              The vault at the top is read live from {live.network}, beside Uniswap v4, the Liquidity Launcher and the CCA, and every page past this one reads it with no wallet. Every other figure here is a {live.network}{" "}
              transaction on record, linked to the explorer{live.asOf ? `; the record was read back from the chain on ${day(live.asOf.time)}, at block ${live.asOf.block.toLocaleString("en-US")}` : ""}. The contracts have not been
              audited.
            </>
          ) : (
            <>
              Every page past this one runs on the deployed contracts on a local chain, with Uniswap v4, the Liquidity Launcher and the CCA beside them (start it with <span className="num">make demo</span>). The contracts have not
              been audited.
            </>
          )}
        </footer>
      </Container>
    </>
  );
}
