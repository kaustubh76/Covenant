#!/usr/bin/env bash
# Publish the source of Covenant's Base Sepolia contracts on Sourcify, through its v2 API. Blockscout reads it from there.
#
# forge 1.1's own Sourcify verifier still posts to the retired v1 endpoint, so this asks forge only for each contract's
# standard JSON input and submits that to https://sourcify.dev/server/v2 itself. Addresses come from
# deployments/84532.json and .runtime.json. The CovenantLogic library's address is read out of the deployed vault's own
# bytecode, where it is linked. Contracts Sourcify already has are skipped, so the script can be run again.
set -euo pipefail
cd "$(dirname "$0")/.."

CHAIN=84532
API=https://sourcify.dev/server
RPC="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
MANIFEST="deployments/$CHAIN.json"
RUNTIME="deployments/$CHAIN.runtime.json"
SOLC=$(jq -r '.metadata.compiler.version' out/CovenantVault.sol/CovenantVault.json)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

addr() { jq -r ".$1" "$MANIFEST"; }

# The library CovenantVault and VaultOps call, as linked into the live vault implementation.
IMPL=$(addr vaultImplementation)
CODE=$(cast code "$IMPL" --rpc-url "$RPC")
OFFSET=$(jq -r '.deployedBytecode.linkReferences["src/libraries/CovenantLogic.sol"].CovenantLogic[0].start' out/CovenantVault.sol/CovenantVault.json)
LOGIC="0x${CODE:$((2 + OFFSET * 2)):40}"
LIBS="src/libraries/CovenantLogic.sol:CovenantLogic:$LOGIC"

failed=0
verify() { # <address> <path:Contract> [libraries]
  local address=$1 id=$2 libs=${3:-} status job result
  status=$(curl -s "$API/v2/contract/$CHAIN/$address" | jq -r '.match // "none"')
  if [ "$status" != none ]; then printf '%-50s %s  already verified (%s)\n' "$id" "$address" "$status"; return; fi
  forge verify-contract "$address" "$id" --chain "$CHAIN" --show-standard-json-input ${libs:+--libraries "$libs"} >"$TMP/input.json"
  jq -n --arg v "$SOLC" --arg id "$id" --slurpfile i "$TMP/input.json" \
    '{stdJsonInput: $i[0], compilerVersion: $v, contractIdentifier: $id}' >"$TMP/body.json"
  job=$(curl -s -X POST "$API/v2/verify/$CHAIN/$address" -H 'content-type: application/json' --data-binary @"$TMP/body.json" |
    jq -r '.verificationId // empty')
  if [ -z "$job" ]; then printf '%-50s %s  submission refused\n' "$id" "$address"; failed=1; return; fi
  for _ in $(seq 1 60); do
    result=$(curl -s "$API/v2/verify/$job")
    [ "$(echo "$result" | jq -r '.isJobCompleted')" = true ] && break
    sleep 3
  done
  status=$(echo "$result" | jq -r '.contract.match // empty')
  if [ -n "$status" ]; then
    printf '%-50s %s  %s\n' "$id" "$address" "$status"
  else
    printf '%-50s %s  failed: %s\n' "$id" "$address" "$(echo "$result" | jq -r '.error.message // "no result"')"
    failed=1
  fi
}

verify "$LOGIC" src/libraries/CovenantLogic.sol:CovenantLogic
verify "$(addr hook)" src/CovenantHook.sol:CovenantHook
verify "$(addr vaultOps)" src/vault/VaultOps.sol:VaultOps "$LIBS"
verify "$(addr factory)" src/CovenantFactory.sol:CovenantFactory "$LIBS"
verify "$IMPL" src/CovenantVault.sol:CovenantVault "$LIBS"
verify "$(addr seedPlanner)" src/periphery/SeedPlanner.sol:SeedPlanner
verify "$(addr lens)" src/periphery/CovenantLens.sol:CovenantLens
for token in $(jq -r '.launches[].token' "$RUNTIME"); do verify "$token" script/tokens/LaunchToken.sol:LaunchToken; done
exit $failed
