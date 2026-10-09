#!/bin/sh
# beta-preflight.sh — read-only chain checks before running DeployBeta on
# Arbitrum One (dev-docs/BETA_ETH_ONLY.md §10, step 2).
#
# Every read is a `cast call`; nothing is signed or sent. The script checks the
# same bindings DeployBeta's PRE-FLIGHT block requires, plus the things the
# script cannot see until it broadcasts: that the deployer owns every reused
# contract it will call, that the VRF values in .env.beta match the live
# entropy, that the lapsed-principal sink was copied and not guessed, and the
# current fee sinks (factory.feeTo, old router.treasury) so the switch to the
# new treasury is a known change rather than a surprise.
#
# Usage (never commit .env.beta; load the key with `read -s`):
#   source .env.beta
#   R1=https://arb1.arbitrum.io/rpc sh scripts/beta-preflight.sh
#
# Exit 0 only when every expectation holds. Lines marked "info" are printed for
# the operator and never fail the run.
set -u
: "${R1:?set R1 to an Arbitrum One RPC URL}"
CAST=${CAST:-cast}
OLD_ENTROPY=${OLD_ENTROPY_ADDR:-0x862aa09cbdeb0d7b003b66773304c996ede7c4b9}
ZERO=0x0000000000000000000000000000000000000000

fail=0
lc() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
# cast appends " [1e18]" style annotations to large integers; drop them.
call() { "$CAST" call "$1" "$2" --rpc-url "$R1" 2>/dev/null | sed 's/ \[.*$//'; }
ok()   { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }
info() { printf '  info  %s\n' "$1"; }
expect_eq() { # label got want
  if [ "$(lc "$2")" = "$(lc "$3")" ]; then ok "$1 = $2"; else bad "$1 = $2 (expected $3)"; fi
}
need() { # ENV_NAME
  eval "v=\${$1:-}"
  if [ -z "$v" ]; then bad "$1 is not set in the environment"; fi
}
has_code() { # label addr
  code=$("$CAST" code "$2" --rpc-url "$R1" 2>/dev/null)
  if [ -n "$code" ] && [ "$code" != "0x" ]; then ok "$1 has code at $2"; else bad "$1 has no code at $2"; fi
}

echo "== environment"
for n in DEPLOYER_PRIVATE_KEY TIMBS_TOKEN_ADDR PROTOCOL_SINK_ADDR PRIZE_ESCROW_ADDR ROUTER_ADDR \
         ELIGIBLE_REGISTRY_ADDR YIELD_VAULT_ADDR STAKING_ADDR TIMBS_WETH_PAIR WETH_ADDR \
         FAUCET_DISPATCHER VRF_COORDINATOR VRF_KEY_HASH VRF_SUB_ID VRF_EXTRA_ARGS \
         EXPECT_OLD_PRIZE EXPECT_OLD_REGISTRY; do need "$n"; done
[ "$fail" = 1 ] && { echo "fix the environment first (env.beta.example)"; exit 1; }

echo "== chain"
chain=$("$CAST" chain-id --rpc-url "$R1" 2>/dev/null)
expect_eq "chain id" "$chain" 42161
deployer=$("$CAST" wallet address --private-key "$DEPLOYER_PRIVATE_KEY" 2>/dev/null)
[ -n "$deployer" ] || { bad "could not derive the deployer address from DEPLOYER_PRIVATE_KEY"; exit 1; }
info "deployer $deployer balance $("$CAST" balance "$deployer" --rpc-url "$R1" -e 2>/dev/null) ETH"

echo "== reused contracts have code"
has_code TIMBSToken             "$TIMBS_TOKEN_ADDR"
has_code PrizeEscrow            "$PRIZE_ESCROW_ADDR"
has_code "old router"           "$ROUTER_ADDR"
has_code EligibleTokenRegistry  "$ELIGIBLE_REGISTRY_ADDR"
has_code TimbYieldVault         "$YIELD_VAULT_ADDR"
has_code TimbStaking            "$STAKING_ADDR"
has_code "TIMBS/WETH pair"      "$TIMBS_WETH_PAIR"
has_code WETH                   "$WETH_ADDR"
has_code "old prize"            "$EXPECT_OLD_PRIZE"
has_code "old registry"         "$EXPECT_OLD_REGISTRY"
has_code "old entropy"          "$OLD_ENTROPY"

echo "== PRE-FLIGHT bindings (what DeployBeta will require)"
expect_eq "escrow.timbPrize"   "$(call "$PRIZE_ESCROW_ADDR"   'timbPrize()(address)')"    "$EXPECT_OLD_PRIZE"
expect_eq "router.timbPrize"   "$(call "$ROUTER_ADDR"         'timbPrize()(address)')"    "$EXPECT_OLD_PRIZE"
expect_eq "vault.timbPrize"    "$(call "$YIELD_VAULT_ADDR"    'timbPrize()(address)')"    "$EXPECT_OLD_PRIZE"
expect_eq "vault.gameRegistry" "$(call "$YIELD_VAULT_ADDR"    'gameRegistry()(address)')" "$EXPECT_OLD_REGISTRY"
expect_eq "oldPrize.gameStarted" "$(call "$EXPECT_OLD_PRIZE"  'gameStarted()(bool)')"     false
expect_eq "oldRegistry.timbPrize" "$(call "$EXPECT_OLD_REGISTRY" 'timbPrize()(address)')" "$EXPECT_OLD_PRIZE"

echo "== ownership (every onlyOwner call DeployBeta makes on reused contracts)"
factory=$(call "$ROUTER_ADDR" 'factory()(address)')
info "factory $factory (from the old router)"
expect_eq "escrow.owner"   "$(call "$PRIZE_ESCROW_ADDR"       'owner()(address)')" "$deployer"
expect_eq "router.owner"   "$(call "$ROUTER_ADDR"             'owner()(address)')" "$deployer"
expect_eq "factory.owner"  "$(call "$factory"                 'owner()(address)')" "$deployer"
expect_eq "eligible.owner" "$(call "$ELIGIBLE_REGISTRY_ADDR"  'owner()(address)')" "$deployer"
expect_eq "vault.owner"    "$(call "$YIELD_VAULT_ADDR"        'owner()(address)')" "$deployer"
if [ -n "${AIRDROP_ADDR:-}" ] && [ "$(lc "$AIRDROP_ADDR")" != "$ZERO" ]; then
  has_code TimbAirdropDistributor "$AIRDROP_ADDR"
  ap=$(call "$AIRDROP_ADDR" 'paused()(bool)')
  ao=$(call "$AIRDROP_ADDR" 'owner()(address)')
  ag=$(call "$AIRDROP_ADDR" 'guardian()(address)')
  info "airdrop paused=$ap owner=$ao guardian=$ag"
  if [ "$ap" = true ]; then ok "airdrop already paused; DeployBeta skips setPaused"
  elif [ "$(lc "$ao")" = "$(lc "$deployer")" ] || [ "$(lc "$ag")" = "$(lc "$deployer")" ]; then ok "deployer may pause the airdrop"
  else bad "airdrop is live and the deployer is neither its owner nor its guardian"; fi
fi

echo "== fee sinks today (DeployBeta moves both to the new treasury)"
info "factory.router            $(call "$factory" 'router()(address)')   (must be the old router below)"
expect_eq "factory.router" "$(call "$factory" 'router()(address)')" "$ROUTER_ADDR"
info "factory.feeTo             $(call "$factory" 'feeTo()(address)')"
info "oldRouter.treasury        $(call "$ROUTER_ADDR" 'treasury()(address)')"
info "oldRouter.protocolFeeBps  $(call "$ROUTER_ADDR" 'protocolFeeBps()(uint256)')"
expect_eq "oldRouter.paused (before the switch)" "$(call "$ROUTER_ADDR" 'paused()(bool)')" false

echo "== lapsed-principal sink"
expect_eq "oldRegistry.protocolSink" "$(call "$EXPECT_OLD_REGISTRY" 'protocolSink()(address)')" "$PROTOCOL_SINK_ADDR"

echo "== VRF (copied from the live entropy $OLD_ENTROPY)"
expect_eq "coordinator" "$(call "$OLD_ENTROPY" 'coordinator()(address)')" "$VRF_COORDINATOR"
expect_eq "keyHash"     "$(call "$OLD_ENTROPY" 'keyHash()(bytes32)')"     "$VRF_KEY_HASH"
expect_eq "subId"       "$(call "$OLD_ENTROPY" 'subId()(uint256)')"       "$VRF_SUB_ID"
expect_eq "extraArgs"   "$(call "$OLD_ENTROPY" 'extraArgs()(bytes)')"     "$VRF_EXTRA_ARGS"
expect_eq "old entropy serves the old prize" "$(call "$OLD_ENTROPY" 'board()(address)')" "$EXPECT_OLD_PRIZE"

echo "== yield vault"
vb=$("$CAST" balance "$YIELD_VAULT_ADDR" --rpc-url "$R1" 2>/dev/null)
info "balance            $vb wei"
info "reserve            $(call "$YIELD_VAULT_ADDR" 'reserve()(uint256)') wei"
info "accruedForPot      $(call "$YIELD_VAULT_ADDR" 'accruedForPot()(uint256)') wei"
info "ratePerSecond1e18  $(call "$YIELD_VAULT_ADDR" 'ratePerSecond1e18()(uint256)')  (0 until setYieldAPRBps; set 1000 before startGame)"
expect_eq "timbsWeight1e18 (ETH-only beta)" "$(call "$YIELD_VAULT_ADDR" 'timbsWeight1e18()(uint256)')" 0

echo "== keeper keys"
if [ "$(lc "$FAUCET_DISPATCHER")" = "$(lc "$deployer")" ]; then bad "FAUCET_DISPATCHER is the deployer; use a fresh hot key"; else ok "FAUCET_DISPATCHER is not the deployer"; fi
info "FAUCET_DISPATCHER $FAUCET_DISPATCHER balance $("$CAST" balance "$FAUCET_DISPATCHER" --rpc-url "$R1" -e 2>/dev/null) ETH (gas only)"
if [ -n "${SETTLER_ADDR:-}" ] && [ "$(lc "$SETTLER_ADDR")" != "$ZERO" ]; then
  info "SETTLER_ADDR $SETTLER_ADDR balance $("$CAST" balance "$SETTLER_ADDR" --rpc-url "$R1" -e 2>/dev/null) ETH"
fi

echo
if [ "$fail" = 1 ]; then
  echo "PRE-FLIGHT FAILED: fix the lines marked FAIL before simulating."
  exit 1
fi
cat <<MSG
PRE-FLIGHT OK. Simulate (no broadcast) and read the script's own PRE-FLIGHT block:

  forge script scripts/DeployBeta.s.sol --rpc-url \$R1 -vvvv

Then broadcast, and fill config.mainnet.js from the receipt:

  forge script scripts/DeployBeta.s.sol --rpc-url \$R1 --broadcast --gas-estimate-multiplier 300
  node scripts/fill-beta-config.js --write
MSG
