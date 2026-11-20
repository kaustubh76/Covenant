# deployments/

What is on chain, one set of records per chain id. The app and the scripts read these; nothing in them is secret.

| File | Written by | What it holds |
|---|---|---|
| `84532.json` | `make deploy-sepolia` (`script/Deploy.s.sol`) | The contracts on Base Sepolia, and the Uniswap stack they sit beside |
| `84532.runtime.json` | `make launch-sepolia`, `npm run launch` | Every launch made on them (vault, token, auction, creation block), the one the app opens by default, and the blocks each vault's activity feed keeps (`spans`) |
| `84532.proof.json` | `make proof-sepolia` | The live proof on CVNT: a soft rug refused, a crash, support restored by an outsider for a bounty |
| `84532-lp.proof.json` | `npm run proof -- --lp` | An outside LP joining CVLP, claiming its share of the fees and leaving, all in kind |
| `84532-manage.proof.json` | `npm run proof -- --manage` | CVLP's curator through a pump: the chase refused by the Anchor, a re-centre settling, an over-move refused by Pace |
| `84532-refusals.proof.json` | `npm run proof -- --refusals` | The attack lab's one-call attacks sent against CVNT and refused by the chain (skim, fragment, an early principal exit, farming the bounty, an outsider's reach for a range, a deposit the vault would pay for, the curator's withdrawal), plus a keeper's poke and the curator's fee claim |
| `84532-lifecycle.proof.json` | `npm run proof -- --lifecycle --vault 0x…` | CVQ, a vault with quick clocks (15-minute curator timelock, principal unlocking over an hour, one-hour epochs): every governance power used for real (a curator change refused early then settled, the issuer role handed over and back, principal refused while locked then withdrawn), the guard refusing three callers while an exit settles, a flash round trip in one block, and the pump-ratchet held for two hours and then synced until restore refuses to chase it |
| `84532.ledger.json` | `npm run ledger` | Every transaction the project's keys and the backend's relayer sent on Base Sepolia, read back from Blockscout and decoded; each state-changing function with its settled and refused transactions, and each attack with the ones that played it. `web/src/chain/ledger.test.ts` fails if any is missing |

Each proof record lists its transactions with their blocks and, for the ones meant to fail, the decoded revert. Rerunning a proof resumes it from its record; no step is sent twice.

Not committed: the local chain's records (`31337*`), a fork's (`84532-fork*`), and each launch's resumable progress (`*.launch.json`).
