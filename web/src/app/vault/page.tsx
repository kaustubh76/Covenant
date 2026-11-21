"use client";

import Link from "next/link";
import type { Address } from "viem";
import { ACTOR_LABEL, shortAddress } from "@/chain/accounts";
import { explorerAddress } from "@/chain/network";
import { priceAt } from "@/chain/price";
import { whoIs } from "@/chain/view";
import { NeedsChain } from "@/components/chain/NeedsChain";
import { ActivityFeed } from "@/components/covenant/ActivityFeed";
import { RuleRail } from "@/components/covenant/RuleRail";
import { ShapeChart, ShapeLegend } from "@/components/covenant/ShapeChart";
import { TermsCard } from "@/components/covenant/TermsCard";
import { VaultPicker } from "@/components/covenant/VaultPicker";
import { Num, PageHeader, Panel, Row, Stat, Tag } from "@/components/ui";
import { amt, pct, price } from "@/lib/format";
import { KIND_SWATCH, describeRange } from "@/lib/ranges";
import { MAX_RANGES } from "@/chain/constants";
import { fact } from "@/lib/fact";
import { useChain } from "@/store/chain";

/** An address as the page names it: a dev account's role on a dev chain, otherwise just the address. */
const person = (a: Address | null, devChain: boolean) => {
  if (!a) return "None";
  const w = whoIs(a, devChain);
  return w ? `${ACTOR_LABEL[w]} · ${shortAddress(a)}` : shortAddress(a);
};

/** An address, linked to the network's explorer when it has one. */
function AddressLink({ address }: { address: Address }) {
  const net = useChain((s) => s.net);
  const href = net ? explorerAddress(net, address) : undefined;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="text-muted underline-offset-2 hover:text-ink hover:underline">
      {shortAddress(address)} ↗
    </a>
  ) : (
    <span className="text-muted">{shortAddress(address)}</span>
  );
}

export default function VaultPage() {
  const v = useChain((s) => s.view);
  const devChain = useChain((s) => s.net?.caps.devChain ?? false);
  if (!v) return <NeedsChain what="the vault" />;

  const healthy = v.support.have >= v.support.need && v.guard.ok;
  const sym = v.tokenSymbol;
  const q = v.quoteSymbol;

  return (
    <>
      <PageHeader
        eyebrow={`Vault · ${sym}/${q} · ${(v.feePips / 1e4).toFixed(2)}% pool`}
        title="Every unit of launch liquidity, and the rules it lives under."
        aside={
          <div className="flex flex-col items-end gap-2">
            <Tag tone={healthy ? "pass" : "breach"}>{healthy ? "Covenant holding" : "Needs attention"}</Tag>
            <VaultPicker />
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-x-8 gap-y-6 border-y border-line py-6 md:grid-cols-4">
        <Stat label="Price" value={<Num value={priceAt(v.spot)} format={(x) => price(x)} />} unit={q} />
        <Stat label="Vault value" value={<span {...fact("vault.totalValue", v.value, v.block)}><Num value={v.value} format={(x) => amt(x)} /></span>} unit={q} sub="Valued at the time-weighted price" />
        {/* A rule of the contract, not a reading: reshape is the only curator-only function, and the curator is paid only its own fee balance (lib/curator.test.ts). */}
        <Stat label="The curator can take out" value="Fees only" sub="Its share of swap fees: no function pays it the liquidity" tone="pass" />
        <Stat
          label="Support in band"
          value={<span {...fact("vault.supportBps", v.support.have, v.block)}><Num value={v.support.have} format={(x) => pct(x)} /></span>}
          sub={`Minimum ${pct(v.support.need, 0)}`}
          tone={v.support.have >= v.support.need ? undefined : "breach"}
        />
      </div>

      <div className="mt-6 space-y-6">
        <Panel eyebrow="Liquidity shape" title="Where the vault is bidding and asking">
          <ShapeChart world={v} height={340} />
          <div className="mt-3">
            <ShapeLegend />
          </div>
        </Panel>

        <RuleRail world={v} />

        <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
          <div className="space-y-6">
            <Panel eyebrow="Positions" title={<span {...fact("vault.rangeCount", v.ranges.length, v.block)}>{`${v.ranges.length} of ${MAX_RANGES} ranges`}</span>} flush>
              <div className="scroll-x px-5 pb-3 pt-2">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="eyebrow border-b border-line text-left">
                      <th className="py-2.5 font-normal">Role</th>
                      <th className="py-2.5 font-normal">Price range ({q})</th>
                      <th className="py-2.5 text-right font-normal">{q}</th>
                      <th className="py-2.5 text-right font-normal">{sym}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.ranges.map((r, i) => {
                      const d = describeRange(v, i);
                      return (
                        <tr key={`${r.tickLower}:${r.tickUpper}`} className="border-b border-line last:border-b-0">
                          <td className="py-2.5">
                            <span className="flex items-center gap-2 text-ink">
                              <span className={`h-2 w-2 rounded-[2px] ${KIND_SWATCH[d.kind]}`} />
                              {d.kind}
                            </span>
                          </td>
                          <td className="num py-2.5 text-muted">{d.label}</td>
                          <td className="num py-2.5 text-right text-ink">{amt(d.quote)}</td>
                          <td className="num py-2.5 text-right text-ink">{amt(d.token)}</td>
                        </tr>
                      );
                    })}
                    <tr>
                      {/* the lens's principal: the ranges and the idle balance the vault holds beside them */}
                      <td className="eyebrow pt-3" colSpan={2}>
                        In the vault
                      </td>
                      <td className="num pt-3 text-right text-ink">{amt(v.principal.quote)}</td>
                      <td className="num pt-3 text-right text-ink">{amt(v.principal.token)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel eyebrow="Activity" title="What has been tried, and what the contract said">
              <ActivityFeed />
            </Panel>
          </div>

          <div className="space-y-6">
            <Panel eyebrow="Ownership and income">
              <Row label="Issuer principal">{pct((v.shares.principal / Math.max(v.shares.total, 1e-18)) * 1e4)} of shares</Row>
              <Row label="Outside LPs">{pct((v.shares.outside / Math.max(v.shares.total, 1e-18)) * 1e4)} of shares</Row>
              <Row label="Curator">
                <span className="text-muted" {...fact("vault.curator", v.people.curator, v.block)}>
                  {person(v.people.curator, devChain)}
                </span>
              </Row>
              <Row label="Fee pot">
                {amt(v.fees.pot.quote)} {q} · {amt(v.fees.pot.token)} {sym}
              </Row>
              <Row label="Curator's fee share">
                {amt(v.fees.curator.quote)} {q} · {amt(v.fees.curator.token)} {sym}
              </Row>
              <Row label="Restore bounty pool">
                {amt(v.fees.bountyPool)} {q}
              </Row>
              <div className="mt-4 flex flex-wrap gap-2 text-[13px]">
                <Link className="text-accent underline-offset-4 hover:underline" href="/curate">
                  Reshape
                </Link>
                <span className="text-faint">·</span>
                <Link className="text-accent underline-offset-4 hover:underline" href="/keep">
                  Restore
                </Link>
                <span className="text-faint">·</span>
                <Link className="text-accent underline-offset-4 hover:underline" href="/provide">
                  Add liquidity
                </Link>
                <span className="text-faint">·</span>
                <Link className="text-accent underline-offset-4 hover:underline" href="/attacks">
                  Try to break it
                </Link>
              </div>
            </Panel>
            <TermsCard terms={v.terms} symbol={sym} quote={q} />
            <Panel eyebrow="On-chain" title="Contracts">
              <Row label="Vault">
                <AddressLink address={v.address} />
              </Row>
              <Row label="Token">
                <AddressLink address={v.token} />
              </Row>
              <Row label="Pool id">
                <span className="text-muted">{shortAddress(v.poolId)}</span>
              </Row>
              <Row label="Read at block">
                <span className="text-muted">{v.block.toLocaleString("en-US")}</span>
              </Row>
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}
