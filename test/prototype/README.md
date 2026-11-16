# Prototype baseline (temporary)

The original prototype from `docs/covenant-tests.zip`, with **import paths changed and nothing else**, so it
compiles from this repository instead of from inside a clone of `Uniswap/liquidity-launcher`.

It exists for two reasons:

1. To prove the pinned dependency tree builds and runs Uniswap's real contracts before any new code is written.
2. To host `PumpRatchetPoC.t.sol`, which demonstrates against the prototype the drain that the production
   Anchor rule closes.

`CovenantDemandCurve.t.sol` from the zip is not here: it extends a test base that only exists inside the CCA
repository. The same property (losing-bid demand is readable after the auction) is covered by
`CovenantChained.t.sol`.

The production suite has reached parity and gone well past it. This directory is kept on purpose, as the "before"
picture: `make poc` shows the drain on the prototype, and `test/attacks/PumpRatchet.t.sol` runs the same script against
the production vault. The untouched originals are also in `docs/covenant-tests.zip`.

## `launcher/`

Five test helpers copied from `lib/liquidity-launcher/test/` (MIT), import paths rewritten. They cannot be
imported in place: the launcher's tests reach its sources both as `src/...` and as `../../src/...`, which only
resolve to the same file when the launcher is the project root. From here they become two source units and
every shared struct fails to convert to itself.
