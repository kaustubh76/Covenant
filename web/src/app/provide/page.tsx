"use client";

import { useEffect, useRef, useState } from "react";
import { type Address, formatEther, isAddressEqual, maxUint256, parseEther, zeroAddress } from "viem";
import { covenantVaultAbi, testTokenAbi } from "@/chain/abi.generated";
import { ACTOR_LABEL, type Actor, type Who, actorOf, shortAddress } from "@/chain/accounts";
import { beatOf } from "@/chain/beat";
import { isFailureKind } from "@/chain/failure";
import { NEVER } from "@/chain/launch";
import { swap } from "@/chain/market";
import { type ActionCall, type Preflight, preflight, vaultEvents, failedPreflight } from "@/chain/preflight";
import { priceAt } from "@/chain/price";
import { buyableWithinGuard, depositCall, ensureAllowance, guardEdgeTick, largestDepositThatFits, quoteBudget, standInDeposit, withSlack } from "@/chain/provide";
import { type Party, isAddressParty, send, sendRetrying } from "@/chain/tx";
import type { VaultView } from "@/chain/view";
import { NeedsChain } from "@/components/chain/NeedsChain";
import { ShapeChart } from "@/components/covenant/ShapeChart";
import { OnRecord } from "@/components/covenant/OnRecord";
import { VaultPicker } from "@/components/covenant/VaultPicker";
import { Button, PageHeader, Panel, Row, Slider, Tag } from "@/components/ui";
import { amt, duration, pct } from "@/lib/format";
import { useBalances } from "@/lib/useBalances";
import { fact } from "@/lib/fact";
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
const withdrawCall = (v: Pick<VaultView, "address">, shares: bigint, min0: bigint, min1: bigint) =>
  ({ address: v.address, abi: covenantVaultAbi, functionName: "withdraw", args: [shares, min0, min1, NEVER] }) as const;

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
  // Each preview is kept with the vault and party it priced, so after a vault or role switch an old one is never shown
  // (or lets Deposit through) while the new one loads.
  const [depAt, setDepAt] = useState<{ key: string; p: Preflight } | null>(null);
  const [outAt, setOutAt] = useState<{ key: string; p: Preflight } | null>(null);
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
  // A public chain's issuer or curator is a fixed address, not the connected wallet: the panels read that address's
  // balances and position, not the wallet's. When the wallet is that address, it is the payer: it buys and deposits.
  const fixed = isAddressParty(party) ? party : null;
  const yours = !fixed || (!!wallet && isAddressEqual(wallet.address, fixed));
  const bal = useBalances(actor, fixed ?? undefined);
  const cap = publicChain && bal ? spendable(bal.quote) : undefined;

  const newShares = v ? (v.raw.totalShares * BigInt(addPct)) / 100n : 0n;
  // The acting account's shares, as read: undefined when no account was read (a public chain with no wallet, or one on
  // another network), which the page says rather than showing an empty position.
  const mineRead = v?.raw.sharesOf[actor];
  const mine = mineRead ?? 0n;

  // Watching: any address's position, read for itself, with its exit simulated as that address. Deposits stay with the
  // acting role. `?watch=0x…` opens it, and is kept in step so the link can be shared.
  const [watchText, setWatchText] = useState("");
  const typedWatch = parseAddress(watchText).address;
  // Address zero is the principal's own account (VaultStorage's PRINCIPAL_ACCOUNT): its shares leave only through the
  // issuer's withdrawPrincipal, so it is explained rather than shown as a position anyone could exit.
  const watchesPrincipal = !!typedWatch && isAddressEqual(typedWatch, zeroAddress);
  const watched = watchesPrincipal ? null : typedWatch;
  // Whose position is read by address: a watched one, or a public chain's issuer or curator.
  const readAt = watched ?? fixed;
  const [readPos, setReadPos] = useState<{ vault: Address; address: Address; shares: bigint; owed: readonly [bigint, bigint]; failed?: boolean } | null>(null);
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
    if (!ctx || !v || !readAt) return;
    let live = true;
    const at = { address: v.address, abi: covenantVaultAbi } as const;
    const here = (p: { vault: Address; address: Address } | null) => !!p && isAddressEqual(p.address, readAt) && isAddressEqual(p.vault, v.address);
    Promise.all([ctx.pub.readContract({ ...at, functionName: "sharesOf", args: [readAt] }), ctx.pub.readContract({ ...at, functionName: "feesOwed", args: [readAt] })])
      .then(([shares, owed]) => live && setReadPos({ vault: v.address, address: readAt, shares, owed }))
      // Said, and asked again on the next view refresh, rather than "Reading…" for good. A position read before stays.
      .catch(() => live && setReadPos((p) => (here(p) && !p?.failed ? p : { vault: v.address, address: readAt, shares: 0n, owed: [0n, 0n], failed: true })));
    return () => {
      live = false;
    };
  }, [ctx, v, readAt]);
  const readHere = readAt && v && readPos && isAddressEqual(readPos.address, readAt) && isAddressEqual(readPos.vault, v.address) ? readPos : null;
  const readOk = readHere && !readHere.failed ? readHere : null;
  // whose position the panel shows and exits: the watched address, or the acting role
  const posParty: Party = watched ?? party;
  const posShares = readAt ? (readOk?.shares ?? 0n) : mine;
  const burn = (posShares * BigInt(outPct)) / 100n;

  const depKey = v ? `${v.address}:${party}` : "";
  useEffect(() => {
    if (!ctx || !v) return;
    if (newShares === 0n) {
      setDepAt(null);
      return;
    }
    let live = true;
    const key = `${v.address}:${party}`;
    // With no signer on a public chain (no wallet, or one on another network) the role acts from address zero, which
    // holds nothing: the deposit is priced from a stand-in funded inside the simulation instead, so the cost shown is
    // still the contract's own.
    const previewing = publicChain && !ctx.signer && !isAddressParty(party);
    (previewing ? standInDeposit(ctx, v, newShares, addPct / 100) : preflight(ctx, party, depositCall(v, newShares, quoteBudget(v, addPct / 100, cap)), v, approveFirst(v)))
      .catch(failedPreflight)
      .then((p) => live && setDepAt({ key, p }));
    return () => {
      live = false;
    };
  }, [ctx, v, party, addPct, newShares, cap, publicChain, wallet]);
  const outKey = v ? `${v.address}:${posParty}` : "";
  useEffect(() => {
    if (!ctx || !v || burn === 0n) {
      setOutAt(null);
      return;
    }
    let live = true;
    const key = `${v.address}:${posParty}`;
    preflight(ctx, posParty, withdrawCall(v, burn, 0n, 0n), v)
      .catch(failedPreflight)
      .then((p) => live && setOutAt({ key, p }));
    return () => {
      live = false;
    };
  }, [ctx, v, posParty, burn]);
  const dep = depAt && depAt.key === depKey ? depAt.p : null;
  const out = outAt && outAt.key === outKey ? outAt.p : null;

  // On a public chain the vault is shared, so a buy only goes as far as the price guard's edge (provide.ts): what the
  // pool sells before that is read here, for the payer that would buy, whenever it is short of the token.
  const [buyableAt, setBuyableAt] = useState<{ key: string; tokens: number; spend: number } | null>(null);
  const shortGuess = v && bal ? v.principal.token * (addPct / 100) * 1.01 - bal.token : 0;
  const askBuyable = publicChain && !!ctx?.signer && yours && shortGuess > 0;
  useEffect(() => {
    if (!ctx || !v || !askBuyable) return;
    let live = true;
    const key = v.address;
    buyableWithinGuard(ctx, v)
      .then((b) => live && setBuyableAt({ key, tokens: eth(b.tokens), spend: eth(b.spend) }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ctx, v, askBuyable]);

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
  const owed = readAt ? (readOk ? owedPair(readOk.owed) : null) : (v.fees.owed[actor] ?? null);
  /** An event's two amounts as quote and token: amount0 is the quote only when the quote is currency0. */
  const inKind = (a0: bigint, a1: bigint) => {
    const { quote, token } = owedPair([a0, a1]);
    return `${amt(quote)} ETH and ${amt(token)} ${sym}`;
  };
  const notReadWhy = ctx?.walletChainId ? `switch your wallet to ${net?.name}` : `connect a wallet on ${net?.name}`;
  const posWho: Who = watched ? ((devChain ? actorOf(watched) : undefined) ?? "anyone") : actor;
  const mayExit = canSendAs(posParty, net, wallet);
  const share = (x: bigint) => pct((Number(x) / Number(v.raw.totalShares)) * 1e4);
  const picks = [...(wallet ? [wallet.address] : []), ...(seen && isAddressEqual(seen.vault, v.address) ? seen.depositors : [])]
    .filter((a, i, all) => all.findIndex((b) => isAddressEqual(a, b)) === i)
    .slice(0, 5);
  const isIssuer = role === "issuer";
  const principalBurn = (v.raw.principalWithdrawable * BigInt(principalPct)) / 100n;
  const describe = { now: v.time, tokenSymbol: sym };

  const deposit = () =>
    run(`Deposit for ${addPct}% new shares`, async (c, rec) => {
      const p = await preflight(c, party, depositCall(v, newShares, quoteBudget(v, addPct / 100, cap)), v, approveFirst(v));
      if (!p.ok) {
        rec.record({ actor, title: `Deposit for ${addPct}% new shares`, ok: false, error: p.error }, { toast: true });
        return;
      }
      const [a0, a1] = p.value as readonly [bigint, bigint];
      // A real wallet approves exactly what this deposit may take; dev chains keep the open allowance their demos rely on.
      const approved = await ensureAllowance(c, party, v, withSlack(a1), !c.net.caps.devChain);
      // Just after its approval, a public RPC node a block behind can still refuse the deposit as unapproved: that
      // refusal is simulated again before it is believed. Nothing is sent until a simulation passes.
      const o = await sendRetrying(
        c,
        party,
        { ...depositCall(v, newShares, withSlack(a0)), args: [newShares, withSlack(a0), withSlack(a1), NEVER] as const },
        { force: true, describe },
        { retryIf: (x) => approved && x.error?.name === "TransferFromFailed" },
      );
      const ev = vaultEvents(o.receipt?.logs as never, v.address).find((e) => e.name === "Deposited");
      rec.record(
        beatOf(o, actor, `Deposit for ${addPct}% new shares`, () =>
          ev ? `Paid ${inKind(ev.args.amount0 as bigint, ev.args.amount1 as bigint)}, exactly ${addPct}% of each range` : undefined,
        ),
        { toast: true },
      );
    });

  const withdraw = () =>
    run(`Withdraw ${outPct}% of position`, async (c, rec) => {
      const title = `Withdraw ${outPct}% of position`;
      const p = await preflight(c, posParty, withdrawCall(v, burn, 0n, 0n), v);
      // The exit's floor comes from this pre-flight. One that failed for a node or wallet reason decided nothing: say
      // so, rather than send with no floor. A refusal is sent on a dev chain only, forced, so it is mined with a hash
      // and says why; a public chain never sends it.
      if (!p.ok && (isFailureKind(p.error?.name) || !c.net.caps.devChain)) {
        rec.record({ actor: posWho, title, ok: false, error: p.error }, { toast: true });
        return;
      }
      const [m0, m1] = p.ok ? (p.value as readonly [bigint, bigint]) : [0n, 0n];
      const o = await send(c, posParty, withdrawCall(v, burn, (m0 * 995n) / 1000n, (m1 * 995n) / 1000n), { force: true, describe });
      const ev = vaultEvents(o.receipt?.logs as never, v.address).find((e) => e.name === "Withdrawn");
      rec.record(beatOf(o, posWho, title, () => (ev ? `Received ${inKind(ev.args.amount0 as bigint, ev.args.amount1 as bigint)}` : undefined)), {
        toast: true,
      });
    });

  const claim = () =>
    run("Claim fees", async (c, rec) => {
      const o = await send(c, posParty, { address: v.address, abi: covenantVaultAbi, functionName: "claimFees", args: [] }, { describe });
      const r = o.value as readonly [bigint, bigint] | undefined;
      rec.record(beatOf(o, posWho, "Claim fees", () => (r ? inKind(r[0], r[1]) : undefined)), { toast: true });
    });

  const withdrawPrincipal = () =>
    run(`Withdraw ${principalPct}% of vested principal`, async (c, rec) => {
      const shares = principalBurn > 0n ? principalBurn : 10n ** 16n; // nothing vested: ask for 1% to show the lock
      const o = await send(c, party, { address: v.address, abi: covenantVaultAbi, functionName: "withdrawPrincipal", args: [shares, 0n, 0n, NEVER] }, { force: true, describe });
      const ev = vaultEvents(o.receipt?.logs as never, v.address).find((e) => e.name === "PrincipalWithdrawn");
      rec.record(
        beatOf(o, actor, "Withdraw principal to the treasury", () => (ev ? `${inKind(ev.args.amount0 as bigint, ev.args.amount1 as bigint)} to the treasury` : undefined)),
        { toast: true },
      );
    });

  // A wallet on a public chain starts with ETH only, and on a dev chain the issuer and curator hold none of the token
  // (the launch took all the issuer minted): the token side of a deposit is bought from the pool first. With none of
  // the token the deposit cannot even be simulated (the transfer fails first), so the need is read from the vault's own
  // holdings, which a proportional deposit matches exactly; once the payer holds some, the simulation's.
  const tokenNeed = cost ? eth(cost[1]) : v.principal.token * (addPct / 100) * 1.01;
  const tokenShort = bal ? Math.max(0, tokenNeed - bal.token) : 0;
  // The shortfall plus 2%, and never a sliver that rounds to a zero-wei buy.
  const buyTokens = Math.max(tokenShort * 1.02, tokenNeed * 0.001);
  // Guard first: the vault checks the price guard before it takes any token, so while the guard holds no deposit can go
  // through, short or not. Buying more then would only push spot further from the time-weighted price and lengthen the
  // wait, so the buy comes back once the price has held.
  const guarded = dep?.ok === false && dep.error?.name === "PriceGuard";
  // The payer can shop: the role's own account here, or on a public chain the connected wallet when it is the payer.
  const canShop = tokenShort > 0 && mayAct && yours && !guarded;
  // A public chain's checks before buying: whether the wallet's ETH covers the buy and the deposit (with some for gas),
  // and whether the pool sells enough before spot reaches the guard's edge.
  const buyEth = tokenShort > 0 ? buyTokens * priceAt(v.spot) * 1.03 : 0;
  const depositEth = cost ? eth(cost[0]) : v.principal.quote * (addPct / 100) * 1.1;
  const ethShort = publicChain && !!bal && yours && bal.quote < buyEth + depositEth + 0.002;
  const buyableHere = buyableAt && buyableAt.key === v.address ? buyableAt : null;
  const withinGuard = devChain || (!!buyableHere && buyableHere.tokens >= buyTokens);
  const fits = publicChain && buyableHere ? largestDepositThatFits({ vaultTokens: v.principal.token, held: bal?.token ?? 0, buyable: buyableHere.tokens }) : 0;
  const showBuy = canShop && withinGuard && !ethShort;
  const showFit = canShop && publicChain && !ethShort && !!buyableHere && !withinGuard && fits >= 1 && fits < addPct;
  const buyAs: Actor = fixed ? "holder" : (party as Actor); // on a public chain every actor is the connected wallet
  const buyShortfall = () =>
    run(`Buy ${amt(buyTokens)} ${sym}`, async (c, rec) => {
      if (!yours) return; // a public chain's issuer or curator is a fixed address, not this wallet: it does not shop here
      // Exact-input: the shortfall plus 2%, at the spot price plus 3% for the pool fee and the price the buy moves. On a
      // public chain the buy stops at the guard's edge, whatever it was given: the vault is everyone's, and a deposit
      // (or a reshape, anyone's) waits while the guard holds.
      const ethIn = parseEther((buyTokens * priceAt(v.spot) * 1.03).toFixed(18));
      const o = await swap(c, v, buyAs, true, ethIn, publicChain ? guardEdgeTick(v) : undefined);
      rec.record(beatOf(o, actor, `Buy ${sym} for the deposit`, () => `About ${amt(buyTokens)} ${sym} for at most ${amt(eth(ethIn))} ETH${publicChain ? ", within the price guard" : ""}`), {
        toast: true,
      });
    });
  const otherVaults = launches.filter((l) => l.adopted && l.vault.toLowerCase() !== v.address.toLowerCase()).length;

  const canPay = !!bal && !!cost && bal.quote >= eth(cost[0]) && bal.token >= eth(cost[1]);
  const signer = !!ctx?.signer;
  const wrongNetwork = publicChain && !!wallet && !!net && wallet.chainId !== net.chainId;
  /** The line under Deposit: what stands in the way, or how the cost was found. */
  const depositNote = (): string => {
    const refusal = dep && !dep.ok ? dep.error : undefined;
    if (refusal?.name === "SetupEpoch") {
      return `Deposits open when the setup epoch ends, in ${duration(v.pace.setupEndsAt - v.time)}.${publicChain ? (otherVaults ? " Another launch may already take them: pick it above." : "") : " Use +1d below."}`;
    }
    // a buy moves spot past the guard: on a dev chain the clock lets the time-weighted price catch up
    if (refusal?.name === "PriceGuard") return devChain ? `${refusal.reason} Use +1h below.` : (refusal.reason ?? "");
    if (fixed && !yours) {
      return `Simulated as the ${name}, ${shortAddress(fixed)}: only that wallet can deposit as it. To deposit from your own wallet, act as the outside LP (top right).${
        refusal && refusal.name !== "TransferFromFailed" && refusal.reason ? ` ${refusal.reason}` : ""
      }`;
    }
    if (publicChain && !signer) {
      return `Priced by the live contract, simulated from a stand-in funded inside the simulation: nothing is sent. ${
        wrongNetwork ? `Switch your wallet to ${net?.name} to deposit.` : "Connect a wallet to deposit, or try it on the Playground."
      }`;
    }
    if (ethShort && bal) {
      return `This wallet holds ${amt(bal.quote)} ETH. The deposit needs about ${amt(depositEth)} ETH${buyEth > 0 ? `, and buying its ${sym} about ${amt(buyEth)} more` : ""}, plus gas: lower the deposit, or add ETH.`;
    }
    if (tokenShort > 0) {
      if (publicChain && !buyableHere) return `The deposit takes ${sym} too, in proportion. Checking how much the pool can sell within the price guard…`;
      if (publicChain && !withinGuard) {
        return fits >= 1
          ? `Within the price guard the pool sells about ${amt(buyableHere?.tokens ?? 0)} ${sym} right now: enough for a deposit of up to ${fits}%. A bigger buy would move the price past the guard and pause every deposit on this vault for a while.`
          : `The price is close to the guard's edge: the pool can't sell ${sym} now without pausing every deposit on this vault. Wait a few minutes, then try again.`;
      }
      return `The deposit takes ${sym} too, in proportion, and ${publicChain ? "this wallet" : `the ${name}`} holds ${amt(bal?.token ?? 0)}: buy the difference, then deposit.`;
    }
    if (refusal) return refusal.reason ?? "";
    return publicChain
      ? `Simulated against the vault first, approval included: the cost shown is exactly what the contract will take. A first deposit asks your wallet to approve ${sym}, then to deposit.`
      : "Simulated against the vault first: the cost shown is exactly what the contract will take.";
  };
  const walletLabel = publicChain ? (fixed && !yours ? `${name} · ${shortAddress(fixed)}` : "Your wallet") : `${name} wallet`;
  const walletLine = bal ? `${amt(bal.quote)} ETH · ${amt(bal.token)} ${sym}` : publicChain && !wallet ? "Connect a wallet" : wrongNetwork ? `Your wallet is on another network` : "…";
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
              <Button size="sm" onClick={() => setRole("lp")} disabled={!!busy}>
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
            <Row label={fixed && !yours ? `The ${name} pays` : "You pay"}>
              {cost
                ? `${amt(eth(cost[0]))} ETH + ${amt(eth(cost[1]))} ${sym}`
                : dep && !dep.ok && (tokenShort > 0 || dep.error?.name === "NoPreview")
                  ? `about ${amt(v.principal.quote * (addPct / 100))} ETH + ${amt(tokenNeed)} ${sym}`
                  : dep && !dep.ok
                    ? "—"
                    : "…"}
            </Row>
            <Row label={fixed && !yours ? `The ${name} would own` : "You will own"}>{pct((addPct / (100 + addPct)) * 1e4)} of the vault</Row>
            <Row label={walletLabel}>
              <span className={!yours || canPay || !cost || (publicChain && !wallet) ? "" : "text-breach"}>{walletLine}</span>
            </Row>
          </div>
          {showBuy && (
            <Button variant="secondary" className="mt-5 w-full" onClick={buyShortfall} disabled={!!busy}>
              Buy {amt(buyTokens)} {sym} from the pool first
            </Button>
          )}
          {showFit && (
            <Button variant="secondary" className="mt-5 w-full" onClick={() => setAddPct(fits)} disabled={!!busy}>
              Deposit {fits}% instead
            </Button>
          )}
          <SendButton
            verb="deposit"
            variant="primary"
            className={showBuy || showFit ? "mt-2.5 w-full" : "mt-5 w-full"}
            onClick={deposit}
            disabled={!!busy || (publicChain && (!mayAct || !dep?.ok || !canPay))}
          >
            {publicChain && wallet && fixed && !yours ? `Only ${shortAddress(fixed)} can deposit` : "Deposit"}
          </SendButton>
          <p className="mt-2 text-center text-xs text-faint">{depositNote()}</p>
          <OnRecord fn="deposit" className="mt-2 text-center" />
        </Panel>

        <Panel
          eyebrow={watched ? "Watched position" : fixed && !yours ? `The ${name}'s position` : "Your position"}
          title={
            readAt
              ? readOk
                ? posShares > 0n
                  ? `${share(posShares)} of the vault`
                  : "No shares"
                : readHere?.failed
                  ? "Not read yet"
                  : "Reading…"
              : mineRead === undefined
                ? "Not read"
                : mine > 0n
                  ? `${share(mine)} of the vault`
                  : "No position yet"
          }
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
                  <Row label={watched || (fixed && !yours) ? "Withdrawing returns" : "You receive"}>{back ? `${amt(eth(back[0]))} ETH + ${amt(eth(back[1]))} ${sym}` : out && !out.ok ? "—" : "…"}</Row>
                  <Row label="Fees earned">
                    {owed ? `${amt(owed.quote)} ETH · ${amt(owed.token)} ${sym}` : "Not read"}
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
                <OnRecord fn={["withdraw", "claimFees"]} className="mt-2 text-center" />
              </>
            ) : (
              <p className="py-6 text-center text-[13px] leading-relaxed text-muted">
                {watched
                  ? readOk
                    ? `${named(watched)} holds no shares in this vault.`
                    : readHere?.failed
                      ? `Couldn't read ${shortAddress(watched)}'s position just now: trying again.`
                      : `Reading ${shortAddress(watched)}'s position…`
                  : role === "curator"
                    ? "The curator holds no shares and never earns any by reshaping. There is nothing here to withdraw."
                    : fixed && !yours
                      ? readOk
                        ? `${named(fixed)} holds no vault shares of its own. The issuer's principal is below.`
                        : readHere?.failed
                          ? "Couldn't read this position just now: trying again."
                          : "Reading…"
                      : mineRead === undefined
                        ? `No account was read: ${notReadWhy} to see your position, or watch an address above.`
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
              <Row label="Vested">
                <span {...fact("vault.vested", v.lock.vested, v.block)}>{pct(v.lock.vested * 1e4)}</span>
              </Row>
              <Row label="Withdrawable now">
                <span {...fact("vault.principalWithdrawable", v.raw.principalWithdrawable, v.block)}>{pct(v.lock.withdrawable * 1e4)}</span> of the principal
              </Row>
              <Row label="Unlock">
                <span {...fact("vault.unlockStartsAt", v.lock.unlockStartsAt, v.block)}>{v.time < v.lock.unlockStartsAt ? `in ${duration(v.lock.unlockStartsAt - v.time)}` : "started"}</span>
              </Row>
              <Row label="Goes to">
                the treasury, <span {...fact("vault.treasury", v.people.treasury, v.block)}>{shortAddress(v.people.treasury)}</span>
              </Row>
            </div>
            <div>
              <Slider label="Withdraw of what has vested" value={principalPct} min={1} max={100} onChange={setPrincipalPct} display={`${principalPct}%`} />
              <SendButton
                verb="withdraw"
                // The early try needs no wallet: on a public chain a refused call is never sent, so it comes back with the
                // contract's own refusal, simulated as the issuer. A real withdrawal needs the issuer's wallet.
                gate={v.raw.principalWithdrawable > 0n}
                className="mt-4 w-full"
                variant={v.raw.principalWithdrawable > 0n ? "secondary" : "danger"}
                onClick={withdrawPrincipal}
                disabled={!!busy || (publicChain && !mayAct && v.raw.principalWithdrawable > 0n)}
              >
                {publicChain && !mayAct && v.raw.principalWithdrawable > 0n ? "Only the issuer's wallet can withdraw" : v.raw.principalWithdrawable > 0n ? "Withdraw principal" : "Try to withdraw early"}
              </SendButton>
              <p className="mt-2 text-center text-xs text-faint">The issuer&apos;s principal is locked. Only the vested share can leave, and only to the treasury.</p>
              <OnRecord fn="withdrawPrincipal" className="mt-2 text-center" />
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
