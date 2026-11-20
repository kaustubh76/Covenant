import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { HttpError, cors } from "../src/http";

const res = () => {
  const headers: Record<string, string> = {};
  return { headers, setHeader: (k: string, v: string) => void (headers[k.toLowerCase()] = v) } as unknown as ServerResponse & { headers: Record<string, string> };
};

describe("CORS", () => {
  it("lets the app's own origin read the answer, retry-after included", () => {
    const r = res();
    expect(cors({ headers: { origin: "https://covenant-uhi11.vercel.app" } } as IncomingMessage, r, ["https://covenant-uhi11.vercel.app"])).toBe(true);
    expect(r.headers["access-control-allow-origin"]).toBe("https://covenant-uhi11.vercel.app");
    // without this, a page on another origin reads every 429's retry-after as absent and waits its own default instead
    expect(r.headers["access-control-expose-headers"]).toMatch(/retry-after/);
  });

  it("gives another origin no CORS headers, and serves callers with no origin", () => {
    const r = res();
    expect(cors({ headers: { origin: "https://elsewhere.example" } } as IncomingMessage, r, ["https://covenant-uhi11.vercel.app"])).toBe(false);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    expect(cors({ headers: {} } as IncomingMessage, res(), [])).toBe(true);
  });

  it("carries extra answer fields on an HttpError", () => {
    const e = new HttpError(409, "would revert", {}, { revert: { name: "NothingToRestore", data: "0x12345678" } });
    expect(e.extra).toEqual({ revert: { name: "NothingToRestore", data: "0x12345678" } });
    expect(new HttpError(400, "bad").extra).toEqual({});
  });
});
