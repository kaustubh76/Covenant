// Launch records a browser remembers (localStorage), checked before any of it is used: storage is the user's to edit,
// and an older version of the app may have written another shape. Discovery re-checks every record against the factory
// anyway; this keeps a malformed one from throwing on every refresh, or a huge kept span from starting a history scan.

import { type Address, isAddress } from "viem";
import type { LaunchRecord } from "./network";

/** The longest span a remembered record may keep: a few log calls, never a scan of history. */
export const MAX_REMEMBERED_SPAN = 2_000;
const MAX_SPANS = 10;
const MAX_RECORDS = 20;

const block = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const address = (x: unknown): x is Address => typeof x === "string" && isAddress(x);

/** The well-formed launch records in `raw`, each rebuilt from its checked fields only. */
export function sanitizeLaunches(raw: unknown): LaunchRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: LaunchRecord[] = [];
  for (const r of raw.slice(0, MAX_RECORDS)) {
    if (!r || typeof r !== "object") continue;
    const l = r as Record<string, unknown>;
    if (!address(l.vault) || !address(l.token) || !address(l.auction) || !block(l.createdAtBlock)) continue;
    const spans = Array.isArray(l.spans)
      ? (l.spans as unknown[])
          .filter((s): s is [number, number] => Array.isArray(s) && s.length === 2 && block(s[0]) && block(s[1]) && s[0] <= s[1] && s[1] - s[0] < MAX_REMEMBERED_SPAN)
          .slice(0, MAX_SPANS)
      : [];
    out.push({
      vault: l.vault,
      token: l.token,
      auction: l.auction,
      symbol: typeof l.symbol === "string" ? l.symbol.slice(0, 16) : "TOKEN",
      createdAtBlock: l.createdAtBlock,
      adopted: l.adopted === true,
      ...(spans.length ? { spans } : {}),
    });
  }
  return out;
}
