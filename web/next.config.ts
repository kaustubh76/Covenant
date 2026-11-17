import path from "node:path";
import type { NextConfig } from "next";

// Base Sepolia's records, which a hosted copy has to carry in its API routes' bundle: the deployment, its launches and
// the live proof. The local chain's and the fork's records only ever exist on the machine running them.
const PUBLIC_RECORDS = ["../deployments/84532.json", "../deployments/84532.runtime.json", "../deployments/84532.proof.json"];

const nextConfig: NextConfig = {
  // The repository root: the API routes read deployments/ beside web/. Set explicitly, too, because lockfiles further
  // up the filesystem would otherwise make Next.js pick the wrong workspace root.
  outputFileTracingRoot: path.join(__dirname, ".."),
  outputFileTracingIncludes: {
    "/api/chain": PUBLIC_RECORDS,
    "/api/chain/networks": PUBLIC_RECORDS,
  },
};

export default nextConfig;
