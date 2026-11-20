"use client";

// "Sent for real on Base Sepolia": beside an action a visitor can only preview (the curator's reshape, the issuer's
// powers), or one that has nothing to do right now, the real transactions that called the same function, from the
// ledger on record (/api/ledger, built from deployments/84532.ledger.json). Base Sepolia only: they are its transactions.

import clsx from "clsx";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { useChain } from "@/store/chain";

interface Coverage {
  explorer: string;
  vaults: { vault: Address; symbol: string }[];
  coverage: { contract: string; fn: string; settled: { hash: Hex; vault?: Address }[]; refused: { hash: Hex; error: string; vault?: Address }[] }[];
}

let once: Promise<Coverage | null> | null = null;
const load = () =>
  (once ??= fetch("/api/ledger")
    .then((r) => (r.ok ? (r.json() as Promise<Coverage>) : null))
    .catch(() => null));

/**
 * `fn` is a CovenantVault function, e.g. "reshape", or several for one line. `refusal` shows each one's latest refusal
 * too (default: yes).
 */
export function OnRecord({ fn, className, refusal = true }: { fn: string | string[]; className?: string; refusal?: boolean }) {
  const onBaseSepolia = useChain((s) => s.net?.key === "base-sepolia");
  const [c, setC] = useState<Coverage | null>(null);
  useEffect(() => {
    if (!onBaseSepolia) return;
    let live = true;
    void load().then((x) => live && setC(x));
    return () => {
      live = false;
    };
  }, [onBaseSepolia]);
  if (!onBaseSepolia || !c) return null;
  const fns = Array.isArray(fn) ? fn : [fn];
  const sym = (v?: Address) => (v ? c.vaults.find((x) => x.vault.toLowerCase() === v.toLowerCase())?.symbol : undefined);
  const link = (hash: Hex, label: string) => (
    <a href={`${c.explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-ink hover:underline">
      {label} ↗
    </a>
  );
  const rows = fns.flatMap((name) => {
    const row = c.coverage.find((r) => r.contract === "CovenantVault" && r.fn.split(" / ").includes(name));
    const settled = row?.settled.at(-1);
    const refused = refusal ? row?.refused.at(-1) : undefined;
    return settled || refused ? [{ name, settled, refused }] : [];
  });
  if (!rows.length) return null;
  const many = rows.length > 1;
  return (
    <p className={clsx("text-[11.5px] leading-relaxed text-faint", className)}>
      <span className="text-muted">{many ? "For real on Base Sepolia:" : `${rows[0].name}() for real on Base Sepolia:`}</span>{" "}
      {rows.map(({ name, settled, refused }, i) => (
        <span key={name}>
          {i > 0 && " · "}
          {many && <span className="num">{name} </span>}
          {settled && link(settled.hash, `settled${sym(settled.vault) ? ` on ${sym(settled.vault)}` : ""}`)}
          {settled && refused && ", "}
          {refused && link(refused.hash, `refused, ${refused.error.split("(")[0]}`)}
        </span>
      ))}
      {" · "}
      <Link href="/ledger" className="underline-offset-2 hover:text-ink hover:underline">
        the ledger
      </Link>
    </p>
  );
}
