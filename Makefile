# Thin wrappers so the common commands are discoverable. The contract targets are plain forge; the demo targets run
# the web app in web/ against the contracts on a local Anvil chain.
.PHONY: build test test-attacks test-integration test-invariant test-fork sizes snapshot coverage fmt fmt-check poc clean demo chain web-install web-test record fork deploy-sepolia verify-sepolia launch-sepolia proof-sepolia

build:
	forge build

test:
	forge test

test-attacks:
	forge test --match-path "test/attacks/*" -vv

test-integration:
	forge test --match-path "test/integration/*" -vv

test-invariant:
	forge test --match-path "test/invariant/*"

# Needs BASE_SEPOLIA_RPC_URL (the public endpoint works).
test-fork:
	forge test --match-path "test/fork/*" -vv

# EIP-170 gate for Covenant's own contracts.
sizes: build
	python3 script/tools/check-sizes.py

snapshot:
	forge snapshot --match-path "test/{hook,vault,attacks,integration}/*" --no-match-test "test_gas_|invariant_"

coverage:
	FOUNDRY_CODE_SIZE_LIMIT=4000000 forge coverage --ir-minimum --no-match-path "test/{prototype,fork}/*" --no-match-test "invariant_|test_handlerExercisesTheVault|test_gas_" --report summary

fmt:
	forge fmt src test/base test/unit test/hook test/vault test/attacks test/invariant test/integration test/fork script

fmt-check:
	forge fmt --check src test/base test/unit test/hook test/vault test/attacks test/invariant test/integration test/fork script

# The pump-ratchet drain, demonstrated against the unmodified prototype.
poc:
	forge test --match-contract PumpRatchetPoC -vv

clean:
	forge clean

# ----------------------------------------------------------------------------------------------------- the demo app

web-install:
	@[ -d web/node_modules ] || npm --prefix web ci

# Everything at once: Anvil with Uniswap's launch stack and Covenant, a seeded launch, and the app on :3000.
demo: build web-install
	cd web && npm run demo

# The local chain only (for running the app separately with `npm run dev` in web/).
chain: build web-install
	cd web && npm run chain

# The web app's tests: unit tests, then its scenarios against a dedicated local chain.
web-test: build web-install
	cd web && npm run abi && npm test && npm run test:chain

# Re-record the landing page's figures from the contracts (web/src/fixtures/recorded.json).
record: build web-install
	cd web && npm run record

# ------------------------------------------------------------------------------------------------------ Base Sepolia

# The Base Sepolia deployment and launch, rehearsed on a local fork of the live chain (Anvil on :8548): the real deploy
# script beside Uniswap's deployed contracts, then the launch in 2-second blocks (about six minutes). It only
# reads the live chain; nothing is sent to it.
fork: build web-install
	cd web && npm run fork

# Deploys Covenant to Base Sepolia with the funded PRIVATE_KEY in .env. Simulates first, then asks before it broadcasts
# (CONFIRM=yes skips the question). Verifies the contracts on Basescan when BASESCAN_API_KEY is set.
deploy-sepolia: build
	@test -f .env || { echo "deploy-sepolia: put a funded PRIVATE_KEY in .env first (see .env.example)"; exit 1; }
	@set -a; . ./.env; set +a; \
	rpc="$${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"; \
	[ -n "$$PRIVATE_KEY" ] || { echo "deploy-sepolia: PRIVATE_KEY is empty in .env"; exit 1; }; \
	sender=$$(cast wallet address --private-key "$$PRIVATE_KEY") || exit 1; \
	echo "deploy-sepolia: simulating as $$sender"; \
	forge script script/Deploy.s.sol --rpc-url "$$rpc" --sender "$$sender" || exit 1; \
	if [ "$(CONFIRM)" != yes ]; then printf "Broadcast this deployment to Base Sepolia? [y/N] "; read ok; [ "$$ok" = y ] || { echo "deploy-sepolia: not broadcast"; exit 1; }; fi; \
	forge script script/Deploy.s.sol --rpc-url "$$rpc" --private-key "$$PRIVATE_KEY" --broadcast --slow \
	  $${BASESCAN_API_KEY:+--verify --etherscan-api-key "$$BASESCAN_API_KEY"}

# Publish the deployment's source on Sourcify (no API key needed). Blockscout shows it from there; Basescan does not.
verify-sepolia: build
	./script/verify-sourcify.sh

# The testnet launch on Base Sepolia, signed with the key in .env: about 0.24 ETH of bids, most of it back at the end,
# and about a minute of real blocks (one every 200 ms). If it stops, run it again and it carries on where it left off.
launch-sepolia: web-install
	cd web && npm run launch -- --net base-sepolia

# The live proof on Base Sepolia, signed with the key in .env: a refused rug, an honest reshape, a sell-off held until the
# TWAP has followed it, and a stranger's restore, each a real transaction. About half an hour; resumes if it stops.
# Rehearse first: `cd web && npm run proof -- --rehearse`.
proof-sepolia: web-install
	cd web && npm run proof -- --net base-sepolia
