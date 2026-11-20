"use client";

import { Check, Minus } from "lucide-react";
import { useEffect, useState } from "react";
import { type Address, formatEther, isAddressEqual, parseEther } from "viem";
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
import { AddressInput, parseAddress } from "@/components/controls/AddressInput";
import { OnRecord } from "@/components/covenant/OnRecord";

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
  const ctx = useChain((s) => s.ctx);
  const seen = useChain((s) => s.seen);
  // A curator keeps what it booked in office after it is replaced (claimCuratorFees pays the caller its own balance).
  // Read for every earlier curator this vault's logs name and, on a public chain, for the connected wallet too: a change
  // older than the log window is not in them.
  const [earlier, setEarlier] = useState<{ address: Address; fees0: bigint; fees1: bigint }[]>([]);
  useEffect(() => {
    if (!ctx || !v) return;
    const names = new Map<string, Address>();
    if (seen && isAddressEqual(seen.vault, v.address)) for (const a of seen.curators) names.set(a.toLowerCase(), a);
    if (!ctx.net.caps.devChain && wallet) names.set(wallet.address.toLowerCase(), wallet.address);
    names.delete(v.people.curator.toLowerCase());
    const list = [...names.values()];
    if (!list.length) {
      setEarlier((e) => (e.length ? [] : e));
      return;
    }
    let live = true;
    const fees = (address: Address) =>
      Promise.all([
        ctx.pub.readContract({ address: v.address, abi: covenantVaultAbi, functionName: "curatorFees0", args: [address] }),
        ctx.pub.readContract({ address: v.address, abi: covenantVaultAbi, functionName: "curatorFees1", args: [address] }),
      ]).then(([fees0, fees1]) => ({ address, fees0, fees1 }));
    Promise.all(list.map(fees))
      .then((rows) => live && setEarlier(rows.filter((r) => r.fees0 > 0n || r.fees1 > 0n)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ctx, v, seen, wallet]);
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
  const { address: customTarget, bad: targetBad } = parseAddress(target);
  const proposed = customTarget ?? (publicChain ? wallet?.address : useChain.getState().ctx?.address(candidate));
  const bounty = bountyIn.trim() || (publicChain ? "0.005" : "0.05");
  const bountyOk = /^\d*\.?\d+$/.test(bounty) && Number(bounty) > 0 && Number(bounty) <= (publicChain ? 1 : 1000);
  // The issuer's powers go as the issuer on a public chain, whichever role is picked, so the wallet that is checked is the
  // wallet that sends. On a dev chain they go as the picked role, so a wrong role shows the contract's own refusal.
  const issuerParty: Party = publicChain ? v.people.issuer : party;
  const issuerOnly = publicChain && !mine(v.people.issuer) ? `Only ${shortAddress(v.people.issuer)} can` : null;
  // The curator's claim pays its sender: it goes as the address it names, or as the dev account that is that address.
  const curatorParty: Party = publicChain ? v.people.curator : (whoIs(v.people.curator) ?? v.people.curator);
  const pendingIssuerParty: Party = publicChain ? (v.people.pendingIssuer ?? v.people.issuer) : (whoIs(v.people.pendingIssuer) ?? "holder");

  const paid = (r: readonly [bigint, bigint]) => {
    const [q, t] = v.quoteIs0 ? r : [r[1], r[0]];
    return `${amt(eth(q))} ETH and ${amt(eth(t))} ${sym}`;
  };
  const claimCurator = (as: Party, address: Address, title: string) =>
    run(title, async (c, rec) => {
      const o = await send(c, as, { address: v.address, abi: covenantVaultAbi, functionName: "claimCuratorFees", args: [] }, { force: true, describe });
      const r = o.value as readonly [bigint, bigint] | undefined;
      rec.record(beatOf(o, whoIs(address) ?? "anyone", title, () => (r ? `${paid(r)} to ${who(address)}` : undefined)), { toast: true });
    });

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
            <Button size="sm" onClick={() => setRole("issuer")} disabled={!!busy}>
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
              <Meter value={t.curatorTimelock > 0 ? 1 - Math.max(0, left) / t.curatorTimelock : 1} tone={left > 0 ? "warn" : "pass"} label="Timelock progress" />
            </div>
          )}
          {!pending && (
            <AddressInput
              className="mt-5"
              label="Curator to propose"
              value={target}
              onChange={setTarget}
              placeholder={publicChain ? "Your wallet, or any 0x… address" : `The ${ACTOR_LABEL[candidate]}, or any 0x… address`}
            />
          )}
          <div className="mt-4 grid grid-cols-2 gap-3">
            {pending ? (
              <SendButton verb="cancel" disabled={!!busy || !!issuerOnly} onClick={() => call("Cancel the curator change", "cancelCuratorProposal", [], () => "The current curator stays", issuerParty)}>
                {issuerOnly ? `${issuerOnly} cancel` : "Cancel change"}
              </SendButton>
            ) : (
              <SendButton
                verb="propose"
                disabled={!!busy || !proposed || targetBad || !!issuerOnly}
                onClick={() =>
                  call(
                    "Propose a new curator",
                    "proposeCurator",
                    [proposed],
                    () => `${customTarget ? shortAddress(customTarget) : publicChain ? "Your wallet" : ACTOR_LABEL[candidate]} can take over in ${duration(t.curatorTimelock)}`,
                    issuerParty,
                  )
                }
              >
                {issuerOnly
                  ? `${issuerOnly} propose`
                  : customTarget
                    ? `Propose ${shortAddress(customTarget)}`
                    : publicChain
                      ? "Propose your wallet as curator"
                      : candidate === "newCurator"
                        ? "Propose a new curator"
                        : "Propose the original curator"}
              </SendButton>
            )}
            {/* Open to anyone once the timelock has run. On a public chain nothing is offered before then: the contract would
                only refuse it, at the sender's cost. */}
            <SendButton
              verb="accept"
              gate={!publicChain || (!!pending && left <= 0)}
              variant={pending && left <= 0 ? "primary" : "secondary"}
              disabled={!!busy || (publicChain && (!pending || left > 0))}
              onClick={() => call("Accept the curator change", "acceptCurator", [], () => "New curator in place, bound by the same rules", open, openLabel)}
            >
              {publicChain && pending && left > 0 ? `Accept in ${duration(left)}` : publicChain && !pending ? "Nothing to accept" : "Accept change"}
            </SendButton>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-faint">
            Only the issuer can propose or cancel. Anyone can accept once the timelock has run.{" "}
            {publicChain ? (mine(v.people.issuer) ? "Your wallet is the issuer." : `On ${net?.name} that is ${shortAddress(v.people.issuer)}'s wallet; the timelock runs in real time.`) : "Move time forward in the bar below."}
          </p>
          <OnRecord fn={["proposeCurator", "cancelCuratorProposal", "acceptCurator"]} className="mt-2" />
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
            <SendButton verb="collect" disabled={!!busy} onClick={collect}>
              Collect fees
            </SendButton>
            <SendButton verb="fund" disabled={!!busy || !bountyOk} onClick={fund}>
              Fund {bountyOk ? bounty : "…"}
            </SendButton>
            <SendButton verb="claim" disabled={!!busy || !mine(curatorParty)} onClick={() => claimCurator(curatorParty, v.people.curator, "Claim curator fees")}>
              {mine(curatorParty) ? "Curator claims" : `Only ${shortAddress(v.people.curator)} can claim`}
            </SendButton>
          </div>
          {!bountyOk && <p className="mt-2 text-xs text-breach">Fund the pool with an amount above 0 ETH, up to {publicChain ? 1 : 1000} ETH.</p>}
          <RelayButton action="collectFees" title="Collect fees" className="mt-3" />
          {earlier.length > 0 && (
            <div className="mt-5 border-t border-line pt-4">
              <div className="eyebrow mb-2">Earlier curators, still owed</div>
              <ul className="space-y-2.5">
                {earlier.map((r) => {
                  const [q, tk] = v.quoteIs0 ? [r.fees0, r.fees1] : [r.fees1, r.fees0];
                  const ours = mine(r.address);
                  return (
                    <li key={r.address} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 text-[13px]">
                      <span className="text-muted">{who(r.address)}</span>
                      <span className="num text-ink">
                        {amt(eth(q))} ETH · {amt(eth(tk))} {sym}
                      </span>
                      <SendButton size="sm" verb="claim" disabled={!!busy || !ours} onClick={() => claimCurator(r.address, r.address, "A former curator claims its fees")}>
                        {ours ? "Claim" : `Only ${shortAddress(r.address)} can claim`}
                      </SendButton>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-xs leading-relaxed text-faint">
                A curator keeps the fees it booked while in office. Replacing it changes who books the next ones, not who owns these.
              </p>
            </div>
          )}
          <p className="mt-3 text-xs leading-relaxed text-faint">Fees are realized whenever a range is touched. Trade in the bar below, then collect, to see them arrive.</p>
          <OnRecord fn={["collectFees", "fundBounty", "claimCuratorFees"]} className="mt-2" />
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
          <SendButton
            verb="accept"
            gate={!publicChain || !!v.people.pendingIssuer}
            disabled={!!busy || !v.people.pendingIssuer || !mine(pendingIssuerParty)}
            onClick={() => call("Accept the issuer role", "acceptIssuer", [], () => "The issuer role has moved", pendingIssuerParty, "holder")}
          >
            {!v.people.pendingIssuer
              ? "No transfer pending"
              : mine(pendingIssuerParty)
                ? "Accept as the pending issuer"
                : `Only ${shortAddress(v.people.pendingIssuer)} can accept`}
          </SendButton>
        </div>
        <OnRecord fn={["transferIssuer", "acceptIssuer"]} className="mt-3" />
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
