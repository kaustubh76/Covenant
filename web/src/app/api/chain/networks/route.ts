import { NextResponse } from "next/server";
import { allStatuses } from "@/server/deployments";

export const dynamic = "force-dynamic";

/** Every network the app can talk to, with whether it is reachable now: the network switcher's list. */
export async function GET() {
  return NextResponse.json(await allStatuses(), { headers: { "cache-control": "no-store" } });
}
