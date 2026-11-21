"use client";

import clsx from "clsx";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { type Hex, TransactionReceiptNotFoundError } from "viem";
import { createChainCtx } from "@/chain/client";
import { shortAddress } from "@/chain/accounts";
import type { CoverageRow, Ledger, LedgerTx } from "@/chain/ledger";
import type { Network } from "@/chain/network";
import { PageHeader, Panel, Stat, Tag } from "@/components/ui";
import { day } from "@/components/landing/Live";
import { type SentTx, readSent } from "@/lib/sentTxs";

const BASE_SEPOLIA = 84532;
const nf = new Intl.NumberFormat("en-US");
const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;
const ago = (iso: string | number) => {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129_600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} d ago`;
};
const ROLE: Record<LedgerTx["role"], string> = {
  // the project's deploying key: issuer and curator of each launch at first, until CVQ's lifecycle proof handed both on
  deployer: "Deployer",
  keeper: "Keeper",
  lp: "Outside LP",
  curator2: "New curator",
  issuer2: "Interim issuer",
  attacker: "Attacker",
  relayer: "Covenant's relayer",
};

interface FeedTx {
  hash: Hex;
  block: number;
  time: string;
  from: string;
  method: string | null;
  status: "success" | "reverted" | "pending";
  error?: string;
  relayed: boolean;
  symbol?: string;
}
interface RelayInfo {
  enabled: boolean;
  address?: string;
  balanceEth?: number | null;
  spentTodayEth?: number;
  dailyBudgetEth?: number;
  reason?: string;
}

function TxLink({ explorer, hash, children, className }: { explorer: string; hash: string; children?: React.ReactNode; className?: string }) {
  return (
    <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className={clsx("num underline-offset-2 hover:text-ink hover:underline", className)}>
      {children ?? `${short(hash)} ↗`}
    </a>
  );
}

/** A transaction's outcome: settled (green), refused (red), or not mined yet (hollow), never one shown as another. */
const Mark = ({ ok, pending }: { ok: boolean; pending?: boolean }) => (
  <span className={clsx("mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full", pending ? "border border-muted" : ok ? "bg-pass" : "bg-breach")} title={pending ? "Not mined yet" : undefined} aria-hidden />
);

/** The record: every function and attack with its Base Sepolia transactions, the live feed, and this browser's own sends. */
export function LedgerPage({ ledger, attacks, backend }: { ledger: Ledger | null; attacks: { id: string; title: string; who: string; rule: string }[]; backend: string | null }) {
  if (!ledger) {
    return (
      <PageHeader
        eyebrow="Ledger"
        title="Nothing on record yet."
        lead="The ledger is built from Base Sepolia with npm run ledger in web/, once the deployment's proofs have run. It lists every transaction the project's keys have sent there."
      />
    );
  }
  const covered = ledger.coverage.filter((c) => c.settled.length).length;
  const onChain = attacks.filter((a) => ledger.attacks[a.id]?.length).length;
  const refusals = ledger.txs.filter((t) => t.status === "reverted").length;
  const symbolOf = (vault?: string) => (vault ? ledger.vaults.find((v) => v.vault.toLowerCase() === vault.toLowerCase())?.symbol : undefined);
  return (
    <>
      <PageHeader
        eyebrow={`Ledger · ${ledger.network}`}
        title="Every move, on chain."
        lead={
          <>
            Each function a person can call on Covenant, and each attack in the{" "}
            <Link href="/attacks" className="text-ink underline-offset-2 hover:underline">
              attack lab
            </Link>
            , with the {ledger.network} transactions that called it: settled, or refused by the deployed contracts. {nf.format(ledger.txs.length)} transactions from the project&apos;s own keys and the backend&apos;s relayer, on
            record as of {day(ledger.generatedAt)}, block {nf.format(ledger.generatedAtBlock)}: each read back from the chain then. Nothing here is simulated; the live list below shows what happened since.
          </>
        }
        aside={
          <div className="grid grid-cols-3 gap-6 md:min-w-[360px]">
            <Stat label="Functions" value={`${covered}/${ledger.coverage.length}`} sub="settled for real" tone={covered === ledger.coverage.length ? "pass" : undefined} />
            <Stat label="Attacks" value={`${onChain}/${attacks.length}`} sub="played on chain" tone={onChain === attacks.length ? "pass" : undefined} />
            <Stat label="Refusals" value={refusals} sub="mined, decoded" />
          </div>
        }
      />

      <div className="grid gap-6">
        <Panel eyebrow="Every function" title="Called for real, and what the chain said" flush>
          <FunctionTable rows={ledger.coverage} explorer={ledger.explorer} symbolOf={symbolOf} />
        </Panel>

        <Panel eyebrow="The attack lab" title="Each attack, played on chain" flush>
          <ul className="divide-y divide-line">
            {attacks.map((a) => {
              const txs = ledger.attacks[a.id] ?? [];
              return (
                <li key={a.id} className="grid gap-2 px-5 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] md:gap-6">
                  <div className="min-w-0">
                    <div className="eyebrow">
                      {a.who} · {a.rule}
                    </div>
                    <Link href="/attacks" className="mt-0.5 block text-[14px] text-ink hover:underline">
                      {a.title}
                    </Link>
                  </div>
                  {txs.length ? (
                    <ul className="space-y-1">
                      {txs.map((t) => (
                        <li key={`${t.story}:${t.step}`} className="flex min-w-0 items-start gap-2 text-[12.5px] leading-snug">
                          <Mark ok={t.status === "success"} />
                          <span className="min-w-0 truncate">
                            <span className="text-muted">{stepLabel(ledger, t.hash) ?? t.step}</span>
                            {t.error && <span className="num text-breach"> · {t.error.split("(")[0]}</span>}
                            <span className="text-faint"> · {t.symbol} · </span>
                            <TxLink explorer={ledger.explorer} hash={t.hash} className="text-faint" />
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-[12.5px] text-faint">Not played on chain yet</span>
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>

        <LiveFeed backend={backend} explorer={ledger.explorer} />
        <Yours explorer={ledger.explorer} />

        <Panel eyebrow="The whole record" title={`${nf.format(ledger.txs.length)} transactions, oldest first`} flush>
          <details className="group">
            <summary className="cursor-pointer list-none px-5 py-3 text-[13px] text-muted hover:text-ink">
              <span className="group-open:hidden">Show every transaction ↓</span>
              <span className="hidden group-open:inline">Hide them ↑</span>
            </summary>
            <ul className="divide-y divide-line border-t border-line">
              {ledger.txs.map((t) => (
                <li key={t.hash} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 px-5 py-2 text-[12.5px] md:grid-cols-[110px_160px_minmax(0,1fr)_auto]">
                  <span className="num text-faint">{nf.format(t.block)}</span>
                  <span className="hidden truncate text-muted md:block">{ROLE[t.role]}</span>
                  <span className="min-w-0 truncate">
                    <span className="num text-ink">{t.fn.replace(/^[A-Za-z]+\./, "")}</span>
                    <span className="text-faint"> · {t.title ?? t.target}</span>
                    {t.error && <span className="num text-breach"> · {t.error}</span>}
                  </span>
                  <TxLink explorer={ledger.explorer} hash={t.hash} className="col-start-2 text-faint md:col-start-auto" />
                </li>
              ))}
            </ul>
          </details>
        </Panel>
      </div>
    </>
  );
}

const stepLabel = (ledger: Ledger, hash: string) => ledger.txs.find((t) => t.hash === hash)?.title;

function FunctionTable({ rows, explorer, symbolOf }: { rows: CoverageRow[]; explorer: string; symbolOf: (vault?: string) => string | undefined }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => {
        const errors = [...new Map(r.refused.map((x) => [x.error.split("(")[0], x])).values()];
        return (
          <li key={`${r.contract}.${r.fn}`} className="grid gap-2 px-5 py-3 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.2fr)] md:gap-6">
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="num truncate text-[14px] text-ink">{r.fn}</span>
                <span className="eyebrow shrink-0">{r.who}</span>
              </div>
              <div className="mt-0.5 truncate text-[12.5px] text-muted">
                {r.what} <span className="text-faint">· {r.contract}</span>
              </div>
            </div>
            <div className="min-w-0 text-[12.5px]">
              {r.settled.length ? (
                <div className="flex min-w-0 items-start gap-2">
                  <Mark ok />
                  <span className="min-w-0">
                    <span className="text-ink">Settled {r.settled.length > 1 ? `${r.settled.length} times` : "once"}</span>
                    <span className="block truncate text-faint">
                      {r.settled.slice(-2).map((x, i) => (
                        <span key={x.hash}>
                          {i > 0 && " · "}
                          {symbolOf(x.vault) && `${symbolOf(x.vault)} `}
                          <TxLink explorer={explorer} hash={x.hash} />
                        </span>
                      ))}
                    </span>
                  </span>
                </div>
              ) : (
                <Tag tone="warn">Not settled yet</Tag>
              )}
            </div>
            <div className="min-w-0 text-[12.5px]">
              {errors.length ? (
                <div className="flex min-w-0 items-start gap-2">
                  <Mark ok={false} />
                  <span className="min-w-0">
                    <span className="text-ink">Refused {r.refused.length > 1 ? `${r.refused.length} times` : "once"}</span>
                    <span className="block truncate text-faint">
                      {errors.slice(0, 3).map((x, i) => (
                        <span key={x.hash}>
                          {i > 0 && " · "}
                          <TxLink explorer={explorer} hash={x.hash} className="text-breach/90">
                            {x.error.split("(")[0]} ↗
                          </TxLink>
                        </span>
                      ))}
                    </span>
                  </span>
                </div>
              ) : (
                <span className="text-faint">No refusal on record</span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The backend's live list: what the relayer sent, and what anyone sent to the recorded vaults, newest first. */
function LiveFeed({ backend, explorer }: { backend: string | null; explorer: string }) {
  const [feed, setFeed] = useState<{ txs: FeedTx[]; updatedAt: string } | null>(null);
  const [relay, setRelay] = useState<RelayInfo | null>(null);
  // When the backend last started (from /healthz's uptime): its count of today's spend begins then, not at midnight.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "waking" | "off">(backend ? "loading" : "off");
  // why the last poll failed, when it answered at all: a refusal or an error, rather than sleep
  const [why, setWhy] = useState<string | null>(null);
  useEffect(() => {
    if (!backend) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (tries: number) => {
      try {
        const [f, r] = await Promise.all([
          fetch(`${backend}/v1/ledger`, { signal: AbortSignal.timeout(20_000) }).then(async (x) => {
            if (x.ok) return x.json();
            // the backend answered: say what it said (the explorer behind it did not answer, a limit), not that it sleeps
            const said = ((await x.json().catch(() => null)) as { error?: string } | null)?.error;
            throw Object.assign(new Error(said ?? `HTTP ${x.status}`), { answered: x.status < 502 || x.status > 504 });
          }),
          fetch(`${backend}/v1/relay`, { signal: AbortSignal.timeout(20_000) }).then((x) => (x.ok ? x.json() : null)),
          fetch(`${backend}/healthz`, { signal: AbortSignal.timeout(20_000) })
            .then((x) => (x.ok ? (x.json() as Promise<{ uptimeS?: number }>) : null))
            .then((h) => (h && typeof h.uptimeS === "number" ? Date.now() - h.uptimeS * 1000 : null))
            .catch(() => null),
        ]).then(([f, r, up]) => {
          if (live) setStartedAt(up);
          return [f, r] as const;
        });
        if (!live) return;
        setFeed(f as { txs: FeedTx[]; updatedAt: string });
        setRelay(r as RelayInfo | null);
        setWhy(null);
        setState("ok");
        timer = setTimeout(() => void load(0), 30_000);
      } catch (e) {
        if (!live) return;
        setWhy((e as { answered?: boolean }).answered ? (e as Error).message : null);
        // Asleep: a free backend takes about a minute to wake. A list already shown stays shown (one missed poll is not
        // news), and the next poll comes as usual; with nothing shown yet, say it is waking.
        setState((was) => (was === "ok" ? "ok" : tries < 6 ? "waking" : "off"));
        timer = setTimeout(() => void load(tries + 1), tries < 6 ? 10_000 * (tries + 1) : 60_000);
      }
    };
    void load(0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [backend]);
  if (!backend) return null;
  return (
    <Panel
      eyebrow="Live"
      title="The newest transactions"
      action={
        relay?.enabled && relay.address ? (
          <span className="num hidden text-right text-[11.5px] leading-snug text-faint sm:block" title="The backend's relayer sends a few actions for visitors without a wallet, from its own small key">
            relayer {shortAddress(relay.address as Hex)}
            {relay.balanceEth != null && ` · ${relay.balanceEth.toFixed(4)} ETH`}
            <br />
            {relay.spentTodayEth?.toFixed(4)} of {relay.dailyBudgetEth} ETH spent today
            {/* the backend counts in memory: after a restart today, the count starts at the restart */}
            {startedAt && startedAt > Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())
              ? ` (counted since the backend started, ${new Date(startedAt).toISOString().slice(11, 16)} UTC)`
              : ""}
          </span>
        ) : relay && !relay.enabled ? (
          <Tag tone="warn">Relayer off</Tag>
        ) : undefined
      }
      flush
    >
      <p className="px-5 pt-1 text-[13px] text-muted">
        What Covenant&apos;s relayer sent for visitors without a wallet, and what anyone sent to the recorded vaults, read from the chain{feed ? ` ${ago(feed.updatedAt)}` : ""}. It refreshes every 30 seconds.
      </p>
      {state === "ok" && feed ? (
        feed.txs.length ? (
          <ul className="mt-2 divide-y divide-line border-t border-line">
            {feed.txs.map((t) => (
              <li key={t.hash} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-5 py-2 text-[12.5px] md:grid-cols-[100px_170px_minmax(0,1fr)_auto]">
                <span className="hidden text-faint md:block">{ago(t.time)}</span>
                <span className="hidden truncate text-muted md:block">{t.relayed ? "Covenant's relayer" : shortAddress(t.from as Hex)}</span>
                <span className="flex min-w-0 items-start gap-2">
                  <Mark ok={t.status === "success"} pending={t.status === "pending"} />
                  <span className="min-w-0 truncate">
                    <span className="num text-ink">{t.method ?? "transfer"}</span>
                    {t.symbol && <span className="text-faint"> · {t.symbol}</span>}
                    {t.error && <span className="num text-breach"> · {t.error}</span>}
                    <span className="text-faint md:hidden"> · {t.relayed ? "relayer" : shortAddress(t.from as Hex)} · {ago(t.time)}</span>
                  </span>
                </span>
                <TxLink explorer={explorer} hash={t.hash} className="text-faint" />
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-4 text-[13px] text-faint">Nothing yet.</p>
        )
      ) : (
        <p className="px-5 py-4 text-[13px] text-faint">
          {why
            ? `Covenant's backend answered, but could not list the latest transactions: ${why}. It is asked again shortly.`
            : state === "waking"
              ? "Covenant's backend is waking up (it sleeps when idle, about a minute)…"
              : state === "loading"
                ? "Reading the chain…"
                : "Covenant's backend did not answer. The record above stands on its own, up to its date; what happened since shows here once the backend answers."}
        </p>
      )}
    </Panel>
  );
}

/** What this browser has sent on Base Sepolia, kept by the app (lib/sentTxs.ts). */
function Yours({ explorer }: { explorer: string }) {
  const [list, setList] = useState<SentTx[]>([]);
  useEffect(() => {
    const read = () => setList(readSent(BASE_SEPOLIA));
    // another tab's change to this browser's sends, and nothing else it stores
    const onStorage = (e: StorageEvent) => (!e.key || e.key.startsWith("covenant.sent.")) && read();
    read();
    window.addEventListener("covenant:sent", read);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("covenant:sent", read);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  const rows = useMemo(() => list.slice(0, 20), [list]);
  // Each one's outcome, read again from its receipt: what this browser saw when it sent it may have been "not mined yet".
  const [onChain, setOnChain] = useState<Record<string, "success" | "reverted" | "pending">>({});
  // asked again while any is still not mined
  const [again, setAgain] = useState(0);
  useEffect(() => {
    if (!rows.length) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      const res = await fetch("/api/chain?net=base-sepolia", { cache: "no-store" }).then((r) => r.json() as Promise<{ state: string; network?: Network }>).catch(() => null);
      if (!res?.network || res.state !== "ready") return;
      const ctx = createChainCtx(res.network);
      const read = await Promise.all(
        rows.map((t) =>
          ctx.pub
            .getTransactionReceipt({ hash: t.hash })
            .then((r) => [t.hash, r.status === "success" ? "success" : "reverted"] as const)
            .catch((e: unknown) => [t.hash, e instanceof TransactionReceiptNotFoundError ? "pending" : null] as const),
        ),
      );
      if (!live) return;
      const known = read.filter((x): x is readonly [Hex, "success" | "reverted" | "pending"] => x[1] !== null);
      setOnChain(Object.fromEntries(known));
      if (known.some(([, st]) => st === "pending")) timer = setTimeout(() => live && setAgain((n) => n + 1), 15_000);
    })();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [rows, again]);
  if (!rows.length) return null;
  return (
    <Panel eyebrow="Yours" title="Sent from this browser" flush>
      <ul className="divide-y divide-line">
        {rows.map((t) => (
          <li key={t.hash} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-5 py-2 text-[12.5px]">
            <span className="flex min-w-0 items-start gap-2">
              {/* the chain's word when its receipt was read; what this browser saw when sending, until then */}
              <Mark ok={onChain[t.hash] ? onChain[t.hash] === "success" : t.ok} pending={onChain[t.hash] === "pending"} />
              <span className="min-w-0 truncate">
                <span className="text-ink">{t.title}</span>
                {/* what this browser saw when sending, until the chain's receipt says otherwise */}
                {t.error && !onChain[t.hash] && <span className="num text-breach"> · {t.error}</span>}
                {onChain[t.hash] === "reverted" && <span className="num text-breach"> · reverted on chain</span>}
                {onChain[t.hash] === "pending" && <span className="text-faint"> · not mined yet</span>}
                <span className="text-faint">
                  {" "}
                  · {t.by ?? "You"} · sent {ago(t.at)}
                </span>
              </span>
            </span>
            <TxLink explorer={explorer} hash={t.hash} className="text-faint" />
          </li>
        ))}
      </ul>
    </Panel>
  );
}
