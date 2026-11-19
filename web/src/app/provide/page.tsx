"use client";

import { useEffect, useRef, useState } from "react";
import { type Address, formatEther, isAddressEqual, maxUint256, parseEther, zeroAddress } from "viem";
import { covenantVaultAbi, testTokenAbi } from "@/chain/abi.generated";
import { ACTOR_LABEL, type Who, actorOf, shortAddress } from "@/chain/accounts";
import { beatOf } from "@/chain/beat";
import { NEVER } from "@/chain/launch";
import { swap } from "@/chain/market";
import { type ActionCall, type Preflight, preflight, vaultEvents, failedPreflight } from "@/chain/preflight";
import { priceAt } from "@/chain/price";
import { depositCall, ensureAllowance, quoteBudget, withSlack } from "@/chain/provide";
import { type Party, isAddressParty, send } from "@/chain/tx";
import type { VaultView } from "@/chain/view";
import { NeedsChain } from "@/components/chain/NeedsChain";
import { ShapeChart } from "@/components/covenant/ShapeChart";
import { VaultPicker } from "@/components/covenant/VaultPicker";
import { Button, PageHeader, Panel, Row, Slider, Tag } from "@/components/ui";
import { amt, duration, pct } from "@/lib/format";
import { useBalances } from "@/lib/useBalances";
import { ROLES, actorFor, canSendAs, partyFor, useChain } from "@/store/chain";
import { SendButton } from "@/components/controls/SendButton";
import { AddressInput, parseAddress } from "@/components/controls/AddressInput";

const eth = (x: bigint) => Number(formatEther(x));
/** On a public chain the deposit is simulated within the wallet's ETH, less what the market keeps back for gas. */
const spendable = (quote: number) => parseEther(Math.max(0, quote - 0.002).toFixed(18));
/**
 * The token approval a deposit needs, run ahead of it inside the same simulated block: a wallet that has never
 * approved the vault still sees the exact cost, and the approval itself is sent only when it deposits.
 */
const approveFirst = (v: Pick<VaultView, "address" | "token">): ActionCall[] => [{ address: v.token, abi: testTokenAbi, functionName: "approve", args: [v.address, maxUint256] }];

export default function ProvidePage() {
  const v = useChain((s) => s.view);
  const ctx = useChain((s) => s.ctx);
  const role = useChain((s) => s.role);
  const setRole = useChain((s) => s.setRole);
  const run = useChain((s) => s.run);
  const busy = useChain((s) => s.busy);
  const [addPct, setAddPct] = useState(10);
  const [outPct, setOutPct] = useState(100);
  const [principalPct, setPrincipalPct] = useState(100);
  const [dep, setDep] = useState<Preflight | null>(null);
  const [out, setOut] = useState<Preflight | null>(null);
  const net = useChain((s) => s.net);
  const wallet = useChain((s) => s.wallet);
  const launches = useChain((s) => s.launches);
  const actor = actorFor(role, v);
  // The acting role deposits: on a public chain that is the connected wallet, or the vault's issuer or curator by
  // address (see partyFor), and the principal leaves for the issuer only. The position panel reads and exits as the
  // role too, unless an address is being watched (below).
  const party = partyFor(role, v, net);
  const publicChain = !!net && !net.caps.devChain;
  const mayAct = canSendAs(party, net, wallet);
  const bal = useBalances(actor);
  const cap = publicChain && bal ? spendable(bal.quote) : undefined;

  const newShares = v ? (v.raw.totalShares * BigInt(addPct)) / 100n : 0n;
  const mine = v?.raw.sharesOf[actor] ?? 0n;

  // Watching: any address's position, read for itself, with its exit simulated as that address. Deposits stay with the
  // acting role. `?watch=0x…` opens it, and is kept in step so the link can be shared.
  const [watchText, setWatchText] = useState("");
  const typedWatch = parseAddress(watchText).address;
  // Address zero is the principal's own account (VaultStorage's PRINCIPAL_ACCOUNT): its shares leave only through the
  // issuer's withdrawPrincipal, so it is explained rather than shown as a position anyone could exit.
  const watchesPrincipal = !!typedWatch && isAddressEqual(typedWatch, zeroAddress);
  const watched = watchesPrincipal ? null : typedWatch;
  const [watchedPos, setWatchedPos] = useState<{ vault: Address; address: Address; shares: bigint; owed: readonly [bigint, bigint] } | null>(null);
  const seen = useChain((s) => s.seen);
  const urlRead = useRef(false);
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (!urlRead.current) {
        urlRead.current = true;
        const asked = url.searchParams.get("watch");
        if (asked && !watched) {
          setWatchText(asked);
          return;
        }
      }
      if (watched) url.searchParams.set("watch", watched);
      else url.searchParams.delete("watch");
      if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
    } catch {
      /* not in a browser */
    }
  }, [watched]);
  useEffect(() => {
    if (!ctx || !v || !watched) return;
    let live = true;
    const at = { address: v.address, abi: covenantVaultAbi } as const;
    Promise.all([ctx.pub.readContract({ ...at, functionName: "sharesOf", args: [watched] }), ctx.pub.readContract({ ...at, functionName: "feesOwed", args: [watched] })])
      .then(([shares, owed]) => live && setWatchedPos({ vault: v.address, address: watched, shares, owed }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ctx, v, watched]);
  const watchedHere = watched && v && watchedPos && isAddressEqual(watchedPos.address, watched) && isAddressEqual(watchedPos.vault, v.address) ? watchedPos : null;
  // whose position the panel shows and exits: the watched address, or the acting role
  const posParty: Party = watched ?? party;
  const posShares = watched ? (watchedHere?.shares ?? 0n) : mine;
  const burn = (posShares * BigInt(outPct)) / 100n;

  useEffect(() => {
    if (!ctx || !v || newShares === 0n) return;
    let live = true;
    preflight(ctx, party, depositCall(v, newShares, quoteBudget(v, addPct / 100, cap)), v, approveFirst(v))
      .catch(failedPreflight)
      .then((p) => live && setDep(p));
    return () => {
      live = false;
    };
  }, [ctx, v, party, addPct, newShares, cap]);
  useEffect(() => {
    if (!ctx || !v || burn === 0n) {
      setOut(null);
      return;
    }
    let live = true;
    preflight(ctx, posParty, { address: v.address, abi: covenantVaultAbi, functionName: "withdraw", args: [burn, 0n, 0n, NEVER] }, v)
      .catch(failedPreflight)
      .then((p) => live && setOut(p));
    return () => {
      live = false;
    };
  }, [ctx, v, posParty, burn]);

  if (!v) return <NeedsChain what="liquidity provision" />;
  const sym = v.tokenSymbol;
  const name = ROLES.find((r) => r.key === role)?.name ?? role;
  const cost = dep?.ok ? (dep.value as readonly [bigint, bigint]) : null;
  const back = out?.ok ? (out.value as readonly [bigint, bigint]) : null;
  const devChain = !publicChain;
  /** An address as the panel names it: a dev account by role, the connected wallet as yours, anything else short. */
  const named = (a: Address) => {
    const known = devChain ? actorOf(a) : undefined;
    if (known) return `${ACTOR_LABEL[known]} · ${shortAddress(a)}`;
    return wallet && isAddressEqual(wallet.address, a) ? `Your wallet · ${shortAddress(a)}` : shortAddress(a);
  };
  const owedPair = (o: readonly [bigint, bigint]) => (v.quoteIs0 ? { quote: eth(o[0]), token: eth(o[1]) } : { quote: eth(o[1]), token: eth(o[0]) });
  const owed = watched ? (watchedHere ? owedPair(watchedHere.owed) : { quote: 0, token: 0 }) : (v.fees.owed[actor] ?? { quote: 0, token: 0 });
  const posWho: Who = watched ? ((devChain ? actorOf(watched) : undefined) ?? "anyone") : actor;
  const mayExit = canSendAs(posParty, net, wallet);
  const share = (x: bigint) => pct((Number(x) / Number(v.raw.totalShares)) * 1e4);
  const picks = [...(wallet ? [wallet.address] : []), ...(seen && isAddressEqual(seen.vault, v.address) ? seen.depositors : [])]
    .filter((a, i, all) => all.findIndex((b) => isAddressEqual(a, b)) === i)
    .slice(0, 5);
  const isIssuer = role === "issuer";
  const principalBurn = (v.raw.principalWithdrawable * BigInt(principalPct)) / 100n;

  const deposit = () =>
    run(`Deposit for ${addPct}% new shares`, async (c, rec) => {
      const p = await preflight(c, party, depositCall(v, newShares, quoteBudget(v, addPct / 100, cap)), v, approveFirst(v));
      if (!p.ok) {
        rec.record({ actor, title: `Deposit for ${addPct}% new shares`, ok: false, error: p.error }, { toast: true });
        return;
      }
      const [a0, a1] = p.value as readonly [bigint, bigint];
      // A real wallet approves exactly what this deposit may take; dev chains keep the open allowance their demos rely on.
      await ensureAllowance(c, party, v, withSlack(a1), !c.net.caps.devChain);
      const o = await send(c, party, { ...depositCall(v, newShares, withSlack(a0)), args: [newShares, withSlack(a0), withSlack(a1), NEVER] as const }, { force: true });
      const ev = vaultEvents(o.receipt?.logs as never, v.address).find((e) => e.name === "Deposited");
      rec.record(
        beatOf(o, actor, `Deposit for ${addPct}% new shares`, () =>
          ev ? `Paid ${amt(eth(ev.args.amount0 as bigint))} ETH and ${amt(eth(ev.args.amount1 as bigint))} ${sym}, exactly ${addPct}% of each range` : undefined,
        ),
        { toast: true },
      );
    });

  const withdraw = () =>
    run(`Withdraw ${outPct}% of position`, async (c, rec) => {
      const p = await preflight(c, posParty, { address: v.address, abi: covenantVaultAbi, functionName: "withdraw", args: [burn, 0n, 0n, NEVER] }, v);
      const [m0, m1] = p.ok ? (p.value as readonly [bigint, bigint]) : [0n, 0n];
      const o = await send(c, posParty, { address: v.address, abi: covenantVaultAbi, functionName: "withdraw", args: [burn, (m0 * 995n) / 1000n, (m1 * 995n) / 1000n, NEVER] }, { force: true });
      const ev = vaultEvents(o.receipt?.logs as never, v.address).find((e) => e.name === "Withdrawn");
      rec.record(beatOf(o, posWho, `Withdraw ${outPct}% of position`, () => (ev ? `Received ${amt(eth(ev.args.amount0 as bigint))} ETH and ${amt(eth(ev.args.amount1 as bigint))} ${sym}` : undefined)), {
        toast: true,
      });
    });

  const claim = () =>
    run("Claim fees", async (c, rec) => {
      const o = await send(c, posParty, { address: v.address, abi: covenantVaultAbi, functionName: "claimFees", args: [] });
      const r = o.value as readonly [bigint, bigint] | undefined;
      rec.record(beatOf(o, posWho, "Claim fees", () => (r ? `${amt(eth(r[0]))} ETH and ${amt(eth(r[1]))} ${sym}` : undefined)), { toast: true });
    });

  const withdrawPrincipal = () =>
    run(`Withdraw ${principalPct}% of vested principal`, async (c, rec) => {
      const shares = principalBurn > 0n ? principalBurn : 10n ** 16n; // nothing vested: ask for 1% to show the lock
      const o = await send(c, party, { address: v.address, abi: covenantVaultAbi, functionName: "withdrawPrincipal", args: [shares, 0n, 0n, NEVER] }, { force: true, describe: { now: v.time } });
      const ev = vaultEvents(o.receipt?.logs as never, v.address).find((e) => e.name === "PrincipalWithdrawn");
      rec.record(
        beatOf(o, actor, "Withdraw principal to the treasury", () => (ev ? `${amt(eth(ev.args.amount0 as bigint))} ETH and ${amt(eth(ev.args.amount1 as bigint))} ${sym} to the treasury` : undefined)),
        { toast: true },
      );
    });

  // A wallet on a public chain starts with ETH only: the token side of a deposit is bought from the pool first. With
  // none of the token the deposit cannot even be simulated (the transfer fails first), so the need is read from the
  // vault's own holdings, which a proportional deposit matches exactly; once the wallet holds some, the simulation's.
  const tokenNeed = cost ? eth(cost[1]) : v.principal.token * (addPct / 100) * 1.01;
  const tokenShort = publicChain && bal ? Math.max(0, tokenNeed - bal.token) : 0;
  const buyShortfall = () =>
    run(`Buy ${amt(tokenShort)} ${sym}`, async (c, rec) => {
      // exact-input: the shortfall plus 2%, at the spot price plus 3% for the pool fee and the price the buy moves
      if (isAddressParty(party)) return; // a role held by a fixed address (issuer, curator) does not shop for itself
      const ethIn = parseEther((tokenShort * 1.02 * priceAt(v.spot) * 1.03).toFixed(18));
      const o = await swap(c, v, party, true, ethIn);
      rec.record(beatOf(o, actor, `Buy ${sym} for the deposit`, () => `About ${amt(tokenShort * 1.02)} ${sym} for ${amt(eth(ethIn))} ETH`), { toast: true });
    });
  const otherVaults = launches.filter((l) => l.adopted && l.vault.toLowerCase() !== v.address.toLowerCase()).length;

  const canPay = !!bal && !!cost && bal.quote >= eth(cost[0]) && bal.token >= eth(cost[1]);
  return (
    <>
      <PageHeader
        eyebrow="Liquidity providers"
        title="Add liquidity beside the issuer's. Leave whenever you like."
        lead="Vault shares are in kind. A deposit buys the same slice of every range, at exactly what that slice holds right now. There is no share price, so there is no oracle to trust and nothing to manipulate. Swap fees accrue to every share; the curator takes its cut and nothing else."
        aside={
          <div className="flex flex-wrap items-center justify-end gap-3">
            <VaultPicker />
            {role === "lp" ? (
              <Tag tone="accent">Acting as outside LP</Tag>
            ) : (
              <Button size="sm" onClick={() => setRole("lp")}>
                Act as outside LP
              </Button>
            )}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel eyebrow="Deposit" title="Join every range, proportionally">
          <Slider label="New shares, as a share of the vault today" value={addPct} min={1} max={25} onChange={setAddPct} display={`${addPct}%`} />
          <div className="mt-4">
            <Row label="You pay">
              {cost
                ? `${amt(eth(cost[0]))} ETH + ${amt(eth(cost[1]))} ${sym}`
                : dep && !dep.ok && tokenShort > 0
                  ? `about ${amt(v.principal.quote * (addPct / 100))} ETH + ${amt(tokenNeed)} ${sym}`
                  : dep && !dep.ok
                    ? "—"
                    : "…"}
            </Row>
            <Row label="You will own">{pct((addPct / (100 + addPct)) * 1e4)} of the vault</Row>
            <Row label={`${name} wallet`}>
              <span className={canPay || !cost ? "" : "text-breach"}>{bal ? `${amt(bal.quote)} ETH · ${amt(bal.token)} ${sym}` : publicChain && !wallet ? "Connect a wallet" : "…"}</span>
            </Row>
          </div>
          {tokenShort > 0 && mayAct && !isAddressParty(party) && (
            <Button variant="secondary" className="mt-5 w-full" onClick={buyShortfall} disabled={!!busy}>
              Buy {amt(tokenShort * 1.02)} {sym} from the pool first
            </Button>
          )}
          <SendButton verb="deposit" variant="primary" className={tokenShort > 0 && mayAct ? "mt-2.5 w-full" : "mt-5 w-full"} onClick={deposit} disabled={!!busy || (publicChain && (!mayAct || !dep?.ok || !canPay))}>
            Deposit
          </SendButton>
          <p className="mt-2 text-center text-xs text-faint">
            {dep && !dep.ok && tokenShort > 0 && dep.error?.name !== "SetupEpoch"
              ? `The deposit takes ${sym} too, in proportion, and this wallet holds ${amt(bal?.token ?? 0)}: buy the difference, then deposit.`
              : dep && !dep.ok
              ? dep.error?.name === "SetupEpoch"
                ? `Deposits open when the setup epoch ends, in ${duration(v.pace.setupEndsAt - v.time)}.${publicChain ? (otherVaults ? " Another launch may already take them: pick it above." : "") : " Use +1d below."}`
                : dep.error?.reason
              : tokenShort > 0
                ? `The deposit takes ${sym} too, in proportion: buy the difference, then deposit.`
                : publicChain
                  ? `Simulated against the vault first, approval included: the cost shown is exactly what the contract will take. A first deposit asks your wallet to approve ${sym}, then to deposit.`
                  : "Simulated against the vault first: the cost shown is exactly what the contract will take."}
          </p>
        </Panel>

        <Panel
          eyebrow={watched ? "Watched position" : "Your position"}
          title={watched ? (watchedHere ? (posShares > 0n ? `${share(posShares)} of the vault` : "No shares") : "Reading…") : mine > 0n ? `${share(mine)} of the vault` : "No position yet"}
        >
          <AddressInput label="Watch an address" value={watchText} onChange={setWatchText} placeholder="Any 0x… address, to see its position" />
          {watchesPrincipal && (
            <p className="mt-1 text-xs leading-relaxed text-faint">
              Address zero holds the issuer&apos;s principal. It leaves only through the issuer&apos;s withdrawPrincipal, to the treasury, as it vests.
            </p>
          )}
          {!watched && picks.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {picks.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setWatchText(a)}
                  className="rounded-full border border-line-strong px-2.5 py-1 text-xs text-muted transition-colors hover:border-muted hover:text-ink"
                >
                  {named(a)}
                </button>
              ))}
            </div>
          )}
          {watched && (
            <button type="button" onClick={() => setWatchText("")} className="mt-2 text-xs text-faint underline-offset-2 hover:text-ink hover:underline">
              Stop watching: back to the {name}
            </button>
          )}
          <div className="mt-5">
            {posShares > 0n ? (
              <>
                <Slider label="Withdraw" value={outPct} min={1} max={100} onChange={setOutPct} display={`${outPct}%`} />
                <div className="mt-4">
                  <Row label={watched ? "Withdrawing returns" : "You receive"}>{back ? `${amt(eth(back[0]))} ETH + ${amt(eth(back[1]))} ${sym}` : out && !out.ok ? "—" : "…"}</Row>
                  <Row label="Fees earned">
                    {amt(owed.quote)} ETH · {amt(owed.token)} {sym}
                  </Row>
                </div>
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <SendButton verb="withdraw" variant="secondary" onClick={withdraw} disabled={!!busy || !mayExit}>
                    {mayExit || !isAddressParty(posParty) ? "Withdraw" : `Only ${shortAddress(posParty)} can withdraw`}
                  </SendButton>
                  <SendButton verb="claim" variant="ghost" onClick={claim} disabled={!!busy || !mayExit}>
                    Claim fees
                  </SendButton>
                </div>
                <p className="mt-2 text-center text-xs text-faint">
                  {!mayExit && isAddressParty(posParty)
                    ? `Simulated as ${shortAddress(posParty)}. Only that wallet can send it.`
                    : "Outside LPs are never locked, and an exit is never blocked by the price guard."}
                </p>
              </>
            ) : (
              <p className="py-6 text-center text-[13px] leading-relaxed text-muted">
                {watched
                  ? watchedHere
                    ? `${named(watched)} holds no shares in this vault.`
                    : `Reading ${shortAddress(watched)}'s position…`
                  : role === "curator"
                    ? "The curator holds no shares and never earns any by reshaping. There is nothing here to withdraw."
                    : "Deposit to receive shares. They redeem for the same slice of every range, whatever shape the curator has given the vault by then."}
              </p>
            )}
          </div>
        </Panel>
      </div>

      {isIssuer && (
        <Panel className="mt-6" eyebrow="Issuer principal" title="Locked, then vesting in a straight line">
          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <Row label="Vested">{pct(v.lock.vested * 1e4)}</Row>
              <Row label="Withdrawable now">{pct(v.lock.withdrawable * 1e4)} of the principal</Row>
              <Row label="Unlock">{v.time < v.lock.unlockStartsAt ? `in ${duration(v.lock.unlockStartsAt - v.time)}` : "started"}</Row>
              <Row label="Goes to">the treasury</Row>
            </div>
            <div>
              <Slider label="Withdraw of what has vested" value={principalPct} min={1} max={100} onChange={setPrincipalPct} display={`${principalPct}%`} />
              <Button
                className="mt-4 w-full"
                variant={v.raw.principalWithdrawable > 0n ? "secondary" : "danger"}
                onClick={withdrawPrincipal}
                // On a public chain a refused call is never sent, so the early exit can always be tried: it comes
                // back with the contract's own refusal, simulated as the issuer.
                disabled={!!busy || (publicChain && !mayAct && v.raw.principalWithdrawable > 0n)}
              >
                {publicChain && !mayAct && v.raw.principalWithdrawable > 0n ? "Only the issuer's wallet can withdraw" : v.raw.principalWithdrawable > 0n ? "Withdraw principal" : "Try to withdraw early"}
              </Button>
              <p className="mt-2 text-center text-xs text-faint">The issuer&apos;s principal is locked. Only the vested share can leave, and only to the treasury.</p>
            </div>
          </div>
        </Panel>
      )}

      <Panel className="mt-6" eyebrow="What a deposit buys" title="A proportional slice of this shape">
        <ShapeChart world={v} height={260} />
      </Panel>
    </>
  );
}
