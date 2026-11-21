"use client";

import type { Address } from "viem";
import { shortAddress } from "@/chain/accounts";
import { useChain } from "@/store/chain";

/** Which launch's vault the pages act on, when the chain has more than one. */
export function VaultPicker() {
  const launches = useChain((s) => s.launches).filter((l) => l.adopted);
  const vault = useChain((s) => s.vault);
  const select = useChain((s) => s.selectVault);
  // Not mid-action: switching vaults under a running send would read the result from the wrong vault.
  const busy = useChain((s) => s.busy);
  // the chain's own launch logs, or the launches on record when that scan failed (store: launchesFrom)
  const fromRecord = useChain((s) => s.launchesFrom === "record");
  if (launches.length < 2) return null;
  return (
    <label className="flex items-center gap-2 text-[13px] text-muted" title={fromRecord ? "The chain's launch logs could not be read just now, so the launches on record are listed; trying again" : undefined}>
      <span className="text-faint">Launch</span>
      <select
        aria-label="Vault"
        value={vault ?? ""}
        disabled={!!busy}
        title={busy ? `Wait for "${busy}" to finish` : undefined}
        onChange={(e) => void select(e.target.value as Address)}
        className="h-8 rounded-md border border-line-strong bg-surface px-2 text-ink"
      >
        {launches.map((l, i) => (
          <option key={l.vault} value={l.vault}>
            {l.symbol} #{i + 1} · {shortAddress(l.vault)}
          </option>
        ))}
      </select>
      {fromRecord && <span className="text-[11.5px] text-warn">on record, retrying</span>}
    </label>
  );
}
