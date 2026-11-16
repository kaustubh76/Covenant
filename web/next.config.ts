import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lockfiles further up the filesystem would otherwise make Next.js pick the wrong workspace root.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
