import { type NextRequest, NextResponse } from "next/server";
import { NETWORKS, isNetworkKey } from "@/chain/network";
import { chainStatus, servedNetworks } from "@/server/deployments";

export const dynamic = "force-dynamic";

/**
 * One network's deployment and launches (?net=local|base-sepolia|base-sepolia-fork; the first one served by default),
 * or why not. A network this server does not offer answers `unavailable`, so the app opens one it does instead.
 */
export async function GET(req: NextRequest) {
  const served = servedNetworks();
  const net = req.nextUrl.searchParams.get("net") ?? served[0];
  if (!isNetworkKey(net)) return NextResponse.json({ state: "offline", reason: `Unknown network ${net}.` }, { status: 400 });
  if (!served.includes(net)) {
    const here = served.map((k) => NETWORKS[k].name).join(", ");
    // 200, not 404: a stale link is routine, and the app moves on to a network this server does offer.
    return NextResponse.json({ state: "offline", unavailable: true, reason: `${NETWORKS[net].name} is not offered here, only ${here}.` });
  }
  return NextResponse.json(await chainStatus(net), { headers: { "cache-control": "no-store" } });
}
