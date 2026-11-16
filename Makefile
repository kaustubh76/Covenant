# Thin wrappers so the common commands are discoverable. The contract targets are plain forge; the demo targets run
# the web app in web/ against the contracts on a local Anvil chain.
.PHONY: build test test-attacks test-integration test-invariant test-fork sizes snapshot coverage fmt fmt-check poc clean demo chain web-install web-test record

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
