import { liveDeployment } from "@/server/live";
import { AttacksPage } from "./AttacksPage";

// The attack lab. On Base Sepolia, cards whose attack a recorded proof has already played out link to its transaction,
// read from deployments/ at build time like the landing's.
export default async function Page() {
  return <AttacksPage deployment={await liveDeployment()} />;
}
