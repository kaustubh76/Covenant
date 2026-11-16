import type { TestProject } from "vitest/node";
import { startLocalChain } from "../scripts/lib/localchain";

// A chain of its own: another port and another name for its deployment records, so the dev chain is untouched.
const PORT = Number(process.env.CHAIN_TEST_PORT ?? 8546);
const NAME = "31337-test";

declare module "vitest" {
  export interface ProvidedContext {
    rpcUrl: string;
    deployments: string;
  }
}

export default async function setup(project: TestProject) {
  const chain = await startLocalChain({ port: PORT, name: NAME, log: (s) => console.log(`chain-test: ${s}`) });
  project.provide("rpcUrl", chain.rpcUrl);
  project.provide("deployments", NAME);
  return async () => {
    await chain.stop();
  };
}
