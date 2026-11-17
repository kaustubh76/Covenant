import { liveDeployment } from "@/server/live";
import { DemoPage } from "./DemoPage";

// The ten steps run on the local chain. On a public chain the page walks the live proof instead, read from
// deployments/ at build time like the landing's.
export default async function Page() {
  return <DemoPage live={await liveDeployment()} />;
}
