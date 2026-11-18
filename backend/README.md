# Covenant backend

The service behind the app's **Playground**. Each visitor gets a private chain: an Anvil loaded from the same seeded
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

## Safety

- **One private Anvil per session.** The session id (128 random bits) is the only key to a chain, and it is never logged.
- **JSON-RPC allowlist:** the reads, `eth_sendRawTransaction`, and the dev controls the app uses (snapshots, mining,
  the clock, `anvil_setBalance`). Everything else is refused, including `anvil_reset` and `anvil_setRpcUrl`, which would
  make Anvil fetch any URL, and `anvil_loadState`, `anvil_dumpState`, impersonation, and debug or trace calls.
- **Limits:**
  - `MAX_CHAINS` chains run at once; one idle for two minutes is handed on when all are taken;
  - each address holds at most `CHAINS_PER_IP`;
  - idle chains stop after `CHAIN_IDLE_MS`;
  - request bodies are capped;
  - new chains are rate-limited per address.
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
| `MAX_CHAINS` | 4 | about 30 MB each when idle, more as a chain grows |
| `CHAINS_PER_IP` | 2 | |
| `CHAIN_IDLE_MS` | 600000 | |
| `ANVIL_BIN` | `anvil` | |
