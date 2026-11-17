import { Landing } from "@/components/landing/Landing";
import { liveDeployment } from "@/server/live";

// Prerendered: the live deployment's addresses and proof are read from deployments/ at build time, so the page calls
// no RPC to show them.
export default async function Page() {
  return <Landing live={await liveDeployment()} />;
}
