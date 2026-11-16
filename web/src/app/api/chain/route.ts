import { NextResponse } from "next/server";
import { localChain } from "@/server/deployments";

export const dynamic = "force-dynamic";

/** The chain the app should talk to: the local Anvil deployment when it is up, otherwise why it is not. */
export async function GET() {
  const local = await localChain();
  return NextResponse.json(local, { headers: { "cache-control": "no-store" } });
}
