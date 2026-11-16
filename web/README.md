# Covenant — the app

The web app for [Covenant](../README.md). It runs on the real contracts: every number on its pages is read from the
chain, every action is a transaction, and every refusal is the contract's own custom error, decoded.

## Run it

From the repository root:

```bash
make demo
```

It needs Foundry (`forge`, `anvil`) and Node 20 or newer. In a few seconds it does the following:

1. Starts Anvil on `127.0.0.1:8545` with a deterministic setup: a fixed genesis time, one second per block and no
   fees.
2. Deploys Uniswap v4, the Liquidity Launcher's `LBPStrategy`, the CCA factory and Covenant from the repository's
   pinned sources (`script/LocalStack.s.sol`).
3. Runs one real launch with the app's own launch code: vault, CCA auction, bids, migration, adoption and the
   demand-shaped seed. It then funds a bounty and takes a baseline snapshot.
4. Starts the app on http://localhost:3000.

Ctrl-C stops both. Inside `web/` the same pieces run separately: `npm run chain` starts the chain, `npm run dev`
starts the app.

## Pages

| Page | On-chain |
|---|---|
| `/` | The landing page. Its figures are recorded from the contracts, so it works with no chain running (`npm run record`) |
| `/vault` | Everything about a vault from `CovenantLens.snapshot`, plus its event history |
| `/launch` | Create a vault, verify the launch with `verifyLaunch`, bid in the CCA, close, migrate, adopt, seed |
| `/curate` | A cut-and-leg editor. Each edit runs `eth_simulateV1` with `[reshape, lens.snapshot]`, so the verdict and the chart are exactly what the contract would do |
| `/keep` | Restore with a pre-flighted bounty, a crash button that finds the smallest sell-off that strands support, and `poke` |
| `/provide` | In-kind deposits and exits at the simulated cost, fee claims, and the issuer's principal |
| `/govern` | The curator timelock, the issuer transfer, fees and the bounty pool |
| `/attacks` | The 20 attacks from `AttackCatalogue.t.sol` and `PumpRatchet.t.sol`, each in its own snapshot |
| `/demo` | The 10 steps of `LaunchToRelease.t.sol`. A snapshot is taken before each step, so any step can be run again |

The dock at the bottom moves chain time, trades against the pool and resets the chain to the baseline. The role
switcher signs as the issuer, curator, keeper, an outside LP or a holder. These are Anvil's public dev keys, and
`src/chain/accounts.ts` refuses them on any chain but 31337.

## How it is built

```
src/chain/        the contract layer, shared by the browser and the Node scripts
  abi.generated   typed ABIs from ../out, with one merged error ABI (npm run abi)
  launch.ts       the launch, step by step (UniswapStack._register, _bid, _closeAndMigrate)
  plans.ts        reshape legs (CovenantTestBase._honestLegs, _bid, _ask) and the hostile plans
  view.ts         VaultView: the lens snapshot as display numbers
  preflight.ts    eth_simulateV1: the revert, or the exact state an action would leave
  errors.ts       every custom error, with the rule it belongs to and a plain-English reason
  scenarios/      the guided demo, the attack lab and the crash-and-restore probe
src/store/chain.ts  network, current vault, view, role, a serialized transaction queue, the activity log
src/app/api/chain   the deployment manifest, and reset to the baseline snapshot
scripts/          chain.ts (bring-up), demo.ts (chain and app), record.ts (landing fixtures), gen-abi.ts
```

Pre-flights run against the `pending` block, which is where the transaction will actually land: the next block
number and the next second. Time- and block-gated checks therefore agree with the transaction. When a call would
revert, the scripted scenarios only pre-flight it, the way `vm.expectRevert` does. A submit from the UI sends it
anyway, so it is mined as a failed transaction with a hash.

## Test

```bash
npm test            # unit tests: price maths, error decoding, launch helpers, terms
npm run test:chain  # the guided demo and the attack lab against a dedicated chain on :8546
npm run lint && npm run build
```

`npm run test:chain` asserts the same outcomes as the Solidity tests it replays:
- the demo steps' reverts: `InsufficientShares`, `IdleTooLarge`, `SupportBroken`, `PriceGuard`, `TimelockActive`,
  `Locked`;
- the crash and the restore;
- every attack in the lab blocked.

## Base Sepolia

The data layer is chain-agnostic. Reads go through the lens, and each network has capabilities: only the local chain
has time travel, sandboxes and dev keys. Pointing the app at Base Sepolia needs a broadcast deployment
(`deployments/84532.json`) and a browser-wallet signer in `src/chain/client.ts`.
