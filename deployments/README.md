# deployments/

What is on chain, one set of records per chain id. The app and the scripts read these; nothing in them is secret.

| File | Written by | What it holds |
|---|---|---|
| `84532.json` | `make deploy-sepolia` (`script/Deploy.s.sol`) | The contracts on Base Sepolia, and the Uniswap stack they sit beside |
| `84532.runtime.json` | `make launch-sepolia`, `npm run launch` | Every launch made on them (vault, token, auction, creation block), the one the app opens by default, and the blocks each vault's activity feed keeps (`spans`) |
| `84532.proof.json` | `make proof-sepolia` | The live proof on CVNT: a soft rug refused, a crash, support restored by an outsider for a bounty |
| `84532-lp.proof.json` | `npm run proof -- --lp` | An outside LP joining CVLP, claiming its share of the fees and leaving, all in kind |
| `84532-manage.proof.json` | `npm run proof -- --manage` | CVLP's curator through a pump: the chase refused by the Anchor, a re-centre settling, an over-move refused by Pace |

Each proof record lists its transactions with their blocks and, for the ones meant to fail, the decoded revert. Rerunning a proof resumes it from its record; no step is sent twice.

Not committed: the local chain's records (`31337*`), a fork's (`84532-fork*`), and each launch's resumable progress (`*.launch.json`).
