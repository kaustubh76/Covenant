// The Covenant backend: Playground chains with real writes (one private Anvil per visitor, loaded from the state
// web/scripts/playground-seed.ts saved), a cached read proxy for Base Sepolia, a relayer that sends a few actions for
// visitors without a wallet, and the live end of the app's ledger. Run with `npm run dev`, or `npm run build && npm start`.

import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { loadConfig } from "./config";
import { Buckets, HttpError, clientIp, cors, json, readBody } from "./http";
import { LedgerFeed } from "./ledger";
import { CHAIN_ID, startChain } from "./playground/anvil";
import { Playground, SESSION_ID, type Session } from "./playground/pool";
import { readRecords } from "./playground/records";
import { proxy } from "./playground/rpc";
import { BaseSepoliaReader } from "./readcache/proxy";
import { Relayer } from "./relay/relayer";

export function createBackend(config = loadConfig(), log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)) {
  const records = readRecords(config.records);
  const playground = new Playground({
    maxChains: config.maxChains,
    chainsPerIp: config.chainsPerIp,
    idleMs: config.idleMs,
    evictAfterMs: config.evictAfterMs,
    start: () => startChain({ bin: config.anvil, stateFile: config.stateFile, timeoutMs: config.startTimeoutMs }),
    limits: config.playgroundLimits,
    restartAboveMb: config.restartAboveMb,
    log,
  });
  // Six new chains a minute per address. Calls are limited per chain only against runaway loops: a visitor can only flood
  // their own chain, and the attack lab legitimately sends thousands of calls in a run.
  const opens = new Buckets(6 / 60, 6);
  const calls = new Buckets(2_000, 6_000);
  // The shared Base Sepolia reader, and how fast one address may call it (a browser paces itself at 12 a second).
  const reader = new BaseSepoliaReader({ upstream: config.baseSepoliaRpc, rate: config.readRate, maxWaitMs: config.readMaxWaitMs });
  const reads = new Buckets(40, 160);
  // Real Base Sepolia transactions for visitors without a wallet, from the backend's own key; off without one.
  const relayer = new Relayer({ key: config.relayerKey, rpc: config.baseSepoliaRpc, records: config.records, dailyEth: config.relayDailyEth, dripEth: config.dripEth, dripTokens: config.dripTokens });
  // The newest relayed transactions and transactions to the recorded vaults, from Blockscout, cached for everyone.
  const ledger = new LedgerFeed({ relayer: relayer.address, vaults: relayer.vaults });
  // Status and ledger reads are cheap once cached, but each address gets a modest rate; resets restart a whole chain.
  const looks = new Buckets(5, 20);
  const resets = new Buckets(10 / 60, 10);
  const started = Date.now();

  const describe = (s: Session, resumed: boolean, expired: boolean) => ({
    id: s.id,
    resumed,
    expired,
    chainId: CHAIN_ID,
    rpcPath: `/rpc/play/${s.id}`,
    idleMs: config.idleMs,
    manifest: records.manifest,
    runtime: { ...records.runtime, rpcUrl: "", baselineSnapshot: s.chain.baseline },
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!cors(req, res, config.origins)) return json(res, 403, { error: "This origin may not call the backend." });
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const path = new URL(req.url ?? "/", "http://backend").pathname;
    const ip = clientIp(req);

    if (req.method === "GET" && path === "/healthz") {
      return json(res, 200, { ok: true, uptimeS: Math.round((Date.now() - started) / 1000), playground: playground.stats(), reader: reader.stats });
    }
    if (req.method === "GET" && path === "/v1/info") {
      return json(res, 200, {
        service: "covenant-backend",
        // the address the rate limits count this caller as, to check what Render's edge forwards
        you: ip,
        playground: { chainId: CHAIN_ID, ...playground.stats(), idleMinutes: config.idleMs / 60_000, defaultVault: records.runtime.defaultVault },
      });
    }
    if (req.method === "POST" && path === "/v1/playground/sessions") {
      if (!opens.take(ip)) throw new HttpError(429, "Too many new chains from this address. Wait a minute.", { "retry-after": "60" });
      const body = await readBody(req, 10_000);
      let resume: string | undefined;
      try {
        const id = body ? (JSON.parse(body) as { id?: unknown }).id : undefined;
        resume = typeof id === "string" && SESSION_ID.test(id) ? id : undefined;
      } catch {
        throw new HttpError(400, "The body is not JSON.");
      }
      const { session, resumed, expired } = await playground.open(ip, resume);
      return json(res, 200, describe(session, resumed, expired));
    }
    const s = path.match(/^\/v1\/playground\/sessions\/([0-9a-f]{32})(\/reset)?$/);
    if (s && (req.method === "DELETE" || s[2]) && !resets.take(ip)) throw new HttpError(429, "Too many resets from this address. Wait a minute.", { "retry-after": "60" });
    if (s && req.method === "POST" && s[2]) {
      const session = await playground.reset(s[1]);
      return json(res, 200, { ok: true, baselineSnapshot: session.chain.baseline });
    }
    if (s && req.method === "DELETE" && !s[2]) {
      await playground.close(s[1], "closed by its visitor");
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && (path === "/v1/relay" || path === "/v1/ledger") && !looks.take(ip)) throw new HttpError(429, "Too many requests from this address.", { "retry-after": "5" });
    if (req.method === "GET" && path === "/v1/relay") return json(res, 200, await relayer.status());
    if (req.method === "GET" && path === "/v1/ledger") {
      try {
        return json(res, 200, await ledger.latest());
      } catch (e) {
        throw new HttpError(502, `The block explorer did not answer: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const relay = path.match(/^\/v1\/relay\/([A-Za-z]+)$/);
    if (relay && req.method === "POST") {
      const body = await readBody(req, 10_000);
      const out = await relayer.handle(relay[1], body, ip);
      return json(res, 200, { ...out, explorer: `https://sepolia.basescan.org/tx/${out.hash}` });
    }
    if (req.method === "POST" && path === "/rpc/base-sepolia") {
      if (!reads.take(ip)) throw new HttpError(429, "Too many reads from this address; call the network directly.", { "retry-after": "1" });
      const body = await readBody(req, 200_000);
      const { reply, cache } = await reader.handle(body);
      return json(res, 200, reply, { "x-cache": cache });
    }
    const r = path.match(/^\/rpc\/play\/([0-9a-f]{32})$/);
    if (r && req.method === "POST") {
      const session = playground.get(r[1]);
      if (!session) throw new HttpError(410, "This Playground chain has stopped: it sat idle, or the backend restarted. Open a new one.");
      const body = await readBody(req, config.maxBodyBytes);
      if (!calls.take(r[1])) throw new HttpError(429, "Too many calls to this chain at once.", { "retry-after": "1" });
      return json(res, 200, await proxy(session.chain.url, body, 120_000, playground.meter(session)));
    }
    throw new HttpError(404, "Not found");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : ((e as { status?: number }).status ?? 500);
      // Session ids are the keys to a chain: never write them to the log.
      if (status >= 500) log(`${status} ${req.method} ${(req.url ?? "").replace(/[0-9a-f]{32}/g, "…")}: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) {
        json(res, status, { ...(e instanceof HttpError ? e.extra : {}), error: e instanceof Error ? e.message : "Something went wrong" }, e instanceof HttpError ? e.headers : {});
      }
    });
  });

  const timer = setInterval(() => {
    void playground.reap();
    opens.prune();
    calls.prune();
    reads.prune();
    looks.prune();
    resets.prune();
    relayer.prune();
  }, 30_000);
  timer.unref();

  const close = async () => {
    clearInterval(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await playground.stopAll();
  };
  return { server, playground, close, config };
}

// Run as a program (npm start / npm run dev), not when a test imports createBackend.
if (process.argv[1] && /server\.(ts|js)$/.test(process.argv[1])) {
  const backend = createBackend();
  const { config } = backend;
  backend.server.listen(config.port, config.host, () => {
    console.log(`covenant-backend on ${config.host}:${config.port}; up to ${config.maxChains} Playground chains, idle ones stop after ${config.idleMs / 60_000} min`);
  });
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      void backend.close().finally(() => process.exit(0));
    });
  }
}
