// Small HTTP helpers: JSON replies, a capped body reader, CORS, the caller's address and per-key rate limits.

import type { IncomingMessage, ServerResponse } from "node:http";

/** An error with the HTTP status (and headers) to answer with. Its message is shown to the caller. */
export class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(data);
}

/** The request body as text, refusing more than `max` bytes. */
export function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, `The request is larger than ${max} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
};

/**
 * The caller's address, for rate limits. Render's edge sets the client's address in its own headers, which a caller
 * cannot override; X-Forwarded-For's first hop is used only without them, since a caller can write that one.
 */
export function clientIp(req: IncomingMessage): string {
  const edge = header(req, "cf-connecting-ip") ?? header(req, "true-client-ip");
  if (edge) return edge;
  const first = header(req, "x-forwarded-for")?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

/**
 * CORS for the app's own origins. Answers true when the request may go on: from an allowed origin, or from no browser
 * at all (no Origin header). A disallowed origin gets no CORS headers, so the browser keeps the answer from the page.
 */
export function cors(req: IncomingMessage, res: ServerResponse, origins: readonly string[]): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!origins.includes(origin)) return false;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-max-age", "600");
  return true;
}

/** Token buckets per key: `rate` tokens a second, holding at most `burst`. */
export class Buckets {
  private readonly rate: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(rate: number, burst: number, now: () => number = Date.now) {
    this.rate = rate;
    this.burst = burst;
    this.now = now;
  }
  /** Spend `n` tokens from `key`'s bucket, if it has them. */
  take(key: string, n = 1): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: t };
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 1000) * this.rate);
    b.at = t;
    const ok = b.tokens >= n;
    if (ok) b.tokens -= n;
    this.buckets.set(key, b);
    return ok;
  }
  /** Give back `n` tokens `take` spent, for a request that turned out to do nothing. */
  refund(key: string, n = 1): void {
    const b = this.buckets.get(key);
    if (b) b.tokens = Math.min(this.burst, b.tokens + n);
  }
  /** Forget buckets that have refilled completely, so the map does not grow without bound. */
  prune(): void {
    const t = this.now();
    for (const [k, b] of this.buckets) if (b.tokens + ((t - b.at) / 1000) * this.rate >= this.burst) this.buckets.delete(k);
  }
}
