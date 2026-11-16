# Covenant architecture

How the contracts fit together, what each rule computes, and why it is built that way. The product rules are in [`SPEC.md`](SPEC.md); the threat model is in [`SECURITY.md`](SECURITY.md).

## Contracts

| Contract | Deployed | State | Trust |
|---|---|---|---|
| `CovenantHook` | once per chain, at a CREATE2 address mined for `BEFORE_INITIALIZE · AFTER_INITIALIZE · AFTER_SWAP` | one TWAP oracle per pool | no owner, no funds |
| `CovenantFactory` | once per chain | `isVault` | no owner; deploys the vault implementation in its constructor |
| `CovenantVault` | one clone per launch | everything a launch owns | issuer, curator and treasury addresses fixed per vault |
| `VaultOps` | once per chain | none of its own | runs only by DELEGATECALL from a vault |
| `CovenantLogic` | once per chain (linked library) | none | pure functions over a vault's storage |
| `SeedPlanner` | once per chain | none | view only |

The hook inherits Uniswap's `InitializerHook` without changes. `LBPStrategy` accepts it as a launch's pool hook for three reasons: it passes `ERC165` for `IInitializerHook`, its `authorized()` returns the strategy, and its address carries the `beforeInitialize` flag. The extra two flags are allowed. Because `InitializerHook._beforeInitialize` is `view`, the oracle is seeded in `afterInitialize`.

## One launch, start to finish

1. **Stage 0.** The issuer calls `factory.createVault(key, config, salt)`. The factory checks the pool key (Covenant hook, static fee, sorted currencies, valid spacing) and every term (`TermsLib`), then clones the implementation at `predictVault(creator, salt)` and initializes it. The vault exists before the auction, and its address goes into the launch as `positionRecipient`.
2. **Auction.** The CCA runs as normal. Every bid's demand stays recorded at its price level, including bids that are later outbid.
3. **Migration.** Anyone calls `LBPStrategy.migrate`. The strategy initializes the pool at the clearing price (the hook's `beforeInitialize` checks the caller; `afterInitialize` starts the oracle) and mints the LP NFT or NFTs to the vault.
4. **Adoption.** Anyone calls `vault.adopt(ids)`. One PositionManager call burns every NFT and pays the vault. The vault splits what it received into principal (exactly what `RangeMath.amounts` says removal pays) and accrued fees. Inside one PoolManager unlock it re-adds the same ranges as positions it owns directly. The first adoption mints 1e18 principal shares to the issuer, starts the setup epoch and sets the Anchor at the opening price.
5. **Seed.** The curator submits the first reshape, typically `SeedPlanner.plan(vault, auction, params)`. Pace does not apply during the setup epoch.
6. **Managed life.** Reshapes, restores, LP deposits and exits, fee collection, curator changes.
7. **Release.** After `lockDuration`, principal shares vest linearly over `vestDuration` and the issuer withdraws them in kind to the treasury.

## Storage and the vault split

`CovenantVault` and `VaultOps` both inherit `VaultStorage` and declare no storage of their own. When the PoolManager calls `vault.unlockCallback`, the vault delegatecalls `VaultOps.execute(data)`, which runs on the vault's storage. `VaultOps` checks `address(this) != self`, so a direct call reverts. The split keeps the vault at 21.1 KB, under the 24,576-byte limit. Custody never leaves one address.

The PoolManager only calls back the contract that unlocked it, so `unlockCallback` runs only inside the vault's own calls. Payouts to users happen after the unlock returns, so no outside code runs while the PoolManager is unlocked on the vault's behalf.

## Price ticks

Rule code never branches on pool orientation. `Orient` maps pool ticks to **price ticks**, which rise with the token's price in the quote: `price = -poolTick` when the quote is currency0 and `price = poolTick` otherwise. In price ticks, with the price at `p`, a range `[lo, hi]`:

- holds only quote when `p ≥ hi` (a bid below the price);
- holds only tokens when `p ≤ lo` (an ask above the price);
- holds both in between.

v4 decides which currencies a range needs by comparing ticks, not prices. So "strictly under the price" is `spot − 1` when the quote is currency0 and `spot` when it is currency1. `CovenantLogic.restoreTargets` encodes that asymmetry, and the orientation suite runs every sensitive rule in all three configurations: native ETH, ERC20 as currency0, ERC20 as currency1.

## The oracle

`TwapOracle` records a **slew-limited** tick. After each write the recorded tick walks toward the latest spot tick by at most `rate` ticks per second, one whole second at a time. Second `s` after a write contributes `tick + sign · min(rate·s, d)`, where `d = |target − tick|`. Summed over `dt` seconds that is `dt·tick + sign·(rate·m(m+1)/2 + d·max(0, dt−1−n))`, with `n = d / rate` and `m = min(dt−1, n)`. That closed form is exact. Fuzzing checks it against stepping second by second.

Storage is a ring of 128 slots, each one word holding the first and latest write of a ≤60-second bucket. Slots start at least 60 seconds apart, so the ring always covers at least 127 minutes. `MAX_WINDOW` is 2 hours. Between a slot's latest write and the next slot's first write nothing changed, so the cumulative at any moment in that gap is exact. A window that starts inside a slot's burst of writes starts at that slot's first write: up to 60 seconds early, never late.

Consequences:

- writes in the same block only replace the target, so a same-block round trip leaves no trace;
- a spike held for `h` seconds moves the recorded tick by at most `rate · h`;
- the window can never be shortened by trading frequency.

## The rules

All prices below are price ticks. `T` is the TWAP, `A` the Anchor, `spot` the pool's tick.

**Guard.** `|spot − T| ≤ G` for reshape, restore and deposit. Exits (`withdraw`, `withdrawPrincipal`) are not guarded: a proportional burn is price-independent, and a guard on it would only give someone who can move spot through empty ticks a free way to freeze withdrawals.

**Anchor** (`CovenantLogic.anchorAt`). It is synced by reshape, restore, deposit and the permissionless `poke()`.

- If `T > A`, the Anchor climbs by `B · credited / E`, where `credited = min(seconds since the last sync, W)`. Allowance therefore cannot be banked across a quiet period. The fraction of a tick not yet earned carries over through the sync timestamp.
- If `T < A − G`, the Anchor drops to `T + G` at once.

The Anchor starts at the opening (clearing) price.

**Support** (`CovenantLogic.supportBps`). The band is `[min(A, T) − B, T]`. Support is the vault's quote inside the band divided by all the vault's quote, both valued at `T`. Idle quote counts in the total but never in the band. During a rally faster than the Anchor, the band widens down to the Anchor's band, so asks filled on the way up count as support.

**Bid ceiling.** Any leg a reshape places that holds quote must keep its quote at or below `A + G`. The quote of a range sits at or below `min(top, spot)`.

**Pace** (`PaceLib`). The allowance is a fraction of vault value in units of 1e9. It holds at most M and refills at M per E. A reshape spends the value of its cuts at `T` divided by total value at `T`, rounded up. The setup epoch is exempt. No single block can move more than M; any window of one epoch can move at most 2M (a full allowance plus one epoch of refill).

**Ranges.** At most 16. A reshape must leave at most 14, so restore always has room. A restore adds at most one range net.

## Reshape

`reshape(cuts, legs, deadline)` runs in this order:

1. Curator only; deadline.
2. Read prices once: spot, `T`, Anchor. Guard. Commit the Anchor.
3. `cutFraction` validates the cuts (indices strictly increasing, nonzero) and prices them; spend Pace. `validateLegs` checks alignment and bounds, that shares sum to at most 100% per currency, and that there is at most one sink per currency.
4. Unlock. In `VaultOps`:
   - remove each cut; principal becomes available, fees go to the pot;
   - add the idle balance to what is available;
   - place each non-sink leg from `share × available − 1 wei`, at the spot price, enforcing the bid ceiling;
   - place each sink with the remainder of its currency (a sink must be one-sided at spot);
   - require that what is left is under the idle cap (0.1% of what was handled, floor 1,000 wei);
   - settle the net with the PoolManager; compact empty ranges.
5. Range cap; Support ≥ S.

Sizing from one wei less than available guarantees the rounded-up cost of the rounded-down liquidity never exceeds what was freed. Legs at the same bounds as an existing range merge into it, since the PoolManager keys positions by owner, bounds and salt.

## Restore

`restore(indices, deadline)` is permissionless:

1. Guard; commit the Anchor; require `Support < S`.
2. Compute the targets.
   - **Band:** from `ceil(min(A, T) − B)` up to `floor(min(bidTop(spot), T, A + G, vaultTop))`, where `vaultTop` is the highest price any of the vault's ranges reaches. If that is empty, revert `RestoreBandEmpty`.
   - **Ask floor:** the first aligned tick above spot.
3. In the unlock, empty each listed range. Its quote waits for the band. Its tokens go back over `[max(lower, askFloor), upper]`: same top, bottom raised to the price, never lower. A range with no quote reverts.
4. Place all the freed quote plus the idle quote in the band.
5. Require `Support ≥ S` afterwards; pay `min(bounty, bountyPool, 1% of quote moved)`.

## In-kind shares

A deposit of `x` shares adds `ceil(L · x / totalShares)` to every range, plus the same fraction of idle, and charges exactly what that costs. A withdrawal removes `floor(L · x / totalShares)` of every range plus the same fraction of idle. The rounding always favours the shares that stay, so a deposit followed by a withdrawal never returns more than it cost (an invariant). Because shares are a slice of every range rather than a priced unit, there is nothing to manipulate. Support is a ratio over the layout, which a proportional change leaves exactly as it was.

## Fees

Every `modifyLiquidity` returns fees separately from principal. `VaultOps` books them the moment they are realized: the curator in office gets `curatorFeeBps` of them, and the rest goes onto two per-share accumulators (`feeGrowth0/1`, Q128), divided by the shares outstanding at that moment. Each account, including the issuer's principal as `PRINCIPAL_ACCOUNT`, accrues lazily: `owed += balance × (growth − checkpoint) / 2^128`. All fee balances sit in `feePot0/1`, so solvency is still "balance ≥ idle + fee pot + bounty pool".

The ordering that makes this exact: functions that change shares change them only after their unlock.

- `deposit` realizes fees on every range (they belong to existing shares), accrues the depositor's previous balance, then mints.
- `withdraw` and `withdrawPrincipal` realize fees, accrue the leaver on their full balance (their shares earned what this touch realized), then burn.

Payouts:

- `claimFees()` pays an LP.
- `collectFees()` pays the principal's share. It tops the bounty pool up to three bounties from it first, then pays the treasury.
- `claimCuratorFees()` pays each curator what it earned while in office.

An invariant checks that everything claimable is backed by the pot. Rounding remainders of the per-share division stay in the pot as dust.

## Gas (from the test suite)

| | median gas |
|---|---|
| `adopt` (one launcher NFT) | 496k |
| `reshape` (seed: cut 1, place 4–5) | 687k |
| `restore` | 93k (median), up to 637k |
| `deposit` / `withdraw` (4–5 ranges) | 351k / 303k |
| `claimFees` / `collectFees` (both touch every range first) | 269k / 444k |
| `poke` | 53k |
| hook overhead per swap | 8.5k (31k when it opens a new oracle slot, first lap) |
| `SeedPlanner.outbidDemand` | ~6.7k per price level |
