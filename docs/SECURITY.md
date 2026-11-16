# Covenant security notes

Unaudited hackathon code. This document records the threat model, every attack the test suite exercises, what this build found and fixed, and what remains.

## What Covenant promises holders

1. The issuer's principal cannot leave the pool before it vests.
2. After any curator action, at least S of the vault's quote sits as bids within B ticks below the price.
3. Nothing restructures faster than M of the vault per epoch, and a curator change takes a timelock.

## Trust model

| Party | Can | Cannot |
|---|---|---|
| Issuer | propose a curator (timelocked), transfer the issuer role (two-step), withdraw vested principal to the fixed treasury | change terms, withdraw early, reshape |
| Curator | reshape within the rules | withdraw, swap vault assets, bid above the Anchor ceiling, exceed Pace, break Support |
| Anyone | adopt, restore (when Support has lapsed), deposit, withdraw own shares, poke, collect fees to the treasury, fund the bounty | everything else |
| Uniswap contracts | PoolManager, PositionManager, LBPStrategy and CCA are trusted | — |

There is no admin, owner, pause or upgrade path. Terms are immutable from vault creation. The vault implementation and `VaultOps` are immutables of each clone's implementation.

## Attack catalogue

Every row is a passing test. `13.2.x` rows are the spec's catalogue; the rest were found while building this version.

| Attack | Stopped by | Test |
|---|---|---|
| Curator withdraws principal | no code path: curator holds no shares and is not the issuer | `test_13_2_01_curatorCannotWithdrawPrincipal` |
| Curator skims (re-adds less) | unplaced principal may not even sit idle (`IdleTooLarge`) | `test_13_2_02_curatorCannotSkim` |
| Soft rug (support moved away) | Support on the resulting layout | `test_13_2_03_softRugIsRejected` |
| Spot manipulation then reshape, deposit or restore | Guard on all three | `test_13_2_04_manipulatedSpotBlocksEveryStateChange` |
| Flash round trip to bend the TWAP | same-block writes add no weight | `test_13_2_05_flashRoundTripHasNoEffect` |
| Restructure the vault in one block | Pace | `test_13_2_06_wholeVaultInOneBlockExceedsPace` |
| Swap in a malicious curator instantly | timelock; same rules after | `test_13_2_07_curatorSwapIsTimelockedAndBound` |
| Fragment into many ranges | 14-range cap on reshape | `test_13_2_08_fragmentationIsCapped` |
| Farm the restore bounty | `NothingToRestore` when healthy | `test_13_2_09_restoreBountyCannotBeFarmed` |
| Manipulate, then mint cheap shares | Guard, and in-kind shares have no price | `test_13_2_10_noCheapShares` |
| LP exit damages holders | proportional exit leaves the shape unchanged | `test_13_2_11_lpExitLeavesHoldersWhole` |
| Big dump drains the support | absorbed inside the pool, nothing leaves | `test_13_2_12_dumpIsAbsorbedNotLeaked` |
| Issuer exits early | vesting | `test_13_2_13_issuerCannotExitEarly` |
| Outsider removes vault liquidity | positions keyed to the vault | `test_13_2_14_outsiderCannotTouchVaultPositions` |
| **Pump-ratchet**, quick | Support band includes filled asks, so nothing lapses | `test_pumpRatchet_quickPumpFindsNothingToRestore` |
| **Pump-ratchet**, held four days with the Anchor synced | restore capped at the vault's own price span | `test_pumpRatchet_patientPumpCannotPullRestoreAboveWhereTheVaultSold` |
| Colluding curator bids behind a pump | bid ceiling at Anchor + G | `test_new_colludingCuratorIsHeldToTheAnchor` |
| Freeze withdrawals by holding spot away | exits are not Guarded | `test_new_exitsCannotBeFrozen` |
| Restore dust to farm the bounty | bounty capped at 1% of quote moved | `test_new_dustRestorePaysDust` |
| Deposit paid from the vault's own ETH | `InsufficientPayment` | `test_new_depositCannotBeFundedByTheVault` |
| Restore moves asks down to a dumped price | tokens keep their prices or move up | `test_restore_neverSellsTokensCheaper` |
| Shorten the TWAP by swapping every block | bucketed ring | `test_swapEveryBlockCannotShortenTheWindow` |
| Call `VaultOps` directly | `NotDelegated` | `test_ops_cannotBeCalledDirectly` |
| Initialize a vault or the implementation | `NotFactory` / `AlreadyInitialized` | `test_factory_onlyTheFactoryInitializesAndOnlyOnce` |
| Squat an issuer's vault address | addresses keyed by creator | `test_factory_vaultAddressIsKnownBeforeTheAuction` |
| Send stray ETH to break accounting | `receive` accepts only the PoolManager and PositionManager | `test_strayEthIsRefused` |
| Join after fees accrued to share in them | the deposit's own touch credits earlier fees to earlier shares | `test_fees_aNewcomerEarnsNothingFromBeforeTheyJoined` |
| Lose fees by exiting | the exit accrues on the full balance before burning | `test_fees_anExitKeepsWhatItsSharesEarned` |

The invariant suite (`test/invariant`) holds under random trading, including pushes through empty ticks, plus time jumps, curator reshapes, keeper restores, LP entries and exits, and principal withdrawals:

- solvency;
- the books match the PoolManager;
- shares add up;
- principal never exceeds what has vested;
- reshape and restore conserve principal to within 1,000 wei;
- Support holds after every reshape;
- a deposit and withdrawal round trip never profits;
- everything claimable as fees is backed by fees the vault holds.

## Findings from this build

**1. Pump-ratchet drain (critical in the prototype).** Restore was permissionless and anchored to the TWAP. Above the last ask the pool has no liquidity, so price moves there for free. Buying the asks, pushing the price up, waiting one window and calling restore moved the vault's quote under the fake price, where the attacker sold into it. Against the unmodified prototype: **−82% of principal quote, attacker +81.68 ETH** (`make poc`). Fixed by the Anchor, the bid ceiling and the restore span cap.

**2. TWAP window collapse (high in the prototype).** A 32-slot ring with one observation per swap block could be emptied in 32 blocks, falling back to "average what we have". Fixed by the bucketed ring and the slew-limited tick.

**3. Restore could sell tokens cheaply (medium).** The prototype re-added a restored range's tokens just above the TWAP, wherever they had been. After a manipulated drop that sold the vault's asks at the low price. Fixed: tokens keep their top and move their bottom only up to the price.

**4. Fragile conservation (medium, liveness).** Absolute-liquidity reshapes reverted if anyone traded first. Fixed by shares, sinks and on-chain sizing.

**5. Pace bypasses (medium).** Fixed epochs allowed 2M in two blocks. An amount-based cap grew with deposits. Fixed by a refilling, fraction-based allowance.

**6. Withdrawal freeze (medium, liveness).** A Guarded exit could be blocked by anyone holding spot away from the TWAP. Exits are now unguarded.

**7. Smaller.** Bounty farming 1 bps at a time. A depositor's native ETH shortfall paid from the vault's balance. Single-NFT adoption, where the launcher can mint up to 11. Absolute idle dust of 1e9 wei, which is 1,000 USDC at 6 decimals. `configure()` callable by anyone after migration. All fixed and tested.

**8. Seed plans for non-Standard terms (low, liveness).** `SeedPlanner.plan` placed the asks up to `coreHigh + 2·B` without rounding to the tick spacing. For bands that are not a multiple of the spacing, which includes the spec's Conservative and Aggressive presets, the plan reverted with `InvalidLeg`. Found while wiring the web app to the contracts. Fixed by aligning the bound up; `SeedPlannerTest` seeds every preset and an odd band. In the same pass, `CovenantLens.snapshot` now reads a vault before its launch migrates, with no prices yet, instead of reverting.

## Residual risks and limits

- **A colluding curator plus an uncorrected multi-day pump.** The Anchor climbs at most B per epoch, so a curator working with someone who holds a pumped price through empty ticks for k epochs can bid up to about k·B above the last real trade, on Pace-limited volume. Any single trade selling dust resets an empty-tick pump for free, and Restore cannot follow (span cap). Future work: let the ceiling rise only with liquidity at the price, or only up to prices where the vault has actually sold.
- **The Anchor needs syncing.** Allowance accrues for at most W seconds between syncs. Every vault action and the permissionless `poke()` sync it; without them it climbs more slowly than B per epoch. That is the conservative direction.
- **Sparse trading.** A window that starts inside a burst of writes starts up to 60 seconds early. Otherwise the average is exact. A very quiet pool has a slow TWAP, which blocks actions rather than allowing them.
- **Support is measured on the vault's own liquidity**, not the whole pool.
- **Adoption before outside LPs.** `adopt` is permissionless and must take every launcher NFT before the first deposit; deposits wait out the one-epoch setup period.
- **Fees and JIT liquidity.** A depositor who joins just before a large swap earns a share of that swap's fees once they are realized. That is ordinary LP economics, since they supplied a proportional slice of every range during the swap. They earn nothing realized before they joined.
- **Unsupported:** fee-on-transfer or rebasing tokens, dynamic-fee pools, more than one quote asset, the spec's hookless "recipient mode".
- **Uniswap dependencies** are pinned to sources checked file by file against the Base Sepolia deployments (LBPStrategy v3.3.0, CCA factory v2.1.0), and exercised against them by the fork test.
