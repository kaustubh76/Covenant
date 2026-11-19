"use client";

import { Check, Minus } from "lucide-react";
import { useState } from "react";
import { formatEther, isAddress, isAddressEqual, parseEther } from "viem";
import { covenantVaultAbi } from "@/chain/abi.generated";
import { ACTOR_LABEL, type Who, shortAddress } from "@/chain/accounts";
import { beatOf } from "@/chain/beat";
import { vaultEvents } from "@/chain/preflight";
import { type Party, send } from "@/chain/tx";
import { whoIs } from "@/chain/view";
import { NeedsChain } from "@/components/chain/NeedsChain";
import { Button, Meter, PageHeader, Panel, Row, Tag } from "@/components/ui";
import { amt, duration } from "@/lib/format";
import { actorFor, canSendAs, partyFor, useChain } from "@/store/chain";
import { SendButton } from "@/components/controls/SendButton";
import { RelayButton } from "@/components/controls/RelayButton";

const POWERS: [string, boolean[]][] = [
  ["Move liquidity along the price axis, within the rules", [false, true, false, false]],
  ["Withdraw launch liquidity before it vests", [false, false, false, false]],
  ["Withdraw vested principal, to the treasury only", [true, false, false, false]],
  ["Propose a new curator (timelocked)", [true, false, false, false]],
  ["Accept the new curator after the timelock", [true, true, true, true]],
  ["Collect the principal's fees to the treasury", [true, true, true, true]],
  ["Claim the curator's fee share", [false, true, false, false]],
  ["Restore support for a bounty", [true, true, true, true]],
  ["Deposit and withdraw in kind", [true, true, true, true]],
  ["Sync the Anchor (poke)", [true, true, true, true]],
  ["Change the covenant's terms", [false, false, false, false]],
];

const eth = (x: unknown) => Number(formatEther((x as bigint) ?? 0n));

export default function GovernPage() {
  const v = useChain((s) => s.view);
  const role = useChain((s) => s.role);
  const setRole = useChain((s) => s.setRole);
  const run = useChain((s) => s.run);
  const busy = useChain((s) => s.busy);
  const net = useChain((s) => s.net);
  const wallet = useChain((s) => s.wallet);
  // What the visitor typed: a curator to propose, and how much to put in the bounty pool. Empty means the default.
  const [target, setTarget] = useState("");
  const [bountyIn, setBountyIn] = useState("");
  if (!v) return <NeedsChain what="governance" />;

  const actor = actorFor(role, v);
  // On a public chain the issuer's powers are simulated as the vault's real issuer and only their wallet can send
  // them; with another role the action runs from the connected wallet and the contract's own refusal shows.
  const party = partyFor(role, v, net);
  const publicChain = !!net && !net.caps.devChain;
  // collectFees, fundBounty and acceptCurator are open to anyone: on a public chain they go from the connected wallet
  // whatever role is picked (as the issuer's address they could only ever be simulated).
  const open: Party = publicChain ? "holder" : party;
  const openLabel: Who = publicChain ? "anyone" : actor;
  const mine = (p: Party) => canSendAs(p, net, wallet);
  const current = whoIs(v.people.curator);
  const candidate = current === "newCurator" ? "curator" : "newCurator";
  const pending = v.people.pendingCurator;
  const left = v.people.curatorReadyAt - v.time;
  const t = v.terms;
  const who = (a: `0x${string}` | null) => {
    if (!a) return "None";
    const known = whoIs(a);
    if (known) return `${ACTOR_LABEL[known]} · ${shortAddress(a)}`;
    return wallet && isAddressEqual(wallet.address, a) ? `Your wallet · ${shortAddress(a)}` : shortAddress(a);
  };
  const sym = v.tokenSymbol;
  const describe = { now: v.time + 1, tokenSymbol: sym };
  const call = (
    title: string,
    functionName: "proposeCurator" | "cancelCuratorProposal" | "acceptCurator" | "transferIssuer" | "acceptIssuer" | "collectFees" | "claimCuratorFees",
    args: readonly unknown[],
    detail: () => string,
    as: Party = party,
    label: Who = actor,
  ) =>
    run(title, async (c, rec) => {
      const o = await send(c, as, { address: v.address, abi: covenantVaultAbi, functionName, args } as never, { force: true, describe });
      rec.record(beatOf(o, label, title, detail), { toast: true });
    });
  // Who a public chain's curator change would name: the connected wallet. Locally, the other demo curator.
  const typed = target.trim();
  const customTarget = typed !== "" && isAddress(typed) ? (typed as `0x${string}`) : null;
  const targetBad = typed !== "" && !customTarget;
  const proposed = customTarget ?? (publicChain ? wallet?.address : useChain.getState().ctx?.address(candidate));
  const bounty = bountyIn.trim() || (publicChain ? "0.005" : "0.05");
  const bountyOk = /^\d*\.?\d+$/.test(bounty) && Number(bounty) > 0 && Number(bounty) <= (publicChain ? 1 : 1000);
  const curatorParty: Party = publicChain ? v.people.curator : (whoIs(v.people.curator) ?? "curator");
  const pendingIssuerParty: Party = publicChain ? (v.people.pendingIssuer ?? v.people.issuer) : (whoIs(v.people.pendingIssuer) ?? "holder");

  const collect = () =>
    run("Collect fees", async (c, rec) => {
      const o = await send(c, open, { address: v.address, abi: covenantVaultAbi, functionName: "collectFees", args: [] }, { force: true });
      const ev = vaultEvents(o.receipt?.logs as never, v.address).find((e) => e.name === "FeesCollected");
      rec.record(
        beatOf(o, openLabel, "Collect fees", () =>
          ev ? `${amt(eth(ev.args.toBountyPool))} ETH to the bounty pool, ${amt(eth(ev.args.toTreasury0))} ETH and ${amt(eth(ev.args.toTreasury1))} ${sym} to the treasury` : undefined,
        ),
        { toast: true },
      );
    });
  const fund = () =>
    run("Fund the bounty pool", async (c, rec) => {
      const amount = parseEther(bounty);
      const o = await send(c, open, { address: v.address, abi: covenantVaultAbi, functionName: "fundBounty", args: [amount], value: amount });
      rec.record(beatOf(o, openLabel, "Fund the bounty pool", () => `${bounty} ETH added`), { toast: true });
    });

  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="Few powers, each one slow or harmless."
        lead="The issuer can replace the curator, slowly, and withdraw vested principal to its treasury. The curator can move liquidity within the rules and earns a share of fees. Neither can take the liquidity, and nobody can change the terms."
        aside={
          role === "issuer" ? (
            <Tag tone="accent">Acting as issuer</Tag>
          ) : (
            <Button size="sm" onClick={() => setRole("issuer")}>
              Act as issuer
            </Button>
          )
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel eyebrow="Curator" title={pending ? "A change is pending" : "Named curator"}>
          <Row label="Current">{who(v.people.curator)}</Row>
          <Row label="Pending">{who(pending)}</Row>
          <Row label="Timelock">{duration(t.curatorTimelock)}</Row>
          {pending && (
            <div className="mt-4">
              <div className="mb-2 flex items-baseline justify-between text-[13px]">
                <span className="text-muted">{left > 0 ? "Holders can still react" : "Timelock elapsed"}</span>
                <span className="num text-ink">{left > 0 ? `${duration(left)} left` : "Ready"}</span>
              </div>
              <Meter value={1 - Math.max(0, left) / t.curatorTimelock} tone={left > 0 ? "warn" : "pass"} label="Timelock progress" />
            </div>
          )}
          {!pending && (
            <label className="mt-5 block text-[13px] text-muted">
              Curator to propose
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder={publicChain ? "Your wallet, or any 0x… address" : `The ${ACTOR_LABEL[candidate]}, or any 0x… address`}
                spellCheck={false}
                className={`num mt-1.5 h-9 w-full rounded-md border bg-transparent px-2.5 text-[13px] text-ink outline-none placeholder:text-faint ${targetBad ? "border-breach/60" : "border-line-strong focus:border-muted"}`}
              />
              {targetBad && <span className="mt-1 block text-xs text-breach">That is not an address.</span>}
            </label>
          )}
          <div className="mt-4 grid grid-cols-2 gap-3">
            {pending ? (
              <Button disabled={!!busy} onClick={() => call("Cancel the curator change", "cancelCuratorProposal", [], () => "The current curator stays")}>
                Cancel change
              </Button>
            ) : (
              <SendButton
                verb="propose"
                disabled={!!busy || !proposed || targetBad}
                onClick={() =>
                  call("Propose a new curator", "proposeCurator", [proposed], () => `${customTarget ? shortAddress(customTarget) : publicChain ? "Your wallet" : ACTOR_LABEL[candidate]} can take over in ${duration(t.curatorTimelock)}`)
                }
              >
                {customTarget ? `Propose ${shortAddress(customTarget)}` : publicChain ? "Propose your wallet as curator" : candidate === "newCurator" ? "Propose a new curator" : "Propose the original curator"}
              </SendButton>
            )}
            <Button variant={pending && left <= 0 ? "primary" : "secondary"} disabled={!!busy} onClick={() => call("Accept the curator change", "acceptCurator", [], () => "New curator in place, bound by the same rules", open, openLabel)}>
              Accept change
            </Button>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-faint">
            Only the issuer can propose or cancel. Anyone can accept once the timelock has run.{" "}
            {publicChain ? (mine(v.people.issuer) ? "Your wallet is the issuer." : `On ${net?.name} that is ${shortAddress(v.people.issuer)}'s wallet; the timelock runs in real time.`) : "Move time forward in the bar below."}
          </p>
        </Panel>

        <Panel eyebrow="Income" title="Fees are income, never principal">
          <Row label={`Fee pot`}>
            {amt(v.fees.pot.quote)} ETH · {amt(v.fees.pot.token)} {sym}
          </Row>
          <Row label="Owed to the issuer's principal">
            {amt(v.fees.principalOwed.quote)} ETH · {amt(v.fees.principalOwed.token)} {sym}
          </Row>
          <Row label="Curator's share, accrued">
            {amt(v.fees.curator.quote)} ETH · {amt(v.fees.curator.token)} {sym}
          </Row>
          <Row label="Restore bounty pool">{amt(v.fees.bountyPool)} ETH</Row>
          <Row label="Pool topped up to">{amt(Number(formatEther(t.bounty)) * 3)} ETH before the treasury is paid</Row>
          <Row label="Fund the pool with">
            <span className="inline-flex items-center gap-1.5">
              <input
                aria-label="ETH to fund the bounty pool with"
                value={bountyIn}
                onChange={(e) => setBountyIn(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder={publicChain ? "0.005" : "0.05"}
                inputMode="decimal"
                className={`num h-8 w-24 rounded-md border bg-transparent px-2 text-right text-[13px] text-ink outline-none placeholder:text-faint ${bountyOk ? "border-line-strong focus:border-muted" : "border-breach/60"}`}
              />
              ETH
            </span>
          </Row>
          <div className="mt-5 grid grid-cols-3 gap-3">
            <Button disabled={!!busy} onClick={collect}>
              Collect fees
            </Button>
            <Button disabled={!!busy || !bountyOk} onClick={fund}>
              Fund {bountyOk ? bounty : "…"}
            </Button>
            <Button disabled={!!busy} onClick={() => call("Claim curator fees", "claimCuratorFees", [], () => "Paid to the curator in office when they were earned", curatorParty, "curator")}>
              Curator claims
            </Button>
          </div>
          <RelayButton action="collectFees" title="Collect fees" className="mt-3" />
          <p className="mt-3 text-xs leading-relaxed text-faint">Fees are realized whenever a range is touched. Trade in the bar below, then collect, to see them arrive.</p>
        </Panel>
      </div>

      <Panel className="mt-6" eyebrow="Issuer" title="The issuer role moves in two steps">
        <Row label="Issuer">{who(v.people.issuer)}</Row>
        <Row label="Pending">{who(v.people.pendingIssuer)}</Row>
        <div className="mt-4 flex flex-wrap gap-3">
          {!publicChain && (
            <Button disabled={!!busy} onClick={() => call("Start an issuer transfer", "transferIssuer", [useChain.getState().ctx!.address("holder")], () => "The holder account can now accept the issuer role")}>
              Transfer to the holder account
            </Button>
          )}
          <Button
            disabled={!!busy || !v.people.pendingIssuer || (publicChain && !mine(pendingIssuerParty))}
            onClick={() => call("Accept the issuer role", "acceptIssuer", [], () => "The issuer role has moved", pendingIssuerParty, "holder")}
          >
            Accept as the pending issuer
          </Button>
        </div>
      </Panel>

      <Panel className="mt-6" eyebrow="Powers" title="Who can do what" flush>
        <div className="scroll-x px-5 pb-4 pt-2">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="eyebrow border-b border-line text-left">
                <th className="py-2.5 font-normal">Action</th>
                {["Issuer", "Curator", "Keeper", "Anyone"].map((h) => (
                  <th key={h} className="w-24 py-2.5 text-center font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {POWERS.map(([name, row]) => (
                <tr key={name} className="border-b border-line last:border-b-0">
                  <td className={`py-2.5 ${row.some(Boolean) ? "text-ink" : "text-muted"}`}>{name}</td>
                  {row.map((can, i) => (
                    <td key={i} className="py-2.5">
                      <span className={`mx-auto grid h-5 w-5 place-items-center ${can ? "text-pass" : "text-faint"}`}>{can ? <Check size={15} strokeWidth={2.2} /> : <Minus size={14} />}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
