// What a browser opening the backend's address sees. No chain is started.

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createBackend } from "../src/server";

describe("the backend's address", () => {
  // Origins set here, so an ALLOWED_ORIGINS in the environment cannot change what the page names as the app.
  const backend = createBackend({ ...loadConfig(), origins: ["http://localhost:3000", "https://app.example"], port: 0, host: "127.0.0.1" }, () => {});
  let base = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(backend.server.address() as AddressInfo).port}`;
  });
  afterAll(() => backend.close());

  it("says what it is and where to look, instead of Not found", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; app: string | null; paths: Record<string, string> };
    expect(body.service).toBe("covenant-backend");
    expect(body.app).toBe("https://app.example"); // the first https origin, not localhost
    expect(Object.keys(body.paths)).toEqual(["/healthz", "/v1/info", "/v1/relay", "/v1/ledger"]);
    // The two that need nothing outside this process answer; /v1/relay and /v1/ledger read Base Sepolia and Blockscout.
    for (const p of ["/healthz", "/v1/info"]) expect((await fetch(base + p)).status).toBe(200);
    expect((await fetch(`${base}/nothing-here`)).status).toBe(404);
  });
});
