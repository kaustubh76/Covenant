// The Playground deployment's records: the addresses and the seeded launch, as web/scripts/playground-seed.ts left them.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PlaygroundRecords {
  manifest: Record<string, unknown>;
  runtime: Record<string, unknown> & { defaultVault?: string };
}

export function readRecords(dir: string): PlaygroundRecords {
  const manifest = JSON.parse(readFileSync(join(dir, "playground.json"), "utf8")) as Record<string, unknown>;
  const runtime = JSON.parse(readFileSync(join(dir, "playground.runtime.json"), "utf8")) as PlaygroundRecords["runtime"];
  return { manifest, runtime };
}
