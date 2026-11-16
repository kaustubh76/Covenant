# Covenant — Product Specification

**Locked for holders. Managed for the market.**
*A Uniswap v4 hook that lets launch liquidity be actively managed without ever being withdrawable.*

Version 1.0 · November 2026 · Working document for the UHI11 build
Companion files: `Covenant_UHI11_Ideation.md` (research, evidence, scorecard), `Covenant_Flow.excalidraw` (full execution flow), `covenant-tests.zip` (prototype + 27 passing tests)

---

## Table of contents

1. Summary
2. The problem
3. Who it is for
4. The product in one page
5. Roles and actors
6. Lifecycle, stage by stage
7. The covenant: rules and parameters
8. Capital flows and accounting
9. Measurement: TWAP, support, pace, value
10. Curators: human, automated, and changing them
11. Outside LPs
12. Fees, bounties and treasury
13. Security model and attack catalogue
14. Integration with Uniswap's launch stack
15. Operating modes
16. Interfaces (behavioural, not code)
17. Parameter guide and presets
18. Demo script
19. Open questions and future work
20. Glossary

---

## 1. Summary

When a token launches, its liquidity can be **locked** (so holders know it cannot be pulled) or **managed** (so the market gets real depth near the price). Today it cannot be both, because a lock freezes the position and a manager who can move it can also remove it.

Covenant is a Uniswap v4 hook and vault that holds launch liquidity under three rules fixed before the auction and shown to bidders. A named curator can reshape the liquidity freely within those rules. Nobody, including the team and the curator, can take the principal out before the unlock date, and nobody can move the promised buy support away from the price. If price drift breaks the support rule, anyone can restore it and earn a bounty. Outside LPs can deposit into the same vault, in kind, and follow the curator.

Covenant plugs into Uniswap's own launch stack: a Continuous Clearing Auction (CCA) migrates its proceeds through the stock Liquidity Launcher strategy into a pool where Covenant is both the hook and the position owner. No fork of Uniswap's contracts is needed. The whole chain has been run end to end in Foundry against Uniswap's real contracts, with 27 passing tests including an attack suite.

---

## 2. The problem

### 2.1 The conflict

| What the team wants to prove | What the market needs |
|---|---|
| "We cannot pull the liquidity" | Depth near the current price |
| A lock the bidders can verify before bidding | Re-centering when price moves |
| No manager with withdrawal rights | A manager, or an automated strategy, with the right to move ranges |

Locks are all-or-nothing. A locked position cannot move, so it cannot be managed. A position that can move can also be pulled, or quietly "soft-rugged": the manager leaves it technically in the pool but moves all buy support far below the price, so holders have nothing to sell into.

### 2.2 Where it bites: Uniswap's own launch path

Uniswap's Continuous Clearing Auction is the flagship token-launch product on v4. At the end of an auction, the proceeds and a reserve of tokens seed a v4 pool at the clearing price. By default that seed is one full-range position, which spreads capital from zero to infinity; only a small fraction sits near the trading price. The latest Liquidity Launcher can also seed weighted concentrated positions, but they are static: once locked they cannot move, and when price moves away they fall out of range and offer no depth at all.

Teams then choose between:

- **Locking** through Uniswap's TimelockedPositionRecipient or a third-party locker. Holders get safety; the market gets thin or stale liquidity.
- **Handing it to a manager** such as Arrakis Pro. The market gets depth; holders get no guarantee, since by the manager's own documentation the team can pause, reconfigure or withdraw at any time.

### 2.3 The case that proves it

Aztec ran the largest CCA to date: $59M raised from 17,000 bidders. The post-auction pool was locked in an immutable contract for at least 90 days and was the third-largest pool on Uniswap v4. In the first 24 hours the token fell more than 20% from its early highs, and for the whole lock period the liquidity could not be re-centered or concentrated. The team chose correctly for holders and got the wrong outcome for the market.

### 2.4 Why nobody has fixed it

Every existing tool handles either the lock or the management:

| Tool | Handles | Cannot |
|---|---|---|
| Full-range or weighted static seed | Launch-day liquidity | Move afterwards |
| Timelocked recipient, NFT lockers | Proving commitment | Let the position move |
| Uniswap's post-launch periphery (compounding, buyback-and-burn, fee splitters) | Fees | Touch the principal position |
| Professional managers (Arrakis Pro and similar) | Active management | Guarantee anything to holders |
| Fee-funded "bid walls" | Placing fee income as support | Govern the launch principal under a curator |

Covenant is the missing middle: a lock that allows management.

---

## 3. Who it is for

**Primary: token issuers launching through a CCA** (foundations, DAOs, protocol teams). They want to tell bidders "the liquidity cannot be pulled" and still have a professional run it.

**Second: curators.** Professional liquidity managers and automated strategies. Covenant gives them a way to be hired for post-launch management with a built-in "cannot rug" proof, which is a selling point to issuers who currently hesitate to hand over control.

**Third: bidders and holders.** They read the covenant before bidding and know three things for certain: the principal cannot leave before the unlock date, a minimum share of the quote asset will always sit as buy support near the price, and nothing changes faster than they can see.

**Fourth: outside LPs.** Anyone who wants to earn fees under a professional curator, inside a vault whose rules they can read, with in-kind entry and exit.

**Who it is not for (v1):** tokens not launched into a v4 pool; pools that are already locked (Covenant cannot be retrofitted onto a live timelock); launches that want multiple quote assets.

---

## 4. The product in one page

```
          BEFORE AUCTION                AUCTION               MIGRATION
   ┌─────────────────────┐      ┌─────────────────┐     ┌──────────────────────┐
   │ Issuer sets covenant│      │ Bidders see the │     │ Launcher seeds pool  │
   │ terms + curator.    │ ───► │ rules, bid.     │ ──► │ with Covenant as hook│
   │ Disclosed to bidders│      │ Demand curve is │     │ + position owner.    │
   └─────────────────────┘      │ recorded onchain│     │ Covenant adopts LP.  │
                                └─────────────────┘     └──────────┬───────────┘
                                                                   │
                     ┌─────────────────────────────────────────────▼─────────────┐
                     │                     SEED (first reshape)                  │
                     │  Quote placed where outbid buyers were; S% as support     │
                     │  just above price; tokens as asks just below price.       │
                     └─────────────────────────────────────────────┬─────────────┘
                                                                   │
            ┌──────────────────────────────────────────────────────▼──────────────────────┐
            │                           MANAGED, LOCKED LIFE                              │
            │                                                                             │
            │   RESHAPE (curator) ──► ENFORCE (hook checks) ──► accepted or reverted      │
            │        ▲                      │                                             │
            │        │                      ├── Conservation: nothing leaves the pool     │
            │   price moves,                ├── Support: ≥ S% of quote within B of TWAP   │
            │   signals, listings           ├── Pace: ≤ M% of value per epoch            │
            │                               └── Guard: spot within G of TWAP             │
            │                                                                             │
            │   RESTORE (anyone) ── if drift broke Support ── fixed reshape + bounty       │
            │   OUTSIDE LPs ──── deposit / withdraw in kind, follow the curator           │
            │   CURATOR CHANGE ── proposed by issuer, timelocked, rules unchanged         │
            └──────────────────────────────────────────────────────┬──────────────────────┘
                                                                   │
                                                 ┌─────────────────▼──────────────────┐
                                                 │ RELEASE: issuer principal vests    │
                                                 │ linearly from the unlock date.     │
                                                 │ Outside LPs were never locked.     │
                                                 └────────────────────────────────────┘
```

Four verbs describe the whole product: **Seed, Reshape, Enforce, Release.**

---

## 5. Roles and actors

| Actor | What they do | What they cannot do |
|---|---|---|
| **Issuer** | Chooses covenant terms and the first curator before the auction. Receives trading fees to the treasury. Proposes curator changes. Withdraws principal only on the vesting schedule. | Change the terms after the auction. Withdraw early. Reshape liquidity. |
| **Curator** | Reshapes the vault's liquidity: concentrates, re-centers, widens, converges to a listing price. May be a person, a firm, or an automated on-chain strategy. | Withdraw, swap or trade against vault assets. Break Support, Pace or the Guard. Exceed the range cap. |
| **Covenant (hook + vault)** | Owns every position. Checks every action against the rules. Keeps its own TWAP. Pays bounties. Tracks shares. | Nothing outside its rules; it has no privileged admin. |
| **Keeper (anyone)** | Calls `restore` when price drift has broken Support. Earns a bounty. | Call restore when Support is healthy. |
| **Outside LP** | Deposits in kind, earns fees under the curator, withdraws in kind at any time while the Guard passes. | Affect the issuer's locked principal or the holders' guarantee. |
| **Bidders / holders** | Read the covenant before bidding. Verify it on-chain afterwards. | — |
| **Uniswap contracts** | CCA records demand and clears. Liquidity Launcher migrates proceeds and mints the LP to Covenant. PoolManager executes swaps and liquidity changes. | — |

---

## 6. Lifecycle, stage by stage

### Stage 0 — Pre-auction: commit the covenant

The issuer configures the launch through Uniswap's Liquidity Launcher with two Covenant-specific settings: the **pool hook** is the Covenant contract for that chain, and the **position recipient** is the same Covenant contract. In the Covenant contract the issuer registers the mandate: the pool, the covenant terms (Section 7), the issuer's treasury address and the first curator.

The terms are published next to the auction. Bidders can read: "40% of the quote will always sit as buy support within 15% below the price; nothing can be withdrawn for 90 days, then it vests over 30 days; the curator can move at most 50% of the vault per day; curator changes take 2 days."

Nothing in Stage 0 can be changed later. This is the whole point: the promise is made before the money arrives.

### Stage 1 — Auction: demand is recorded

The CCA runs as normal. Every bid is stored at its maximum price level. Bids that are outbid are removed from the running total above the clearing price, but their amount at their own price level stays on-chain. When the auction ends, the full demand curve is readable, including the buyers who lost. This is the raw material for the Seed.

### Stage 2 — Migration: Covenant takes ownership

At the migration block, anyone calls `migrate` on the Launcher. The stock strategy initialises the pool at the clearing price with Covenant as the hook, mints the LP position (full range or the Launcher's weighted shape) and sends the position NFT to Covenant.

Covenant then **adopts** the NFT: it pulls the liquidity out of the PositionManager, re-adds it as a position the vault owns directly in the PoolManager, and mints the issuer's principal shares. From this moment there is no code path in the system that can withdraw that principal before the unlock schedule.

### Stage 3 — Seed: the first reshape, shaped by demand

The curator (or the default strategy) performs the first reshape using the auction's demand curve:

- **Support band:** at least S% of the quote asset is placed as buy liquidity just above the current tick (the "cheaper token" side), covering the band from the price down to B% below it.
- **Demand-shaped support:** the remaining quote is placed where outbid buyers actually were, in proportion to their recorded demand. Support sits where real buyers were waiting.
- **Asks:** the reserve tokens are placed just below the current tick (the "more expensive token" side), so sellers into the pool get the issuer's tokens at rising prices, and buyers are served from the reserve.

The first epoch after adoption is a **setup epoch**: the Pace rule is not enforced, because the first concentration necessarily moves the whole vault. All other rules apply.

### Stage 4 — Managed, locked life

This is where the product lives. Three loops run in parallel:

**Reshape loop (curator).** On a signal — volatility settling, a trend, a CEX listing, an oracle trigger — the curator submits a reshape: a list of ranges to remove and a list of ranges to add. The hook runs the whole thing inside one PoolManager unlock and checks:

1. **Guard:** spot tick within G of the hook's TWAP, else revert.
2. **Pace:** value being moved (at TWAP) plus value already moved this epoch ≤ M% of vault value, else revert.
3. **Conservation:** net principal movement for both tokens within rounding dust, else revert. Fees accrued are separated and credited to the fee pot.
4. **Support:** after the change, quote within the support band ≥ S% of all quote (valued at TWAP), else revert.
5. **Range cap:** total ranges ≤ 16, else revert.

If any check fails, nothing changes. If all pass, the new layout is live.

**Restore loop (anyone).** Price moves without anyone acting. If the token's price rises past the ask range, the quote that was support is now far above the price and the support share drops below S%. Any address can call `restore` on a range: the hook performs a fixed reshape that moves that range's quote into the support band and its tokens just below the price, checks that Support improved, and pays the caller a bounty from the bounty pool. If Support is healthy, restore reverts and pays nothing.

**Capital loop (outside LPs).** Depositors mint shares by adding liquidity to every vault range in proportion. Withdrawals remove the same proportion. Both are blocked when the Guard fails. Both leave the issuer's principal, the holders' guarantee and the fee pot untouched.

**Governance (issuer).** The issuer may propose a new curator; the change takes effect only after the curator timelock. The new curator inherits exactly the same rules. The issuer may collect fees from the treasury pot at any time; the bounty pool is topped up first.

### Stage 5 — Release

From the unlock date, the issuer's principal shares vest linearly over the unlock duration. The issuer can withdraw vested shares in kind at any time the Guard passes. Outside LPs were never locked. A covenant can also be configured to extend or to be permanent.

---

## 7. The covenant: rules and parameters

Three rules, fixed at Stage 0 and never changeable.

### Rule 1 — Conservation: "Reshape, never trade"

Until the unlock date, the issuer's principal never leaves the pool. A reshape may move value between price ranges but may not withdraw it, swap it, or trade against it. Mechanically: the net principal movement of a reshape, for each of the two tokens, must be within rounding dust. Fees are not principal; they are measured separately by the PoolManager and credited to the fee pot.

Why it works: the vault owns the positions, there is no withdrawal function before vesting, and every reshape is a remove-plus-adds inside one unlock whose net balance must come back to zero.

### Rule 2 — Support: the anti-soft-rug rule

After any curator action, at least **S%** of the vault's quote asset (valued at the TWAP price) must sit as buy liquidity within **B** ticks on the cheaper-token side of the TWAP tick. A curator cannot move the buy wall away from the price, no matter how far the price has moved.

Why it works: the check is on the layout, not on intent. Price manipulation does not help, because the band is anchored to the TWAP, not spot, and every state change is blocked while spot is far from the TWAP.

### Rule 3 — Pace: no surprises

In any epoch of length **E**, the curator may move at most **M%** of the vault's value (at TWAP). Curator changes take effect only after a timelock **T**. The first epoch after adoption is exempt from Pace (setup epoch).

Why it works: holders can always see a large change coming. A malicious curator cannot restructure the entire vault in one block, and a replaced curator cannot act instantly.

### Guard (applies to every state change)

Reshape, restore, deposit and withdraw all require |spot tick − TWAP tick| ≤ **G**. A flash manipulation cannot create a window to act; a persistent move is accepted once the TWAP has caught up.

### Parameters

| Parameter | Meaning | Example |
|---|---|---|
| S (`supportBps`) | Minimum share of quote in the support band | 40% |
| B (`supportBandTicks`) | Width of the support band from the TWAP tick | 1500 ticks (~15%) |
| M (`paceBps`) | Max share of vault value moved per epoch | 50% |
| E (`epochLen`) | Epoch length | 1 day |
| G (`guardTicks`) | Max spot/TWAP divergence for any action | 300 ticks (~3%) |
| W (`twapWindow`) | TWAP averaging window | 30 minutes |
| `unlockStart` | When principal starts vesting | launch + 90 days |
| `unlockDuration` | Linear vesting length | 30 days |
| T (`curatorTimelock`) | Delay before a curator change applies | 2 days |
| `bounty` | Paid per successful restore | 0.01 ETH |
| `MAX_RANGES` | Cap on simultaneous ranges | 16 |

---

## 8. Capital flows and accounting

### 8.1 What the vault holds

- **Positions:** a list of ranges (lower tick, upper tick, liquidity) owned directly by the vault in the PoolManager. At most 16.
- **Idle dust:** rounding residue from reshapes, bounded per operation.
- **Fee pot:** accrued trading fees in both tokens, kept separate from principal.
- **Bounty pool:** quote asset reserved to pay restorers, funded from fees (and optionally seeded by the issuer).

### 8.2 Shares

One share class. The issuer receives principal shares at adoption. Outside LPs receive shares when they deposit. Every share represents the same fraction of every range in the vault. There is no dollar pricing of shares: deposits and withdrawals are in kind and proportional, so the vault never needs an oracle to value itself and cannot be exploited through share-price manipulation (the failure mode behind several ALM exploits).

### 8.3 Who can move what

| Asset | Curator | Issuer | Outside LP | Keeper |
|---|---|---|---|---|
| Principal positions | Reshape within rules | Withdraw vested shares only | Withdraw own shares | Restore within rules |
| Fee pot | — | Collect to treasury | — | — |
| Bounty pool | — | Fund | — | Earn per restore |
| Terms | — | — | — | — |

### 8.4 Reshape mechanics (behavioural)

1. Curator submits: remove ranges [i, j, …], add ranges [(lo, hi, L), …].
2. Hook checks Guard, then Pace (value of removed ranges at TWAP).
3. Inside one PoolManager unlock: remove each listed range (the PoolManager returns principal and fees separately), add each new range, and compute the net principal delta per token.
4. If the net principal delta exceeds dust in either direction, revert everything.
5. Credit fees to the fee pot, settle the net, compact the range list, enforce the range cap.
6. Check Support on the resulting layout. If it fails, revert everything.

A reshape is atomic: the vault is never observed in a half-moved state.

---

## 9. Measurement

### 9.1 TWAP

The hook records the pool tick after every swap and accumulates tick-seconds over time. The TWAP over window W is computed from this record. Because the current block's spot price only enters through elapsed time, a swap and a state change in the same block see the pre-swap TWAP. A flash move has no effect; a persistent move is reflected after roughly W.

### 9.2 Support

Support share = (quote within the band [TWAP tick, TWAP tick + B], valued at TWAP) ÷ (all quote across all ranges, valued at TWAP). Using the TWAP price for both numerator and denominator makes the measure stable against momentary spot moves.

An important finding from testing: when the token's price rises, the asks that were filled become quote sitting just above the new price, which counts as support automatically. Support therefore lapses less often than intuition suggests, and mainly when the price moves beyond the entire ask range. That is exactly when a restore is needed.

### 9.3 Pace

Value of a range at TWAP = quote amount + token amount converted at the TWAP price. Pace compares the value of ranges being removed this epoch against total vault value.

### 9.4 Dust

Each reshape may leave at most a fixed dust amount per token (on the order of 1e9 wei) idle in the vault. Over hundreds of reshapes this remains negligible.

---

## 10. Curators

### 10.1 Professional curators

A market-making firm or liquidity manager registers an address as curator. They run their models off-chain and submit reshapes on-chain. Typical playbook:

- **Launch day:** demand-shaped Seed; wide support.
- **After volatility settles:** concentrate around the discovered price.
- **Trend:** re-center while keeping S% in band.
- **CEX listing:** converge the pool to the listing price so on-chain depth is not arbitraged away.
- **Stress:** widen ranges; support stays by rule.

Their pitch to issuers changes from "trust us" to "we cannot rug you, and here is the covenant that proves it."

### 10.2 Automated curators

A default on-chain strategy for teams without a manager: re-center on TWAP triggers (for example when the TWAP has moved more than X% from the center of the current layout), keep a fixed support width, respect Pace automatically. Any address can trigger it when its condition is met.

### 10.3 Changing curators

The issuer proposes a new curator. After the timelock, anyone can finalise the change. The new curator is bound by the same covenant. The liquidity never moves during the change: this is **strategy migration without unlocking**.

### 10.4 Curator record

Every reshape, restore and curator change is an on-chain event. Across launches, a curator accumulates a public record: support maintained, restores needed against them, pace used. Issuers can gate their launch to curators with a record, and outside LPs can choose which curators to follow.

---

## 11. Outside LPs

- **Entry:** a depositor specifies how many shares to mint. The vault adds the proportional liquidity to every range and pulls exactly the required amounts of both tokens; excess quote is refunded. Cost is exactly proportional to the vault's current holdings.
- **Exit:** a withdrawer burns shares; the vault removes the proportional liquidity from every range and pays both tokens out. Exits are allowed at any time the Guard passes.
- **Guarantees preserved:** proportional scaling does not change the shape of the vault, so Support is unchanged by deposits and withdrawals. The issuer's principal shares are untouched.
- **Fees:** in the prototype all fees go to the treasury pot. In the product, fees are shared pro rata with outside LPs, minus the curator's share and the bounty reserve.
- **Why it matters:** this turns managed liquidity into curated liquidity. Depositors follow a named curator inside a rule-bound vault, and a pool gets deeper as more people trust the curator.

---

## 12. Fees, bounties and treasury

- **Trading fees** accrue to the vault's positions as normal. Reshapes and scaling operations separate them from principal and credit the fee pot.
- **Bounty pool** is topped up from the fee pot before any treasury payout, to a reserve of several bounties.
- **Treasury** (issuer) collects the remainder of the fee pot on demand.
- **Curator compensation** (product, not prototype): a share of fees, paid from the fee pot, defined in the terms.
- **No performance fees on principal.** Covenant deliberately does not price or charge on vault value; it is a lock-and-manage product, not a fund.

---

## 13. Security model and attack catalogue

### 13.1 Design principles

1. **No admin.** Covenant has no owner with override powers. Terms are immutable after configuration.
2. **No clever math.** Standard v4 positions plus checks. No custom curves, no share pricing, no external oracles.
3. **Enforce the layout, not the intent.** The hook does not try to detect bad behaviour; it rejects any layout that breaks a rule.
4. **Anchor to time.** Every price-sensitive check uses the in-hook TWAP; every state change is blocked when spot diverges from it.
5. **Bound every loop.** Range cap keeps gas predictable.

### 13.2 Attack catalogue (all tested; see `covenant-tests.zip`)

| Attack | Mechanism that stops it | Test result |
|---|---|---|
| Curator withdraws principal | No withdrawal path before vesting; conservation check on every reshape | Reverts |
| Curator skims (re-adds less than removed) | Conservation: net principal delta must be within dust | Reverts |
| Soft rug (support moved far from price) | Support rule on the resulting layout | Reverts |
| Spot manipulation then reshape/deposit/restore | Guard: spot must be within G of TWAP; TWAP ignores same-block moves | Reverts |
| Flash round-trip to confuse the TWAP | Time-weighted accumulation; same-block swaps add zero weight | No effect |
| Restructure the whole vault in one block | Pace limit per epoch | Reverts |
| Replace the curator with a malicious one instantly | Timelock; new curator bound by the same rules | Blocked, then bound |
| Fragment into hundreds of ranges to grief gas | Range cap of 16 | Reverts |
| Farm the restore bounty | Restore reverts when Support is healthy and must strictly improve Support | Reverts, pays nothing |
| Manipulate then mint cheap shares | Guard plus in-kind proportional shares (no dollar pricing) | Reverts / impossible |
| Outside LP exit damages holders | Proportional scaling leaves shape and issuer shares unchanged; Support re-checked | Guarantee intact |
| Big dump drains the support | Support converts to tokens inside the pool; nothing leaves the vault | Absorbed, not leaked |
| Early issuer withdrawal | Vesting schedule | Reverts |
| Outsider removes vault liquidity via PositionManager/PoolManager | Positions are keyed to the vault as owner | Reverts |

### 13.3 Known limitations

- Covenant cannot be retrofitted onto liquidity that is already locked elsewhere.
- The TWAP is the hook's own; a pool with very little trading has a slow-moving TWAP, which is conservative (blocks actions) rather than dangerous.
- Support is measured on the vault's own liquidity, not on the whole pool.
- The prototype hook is slightly over the contract size limit; the product splits into a thin hook and a vault.

---

## 14. Integration with Uniswap's launch stack

Verified against Uniswap's Liquidity Launcher and CCA source (October 2026) and exercised end to end in tests.

| Integration point | How Covenant uses it |
|---|---|
| **LBPStrategy (stock)** | Accepts Covenant as the pool hook and as the position recipient. No fork needed. |
| **InitializerHook** | Covenant inherits it, carries the before-initialize permission, and names the chain's LBPStrategy as its authorised initialiser. One Covenant deployment per chain serves every launch. |
| **PositionManager** | The launcher mints the LP NFT to Covenant; Covenant adopts it (pulls liquidity, re-adds as a directly owned position). |
| **PoolManager** | Covenant owns its positions directly, performs reshapes inside one unlock, and reads fees separately from principal. |
| **afterSwap** | Feeds the in-hook TWAP. |
| **CCA tick storage** | After the auction, Covenant (or the curator) reads the demand at each price level, including losing bids, to shape the Seed. ~1,700 gas per level. |
| **Web app** | The self-serve CCA flow lets the team set the liquidity recipient (Covenant) but not a custom hook; see Operating modes. |

What Covenant does not need: a custom Liquidity Strategy, changes to the CCA, or any Uniswap governance action.

---

## 15. Operating modes

**Full mode (contract-level launch).** Covenant is both hook and recipient. In-hook TWAP, atomic reshapes, afterSwap observations. This is the reference build and the hackathon demo.

**Recipient mode (web-app launch).** The pool is hookless; Covenant only receives the LP. Without afterSwap there is no in-hook TWAP, so every reshape becomes two steps: commit the intended layout at the current price, then execute a few blocks later only if the price is still within the band. A manipulator would need to hold the price across several blocks. This is the adoption path for teams who launch from the Uniswap web app today.

**Permanent mode.** `unlockStart` far in the future or never: the covenant is a permanent, managed, protocol-owned liquidity position.

---

## 16. Interfaces (behavioural)

Described by what each call does, not by signatures.

| Call | Who | Effect |
|---|---|---|
| Configure mandate | Issuer (once) | Binds pool, terms, treasury and first curator. Immutable afterwards. |
| Adopt | Anyone | Converts the launcher-minted LP NFT into vault-owned positions; mints issuer principal shares; starts the setup epoch. |
| Reshape | Curator | Atomic remove/add of ranges under Guard, Pace, Conservation, Support and range cap. |
| Restore | Anyone | Fixed support-repairing reshape when Support is below S; pays bounty. |
| Deposit | Anyone | In-kind proportional entry; mints shares; Guard applies. |
| Withdraw | Shareholder | In-kind proportional exit; issuer limited to vested shares; Guard applies. |
| Propose / accept curator | Issuer / anyone after timelock | Changes the curator without touching liquidity. |
| Collect fees | Issuer | Tops up bounty pool, sends the rest to treasury. |
| Fund bounty | Anyone | Adds quote to the bounty pool. |
| Views | Anyone | Support share, TWAP tick, ranges, vault value, shares, fee pot, bounty pool. |

Events: Reshaped, Restored, Deposited, Withdrawn, CuratorProposed, CuratorChanged, FeesCollected.

---

## 17. Parameter guide and presets

| Preset | S | B | M | E | G | W | Lock | Vest | T |
|---|---|---|---|---|---|---|---|---|---|
| **Conservative** (community launches) | 50% | 2000 (~20%) | 30% | 1 day | 300 | 30 min | 180 days | 90 days | 3 days |
| **Standard** | 40% | 1500 (~15%) | 50% | 1 day | 300 | 30 min | 90 days | 30 days | 2 days |
| **Aggressive** (deep CEX co-listing) | 30% | 1000 (~10%) | 70% | 12 h | 500 | 15 min | 60 days | 30 days | 1 day |

Guidance:
- Higher S and wider B give holders more protection and the curator less freedom.
- G should be comfortably larger than normal block-to-block noise for the pair, otherwise honest actions get blocked during ordinary volatility.
- W should be long enough that a manipulator cannot hold a price for it cheaply, and short enough that honest re-centering is not delayed for hours.
- M should allow a full re-centering within one or two epochs; 50% per day is a reasonable default.

---

## 18. Demo script

Target: Unichain Sepolia, with Uniswap's CCA and Liquidity Launcher contracts deployed if no testnet deployment exists. Everything below has already been run locally in Foundry.

1. **Launch.** Run a small CCA with scripted bidders, including losing bids at two lower prices and a winning bid that sets the clearing price. Show the covenant terms displayed next to the auction.
2. **Migrate.** Call migrate; show the pool initialised at the clearing price, the LP NFT owned by Covenant, and the adoption.
3. **Seed.** Read the losing bids from the auction and perform the demand-shaped Seed. Show support share going from ~7% (full range) to ≥ 40%.
4. **Depth.** Sell the same amount of tokens into a full-range twin pool and into the Covenant pool. Show the tick move: about 8× smaller under Covenant.
5. **Three rug attempts.** Curator tries to withdraw (reverts), to re-add only 90% (reverts), to move support far away (reverts).
6. **Manipulation.** Dump to move spot 20%, then try to reshape and to deposit in the same block (both revert). Wait out the TWAP window; show that a persistent move is then accepted.
7. **Restore.** Buy the token up ~25%; show support lapsing; have a random address call restore and receive the bounty.
8. **Outside LP.** Deposit 10% in kind, show exact proportional cost, withdraw, show the issuer's shares and support untouched.
9. **Curator change.** Propose, show the timelock blocking, finalise, show the new curator still cannot rug.
10. **Release.** Jump past the unlock date; show linear vesting and a blocked over-withdrawal.

---

## 19. Open questions and future work

- **Fee pass-through to outside LPs:** pro-rata distribution and a curator fee share (product scope, not yet in the prototype).
- **Multiple support bands** (for example ±0.5%, ±2%, ±5%) for finer guarantees.
- **Variable Seed weighting:** the CCA records entry-time-weighted demand; a product may prefer to normalise it.
- **Recipient-mode reshape path** (two-step commit/execute) and its testing.
- **Permissionless curator registry** with on-chain records across launches.
- **Non-CCA launches** that seed a v4 pool directly.
- **Testnet deployment** and a public dashboard.
- **Demand signal:** at least one CCA team, launchpad or curator stating they would use it.

---

## 20. Glossary

- **CCA (Continuous Clearing Auction):** Uniswap's on-chain token auction that clears block by block and seeds a v4 pool at the end.
- **Liquidity Launcher / LBPStrategy:** Uniswap's contracts that take auction proceeds and create the pool and LP position.
- **Hook:** a contract a v4 pool calls at defined points (before initialise, after swap, …).
- **Position / range:** liquidity between two ticks owned by one address.
- **Tick:** the pool's price unit; in Covenant's pools a higher tick means a cheaper token.
- **Quote asset:** the currency the token trades against (ETH or USDC). Buy support is quote sitting just above the current tick.
- **Asks:** the issuer's tokens sitting just below the current tick, sold to buyers as the price rises.
- **TWAP tick:** time-weighted average tick kept by the hook.
- **Support share:** fraction of the vault's quote sitting within the support band.
- **Reshape:** an atomic remove-and-re-add of ranges by the curator.
- **Restore:** a permissionless, fixed reshape that repairs Support after price drift, paid by a bounty.
- **Setup epoch:** the first epoch after adoption, exempt from Pace.
- **In-kind shares:** shares minted or burned against proportional liquidity in every range, never priced in a currency.