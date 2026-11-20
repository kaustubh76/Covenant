// The ledger on record (deployments/84532.ledger.json, written by `npm run ledger`), read while the page is prerendered.

import type { Ledger } from "@/chain/ledger";
import { NETWORKS } from "@/chain/network";
import { readJson, recordFile } from "./deployments";

export async function liveLedger(): Promise<Ledger | null> {
  const l = await readJson<Ledger>(recordFile(`${NETWORKS["base-sepolia"].records}.ledger.json`));
  return l && Array.isArray(l.txs) && Array.isArray(l.coverage) ? l : null;
}
