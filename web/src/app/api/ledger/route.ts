import { NextResponse } from "next/server";
import { liveLedger } from "@/server/ledger";

// Built once, with the records: the coverage table the pages' "Sent for real on Base Sepolia" lines read.
export const dynamic = "force-static";

/** Each function's latest settled and refused transactions on Base Sepolia, from deployments/84532.ledger.json. */
export async function GET() {
  const l = await liveLedger();
  if (!l) return NextResponse.json({ explorer: "", vaults: [], coverage: [] });
  return NextResponse.json({
    explorer: l.explorer,
    vaults: l.vaults,
    coverage: l.coverage.map((c) => ({ contract: c.contract, fn: c.fn, settled: c.settled.slice(-3), refused: c.refused.slice(-3) })),
  });
}
