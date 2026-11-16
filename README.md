# Covenant

**Locked for holders. Managed for the market.**

A Uniswap v4 hook and vault that lets a token launch's liquidity be actively managed without ever being withdrawable.

Today a launch's liquidity is either locked, so holders know it cannot be pulled but it can never move, or handed to a manager who can move it and can also remove it. Covenant is the missing middle. The launch's LP is held by a vault under three rules fixed before the auction:

1. **Conservation.** Principal never leaves the pool before it vests. A reshape moves value between price ranges, nothing more.
2. **Support.** After any curator action, at least S% of the quote sits as bids within B ticks below the price.
3. **Pace.** The curator restructures at most M% of the vault per epoch, and a curator change takes a timelock.

A named curator reshapes freely inside those rules. If price drift breaks Support, anyone can restore it for a bounty. Outside LPs can join in kind. Covenant plugs into Uniswap's own launch stack: a Continuous Clearing Auction migrates through the stock `LBPStrategy` into a pool where Covenant is both the hook and the LP recipient. No fork of Uniswap's contracts.

The full product spec is in [`docs/SPEC.md`](docs/SPEC.md) and the execution flow in [`docs/Covenant_Flow.excalidraw`](docs/Covenant_Flow.excalidraw).

---

## Results

Everything below is a passing test. Run `forge test` to reproduce it.

| | |
|---|---|
| Support at launch, the launcher's full-range position | **722 bps** (fails a 40% covenant) |
| Support after the demand-shaped seed | **5,238 bps** |
| Price impact of the same 5-token dump: full range vs Covenant | **973 ticks vs 145 ticks** (6.7× less) |
| Pump-ratchet drain against the prototype | vault loses **82%** of its quote, attacker **+81.68 ETH** |
| Same attack against this version | attacker **−0.85 ETH** (fees), vault quote intact |
| Same launch, run against Uniswap's **deployed** contracts on Base Sepolia (fork test) | **722 → 5,238 bps**, `verifyLaunch` passes, pump-ratchet finds nothing to restore |
| Swap overhead of the hook | ~8.5k gas (~31k when a swap opens a new oracle slot, first lap only) |
| Tests | **182 passing** (181 local, 1 against Base Sepolia): unit, fuzz, attack catalogue, 3 pool orientations, 8 invariants, end-to-end, fork |
| The web app's guided demo and attack lab, replayed as real transactions on a local chain | all 10 steps and all **20 attacks** reproduce the Solidity suite's outcomes (`make web-test`) |
| Line coverage of `src/` | vault 96.3%, vault ops 99.6%, hook 100%, lens 100%, oracle 98.6%, rule library 97.8%, `Orient`/`RangeMath`/`PaceLib`/`TermsLib` 100% |

---

## What this version changes from the spec

Building the product surfaced problems the prototype's tests did not reach. Each change below is backed by a test.

### 1. The pump-ratchet, and the Anchor that closes it

Once a launch's asks are bought, the price moves through empty ticks for free. An attacker with no role could:

1. buy every ask;
2. push the price far up through empty ticks;
3. hold it for one TWAP window;
4. call the permissionless `restore`, which moves the vault's quote up to just under the pumped price;
5. sell into it.

Against the prototype ([`test/prototype/PumpRatchetPoC.t.sol`](test/prototype/PumpRatchetPoC.t.sol)) this takes **82% of the principal quote** in one restore call.

Covenant now has three defences:

- **An Anchor.** Each vault keeps a reference price that follows the TWAP down at once but climbs at most B per epoch. The Support band is measured from the lower of the TWAP and the Anchor, so asks filled during a rally count as support and nothing lapses.
- **A bid ceiling.** The curator can never place a bid above the Anchor plus G.
- **A restore cap.** `restore` never bids above the highest range the vault already holds. Even after a pump held for days, restore can only bid where the vault has already sold, so whoever bought those tokens can sell them back for at most what they paid.

[`test/attacks/PumpRatchet.t.sol`](test/attacks/PumpRatchet.t.sol) runs the same script for a quick pump and for a four-day pump, with the Anchor kept synced the whole time. The attacker loses both times.

### 2. A TWAP that cannot be flushed or dragged

The prototype's 32-slot observation ring could be emptied by 32 swaps in 32 blocks, which shrank its "30-minute" TWAP to seconds. The oracle here ([`TwapOracle`](src/libraries/TwapOracle.sol)) changes two things:

- **Slew-limited recorded tick.** It walks toward spot at most 10 ticks per second. A two-block spike of 500,000 ticks moves the 30-minute TWAP by less than one tick.
- **Bucketed ring.** One slot per minute, so 128 slots always reach back more than two hours however often the pool trades.

The area under the walk is integrated in closed form. A fuzz test checks it against an independent per-second simulation across 2,000 random write sequences, exactly.

### 3. Conservation by construction, not by tolerance

The prototype's reshape took absolute liquidities computed off-chain, so any trade landing first made its conservation check fail. Here a reshape lists **cuts** (liquidity to remove) and **legs** (ranges to add, as shares of what was freed). Legs are sized inside the PoolManager unlock at the actual price, and a **sink** leg per currency takes whatever is left. Anything not placed stays in the vault, capped at 0.1% of the reshape. The vault has no code path that pays principal out other than a proportional share burn.

### 4. Smaller changes

- **Pace** is a refilling allowance tracked as a fraction of the vault. Fixed epochs allowed 2M across a boundary in two blocks, and an amount-based cap could be inflated by a deposit.
- **Restore** pays only when Support is back to at least S, and at most 1% of the quote it moved, so restoring dust earns dust. Tokens it touches keep their prices or move up, never down.
- **Exits ignore the Guard.** A proportional in-kind exit cannot hurt anyone left in the vault, and guarding it would let anyone who can move spot through empty ticks freeze withdrawals for free.
- **The vault is created before the auction.** Its address is deterministic per creator, and the factory validates every term once. Bidders can check the committed launch on-chain before they bid: the launch's LP recipient is the vault, and the pool hook is Covenant.
- **The lock is relative to adoption.** The vault exists before the migration time is known, so the lock reads "launch + 90 days".
- **Both pool orientations.** The quote may be currency0 or currency1 (ETH, or USDC on either side). The core properties run once per orientation.
- **Fees reach outside LPs.** The prototype sent every fee to the treasury, so depositing earned nothing. Fees now accrue pro rata to every share through per-share accumulators, after a curator share set in the terms (`curatorFeeBps`, at most 30%). Deposits and exits settle an account after their own touch has realized fees but before shares change. A newcomer earns nothing that predates them, and a leaver keeps everything their shares earned.

The spec's demo (section 18) step 7 shows a rally making Support lapse. Under the Anchor design a rally does not lapse Support, because filled asks are support. Restore is for crashes that strand quote below the band; see `test_demo_restoreAfterACrash`.

---

## How it works

```
                       before the auction                                  every swap
 issuer ── CovenantFactory.createVault(key, terms) ──► CovenantVault (clone)   CovenantHook ◄── PoolManager
             validates terms; address known in advance │                      (one per chain)
                                                       │ named as LP recipient   beforeInitialize: only LBPStrategy
 CCA auction ──► LBPStrategy.migrate ──► pool hooked by CovenantHook              afterInitialize: seed oracle
                 mints LP NFT to the vault                                        afterSwap: record tick
                                                       │                          consult(): TWAP
 anyone ── adopt(nftIds) ──────────────────────────────┤ burns the NFTs, holds the liquidity directly in the PoolManager
 curator ── reshape(cuts, legs) ───────────────────────┤ Guard · Pace · sized legs · bid ceiling · Support
 anyone ── restore(indices) ───────────────────────────┤ only when Support < S; capped at the vault's own price span
 LPs ───── deposit / withdraw (in kind) ───────────────┤ proportional slice of every range
 issuer ── withdrawPrincipal (after the lock, vested) ─┘
```

| Contract | Role |
|---|---|
| [`CovenantHook`](src/CovenantHook.sol) | Inherits Uniswap's `InitializerHook` unchanged, so LBPStrategy accepts it and only that strategy can initialize pools with it. Runs the TWAP oracle. Holds no funds and has no owner. |
| [`CovenantFactory`](src/CovenantFactory.sol) | Validates terms, creates one vault clone per launch at a deterministic per-creator address. |
| [`CovenantVault`](src/CovenantVault.sol) | Entry points, rule checks around each PoolManager unlock, payouts, governance. |
| [`VaultOps`](src/vault/VaultOps.sol) | Everything inside an unlock: remove, size, add, book fees apart, settle. Runs by DELEGATECALL from the vault on its storage and refuses direct calls. Splitting it out keeps the vault under the 24 KB limit. |
| [`CovenantLogic`](src/libraries/CovenantLogic.sol) | External library: Support, Anchor, valuation, restore targets, leg validation. |
| [`SeedPlanner`](src/periphery/SeedPlanner.sol) | View contract. Reads the CCA's outbid demand curve (about 6.7k gas per price level) and returns a ready-to-submit first reshape. |
| [`CovenantLens`](src/periphery/CovenantLens.sol) | View contract. `verifyLaunch(factory, strategy, auction)` lets a bidder check, before bidding, that a launch's LP goes to a genuine Covenant vault bound to that pool and hook, and read its terms. `snapshot(vault)` returns everything about a vault in one call. |

More detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Threat model, attack catalogue and residual risks are in [`docs/SECURITY.md`](docs/SECURITY.md).

### Terms

Fixed per vault and validated by the factory. These are the spec's presets.

| | S | B | M | E | G | W | Lock | Vest | T |
|---|---|---|---|---|---|---|---|---|---|
| Conservative | 50% | 2000 | 30% | 1 day | 300 | 30 min | 180 d | 90 d | 3 d |
| Standard | 40% | 1500 | 50% | 1 day | 300 | 30 min | 90 d | 30 d | 2 d |
| Aggressive | 30% | 1000 | 70% | 12 h | 500 | 15 min | 60 d | 30 d | 1 d |

Each vault also sets `bounty` (the presets use 0.01 ETH) and `curatorFeeBps` (the presets use 10%). Bounds enforced at creation: B ≥ G + 3 tick spacings, 5 min ≤ W ≤ 2 h, 1 h ≤ E ≤ 30 days, curator fee ≤ 30%.

---

## Build and test

Requires Foundry. Dependencies are git submodules pinned to the Liquidity Launcher's `foundry.lock`. That launcher is the same code as v3.3.0 deployed on Base Sepolia, and the CCA is the same as factory v2.1.0. Both were checked file by file.

```bash
git submodule update --init          # not --recursive: the launcher's own submodules include the optimism monorepo
forge build
forge test                           # 181 tests (the fork test skips without an RPC URL)
make test-attacks                    # attack catalogue and pump-ratchet, with revert reasons
make test-invariant                  # stateful fuzzing
make test-integration                # the spec's 10-step demo on Uniswap's real CCA, LBPStrategy and v4
make poc                             # the drain, against the unmodified prototype
make sizes                           # EIP-170 gate for src/
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org make test-fork   # against Uniswap's deployed contracts
```

## Demo app

`web/` is a Next.js app that runs on these contracts. One command starts everything:

```bash
make demo        # Anvil, Uniswap's launch stack and Covenant, a seeded launch, and the app on http://localhost:3000
```

It needs Foundry (`forge`, `anvil`) and Node 20 or newer. The bring-up takes a few seconds:
1. Start Anvil with a fixed clock: one second per block, no fees.
2. Deploy Uniswap v4, the Liquidity Launcher's `LBPStrategy`, the CCA factory and Covenant from the pinned sources (`script/LocalStack.s.sol`).
3. Run a real launch end to end: vault, auction, bids, migration, adoption and the demand-shaped seed.

| Page | What it does on-chain |
|---|---|
| Vault | the vault's live state from `CovenantLens`, the rule rail, positions, fees and events |
| Launch | create a vault with chosen terms, verify it with `verifyLaunch`, bid in the CCA, migrate, adopt and seed |
| Curate | an editor for cuts and legs; every edit is simulated with `eth_simulateV1`, so the verdict and the drawn layout are the contract's own |
| Keep | restore with a pre-flighted bounty; a crash button that finds the smallest sell-off that strands support |
| Provide, Govern | deposits and exits in kind, fee claims, the curator timelock, the issuer transfer |
| Attack lab | all 20 attacks from the Solidity suite as real transactions, each in its own snapshot |
| Guided demo | the spec's 10 steps (`LaunchToRelease.t.sol`) as real transactions, rewindable step by step |

Roles sign with Anvil's well-known dev keys, which the app refuses on any other chain. A dock at the bottom of the app moves chain time, trades against the pool and resets the chain. With no chain running, the landing page still works: its figures were recorded from the contracts (`make record`), and every other page shows how to start the chain.

```bash
make web-test    # unit tests, then the demo and attack lab against a dedicated chain
```

### Repository

```
src/            CovenantHook · CovenantFactory · CovenantVault · vault/{VaultStorage,VaultOps}
                libraries/{TwapOracle,CovenantLogic,RangeMath,Orient,PaceLib,TermsLib} · periphery/{SeedPlanner,CovenantLens}
test/unit       oracle vs a per-second reference, range math vs the PoolManager, pace, terms, orientation
test/hook       mined flags, LBPStrategy compatibility, oracle behaviour, gas
test/vault      core rules, lifecycle, fee sharing, three pool orientations
test/attacks    spec section 13.2 row by row, attacks found in this build, the pump-ratchet
test/invariant  eight invariants under random trading, time, curator, keepers, LPs, issuer
test/integration  the spec's demo end to end; restore after a crash; demand-curve gas; the lens
test/fork       the same launch against Uniswap's deployed Base Sepolia contracts
test/prototype  the original prototype, kept unmodified (imports only) as the baseline for the proof of concept
script/         Deploy.s.sol (Base Sepolia), LocalStack.s.sol (local Anvil), base/CovenantDeployer.sol, config/84532.json
web/            the demo app (its own git repository): src/chain is the contract layer, src/app the pages
docs/           SPEC.md (the product spec), ARCHITECTURE.md, SECURITY.md, flow diagram, prototype archive
```

---

## Deployment

Target: **Base Sepolia**. Uniswap's LBPStrategy v3.3.0, CCA factory v2.1.0, LiquidityLauncher, PoolManager and PositionManager are all live there. Unichain Sepolia, the spec's original target, has only the CCA factory.

```bash
forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL                                   # simulate
forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY \
    --broadcast --verify --etherscan-api-key $BASESCAN_API_KEY                                      # deploy
```

The simulation passes against the live chain: about 21.4M gas, roughly 0.0002 ETH at current Base Sepolia prices. The hook goes to a CREATE2 address mined for its three permission flags, and the script checks its flags, its initializer and the factory wiring before finishing. Addresses land in `deployments/84532.json` after a broadcast. **Not broadcast yet.**

## Status

Hackathon code for UHI11. **Unaudited.** Do not use with real funds.
