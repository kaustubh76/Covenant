# Covenant backend

The service behind the app's **Playground**, a shared reader for Base Sepolia's history, and a small relayer that sends
a few fixed actions on Base Sepolia for visitors without a wallet. Each visitor gets a private chain: an Anvil loaded from the same seeded
launch as `make demo`. Every button in the app sends real transactions to it. A visitor can act as any role, trade, move
the clock, run the attack lab and reset, all without a wallet and without touching Base Sepolia.

It runs on Render from the repository's `Dockerfile` (see `render.yaml`); the web app stays on Vercel and calls it.

## Endpoints

| | |
|---|---|
| `GET /healthz` | Liveness, and how many chains are running |
| `GET /v1/info` | Limits, the seeded vault's address, and the caller's address as the rate limits count it |
| `POST /v1/playground/sessions` | Open a chain, or resume one with `{ "id": "…" }`. Returns the session id, its JSON-RPC path, and the deployment's addresses and seeded launch |
| `POST /v1/playground/sessions/:id/reset` | Put the chain back to the seed |
| `DELETE /v1/playground/sessions/:id` | Stop the chain |
| `POST /rpc/play/:id` | JSON-RPC to that chain, single or batched, through an allowlist |
| `POST /rpc/base-sepolia` | The shared Base Sepolia reader: read-only JSON-RPC, cached and paced (below) |
| `GET /v1/relay` | Whether the relayer is set up, its address and balance, today's spend and budget, and its actions |
| `POST /v1/relay/:action` | Send one of the relayer's actions (below) on a recorded vault. Returns the hash and a Basescan link |

## The Base Sepolia reader

Every visitor's feed scans the same history: the vaults' logs over the proof blocks, their receipts and blocks. The
reader fetches each of those once and serves it to everyone from a cache. The app sends only these reads through it
(`sharedRead` in `web/src/chain/client.ts`). Reads of the chain's head stay direct from each browser: every visitor
has their own rate budget at the public endpoint, and pooling them behind one address would only share one budget.

- **Cache:** results that cannot change are kept, such as a mined receipt, code, or logs and blocks 20 or more blocks
  behind the head. Reads of the head are shared for 1.5 s, and identical calls in flight are merged.
- **Pacing:** upstream calls are paced at `READ_RATE` (15/s) for all visitors together. A request that would queue
  longer than `READ_MAX_WAIT_MS` gets 429, and the app then reads directly.
- **Writes are refused,** including `eth_sendRawTransaction`: wallets send through their own RPC.
- **The upstream** is `BASE_SEPOLIA_RPC_URL`, the public endpoint by default. A keyed provider can go there as a Render
  secret; it is never logged or returned.

## The relayer

Visitors on Base Sepolia without a wallet, or without the role an action needs, can have the backend send it. It signs
with its own key, `RELAYER_PRIVATE_KEY`; without one, `/v1/relay` reports it off and the app hides its buttons.

- **Actions,** each on one of the recorded vaults (`{ "vault": "0x…" }`). The caller never supplies calldata:
  - `poke` and `collectFees`;
  - `restore` with `indices`, the ranges to put back;
  - `sell`, one token into the pool;
  - `buy`, up to 0.003 ETH, with a price limit 100 ticks above spot;
  - `drip` with `to`, test funds for a wallet: `RELAY_DRIP_ETH` and `RELAY_DRIP_TOKENS` of the vault's token.
- **Simulated first.** Each transaction is simulated just before it is sent; one that would revert is not sent, and the
  caller gets 409 with the reason.
- **Limits:**
  - 10 actions an hour per address, and 20 trades an hour across everyone;
  - one drip a day per wallet and per address;
  - `RELAY_DAILY_ETH` a day in all, then 503 until the next day (UTC);
  - a floor of 0.005 ETH, counting what is still in flight.
- **Refused:**
  - a key that is the deployer's, or a vault's issuer, curator or treasury;
  - a trade while the price is more than half the guard away from its average.
- **The key** is never logged or returned. Fund the account with `npm run relayer:fund -- --new` in `web/`: it creates
  the key in the repository's `.env` and tops it up from `PRIVATE_KEY` to 0.05 ETH and 50 of each launch's token.
  Running it again sends only the shortfall. On Render the key is a secret, set in the dashboard.

## Safety

- **One private Anvil per session.** The session id (128 random bits) is the only key to a chain, and it is never logged.
- **JSON-RPC allowlist:** the reads (`anvil_metadata` among them), `eth_sendRawTransaction`, and the dev controls the
  app uses (snapshots, mining, the clock, `anvil_setBalance`). Everything else is refused, including `anvil_reset` and
  `anvil_setRpcUrl`, which would make Anvil fetch any URL, and `anvil_loadState`, `anvil_dumpState`, impersonation, and
  debug or trace calls.
- **Reverts reach Anvil only for a snapshot the chain still holds.** Anvil 1.1.0 (and 1.7.1) mishandles a revert to
  any other id:
  - **A stale id,** one that a revert to an earlier snapshot already dropped: Anvil still lists it in `anvil_metadata`.
    A revert to it takes the blocks and the clock back but leaves the state, or leaves the head on a block that is no
    longer there.
  - **An id already consumed:** Anvil drops every later snapshot, a reset's new baseline included.

  So the proxy tracks the snapshots each chain holds. A revert to any other id, the backend's own baseline included, is
  answered `false` without reaching Anvil, as Anvil itself answers for a missing id.

  The tracking is exact because three kinds of call take turns on each chain: requests that take or revert a snapshot,
  and resets. Within such a request, each snapshot or revert is sent on its own, in the batch's order, with the calls
  between them together. Anvil runs a batch's calls concurrently, so this is the only way the batch's order holds.
- **Limits:**
  - `MAX_CHAINS` chains run at once; one idle for two minutes is handed on when all are taken;
  - each address holds at most `CHAINS_PER_IP`;
  - idle chains stop after `CHAIN_IDLE_MS`;
  - request bodies are capped;
  - new chains are rate-limited per address.
- **Each chain's share of memory.** Anvil keeps every block in memory, and a revert never gives it back. On Anvil 1.1.0
  that is about 75 KB a block empty and 170 KB with a transaction, kept whole; `--prune-history 128` cuts it to about a
  third. So each chain is held to:
  - 1,000 blocks per `anvil_mine` or `evm_mine` call (the app's largest is a launch's auction, about 200);
  - `PLAYGROUND_MAX_HEIGHT` blocks above its seed, read from the chain, so a revert or a reset gives the room back;
  - `PLAYGROUND_MAX_SNAPSHOTS` snapshots held at once, by id;
  - `PLAYGROUND_MAX_MB` of resident memory, read from `/proc` (Linux, as on Render): past it, nothing that grows the
    chain goes on.

  Each refusal is a JSON-RPC error whose message starts "This Playground chain" and ends "Reset it to start again: …"
  (-32000; -32602 for one call over 1,000 blocks). A reset of a chain past `PLAYGROUND_RESTART_MB` restarts it from the
  seed, since only a new process gives the memory back.
- **CORS:** only the app's origins (`ALLOWED_ORIGINS`).
- **Not a fork.** The seed is a fresh chain, so none of Base Sepolia's state, or the EIP-7702 sweepers on Anvil's
  well-known accounts there, comes along.

## Run it

```bash
npm install
npm run dev                      # on :8080; then in web/: COVENANT_BACKEND_URL=http://localhost:8080 npm run dev
npm test                         # the allowlist, and real Anvil chains end to end
npm run build && npm start       # the bundle the Docker image runs
```

The seeded state (`state/playground.json`) and its records (`deployments/playground*.json`) come from
`npm run playground:seed` in `web/`, which builds the same chain as `make demo` and saves Anvil's state.

**The clock.** A dumped state keeps the blocks but not Anvil's clock. So each chain sets its clock to its head block,
one second per block, as the local chain runs; otherwise the TWAP oracle would see time go backwards.

| Variable | Default | |
|---|---|---|
| `PORT` | 8080 | Render sets 10000 |
| `ALLOWED_ORIGINS` | the Vercel app and localhost:3000 | comma-separated |
| `MAX_CHAINS` | 4 | about 20 MB each when fresh, up to `PLAYGROUND_MAX_MB` as a chain grows |
| `CHAINS_PER_IP` | 2 | |
| `CHAIN_IDLE_MS` | 600000 | |
| `PLAYGROUND_MAX_HEIGHT` | 3000 | blocks a chain may stand above its seed |
| `PLAYGROUND_MAX_SNAPSHOTS` | 32 | snapshots (save points included) one chain may hold |
| `PLAYGROUND_MAX_MB` | 100 | resident memory one chain may grow to, where it can be read |
| `PLAYGROUND_RESTART_MB` | 60 | past this, a reset restarts the chain from the seed |
| `ANVIL_BIN` | `anvil` | |
| `BASE_SEPOLIA_RPC_URL` | `https://sepolia.base.org` | the reader's upstream; may carry a key |
| `READ_RATE` | 15 | upstream calls a second, all visitors together |
| `READ_MAX_WAIT_MS` | 4000 | longer than this, the caller is told to read directly |
| `RELAYER_PRIVATE_KEY` | none | the relayer's own key, with or without 0x; without it the relayer is off. A secret |
| `RELAY_DAILY_ETH` | 0.02 | the relayer's spend a day, gas and drips together |
| `RELAY_DRIP_ETH` | 0.002 | ETH per drip |
| `RELAY_DRIP_TOKENS` | 2 | the vault's token per drip |
