"use client";

import type { Address } from "viem";
import { shortAddress } from "@/chain/accounts";
import { useChain } from "@/store/chain";

/** Which launch's vault the pages act on, when the chain has more than one. */
export function VaultPicker() {
  const launches = useChain((s) => s.launches).filter((l) => l.adopted);
  const vault = useChain((s) => s.vault);
  const select = useChain((s) => s.selectVault);
  if (launches.length < 2) return null;
  return (
    <label className="flex items-center gap-2 text-[13px] text-muted">
      <span className="text-faint">Launch</span>
      <select
        aria-label="Vault"
        value={vault ?? ""}
        onChange={(e) => void select(e.target.value as Address)}
        className="h-8 rounded-md border border-line-strong bg-surface px-2 text-ink"
      >
        {launches.map((l, i) => (
          <option key={l.vault} value={l.vault}>
            {l.symbol} #{i + 1} · {shortAddress(l.vault)}
          </option>
        ))}
      </select>
    </label>
  );
}
