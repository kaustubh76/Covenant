import type { Metadata } from "next";
import { ATTACKS } from "@/chain/scenarios/attacks";
import { backendUrl } from "@/server/deployments";
import { liveLedger } from "@/server/ledger";
import { LedgerPage } from "./LedgerPage";

export const metadata: Metadata = {
  title: "Ledger — Covenant",
  description: "Every Covenant function and every attack in the lab, with the Base Sepolia transactions that called it: settled, or refused by the deployed contracts.",
};

// The record of what has been sent on Base Sepolia, read from deployments/ at build time like the landing's proofs, and
// the backend's live feed of what is being sent now.
export default async function Page() {
  const attacks = ATTACKS.map((a) => ({ id: a.id, title: a.title, who: a.who, rule: a.rule }));
  return <LedgerPage ledger={await liveLedger()} attacks={attacks} backend={backendUrl()} />;
}
