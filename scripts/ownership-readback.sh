#!/bin/sh
# ownership-readback.sh — read-only check of who controls the mainnet contracts
# (issue #184). Run it before the Ownable2Step handoff to the timelock, after
# each acceptOwnership batch, and whenever MAINNET_ADDRESSES.md is edited, so
# the ownership table records what the chain says rather than what was intended.
#
# Every read is a `cast call`; nothing is signed or sent, and no key is needed.
#
# What it reads:
#   - owner() and pendingOwner() of every listed contract
#   - the fee recipients: factory.feeTo() and each router's treasury()
#   - the TimelockController: minDelay, and the Safe's proposer, executor and
#     canceller roles, plus who holds DEFAULT_ADMIN_ROLE
#   - the roles that act without the timelock delay (settler, operator,
#     dispatcher, guardian, TIMBS minters, the lapse sink), printed as info
#
# Usage:
#   R1=https://arb1.arbitrum.io/rpc sh scripts/ownership-readback.sh
#   R1=... HANDOFF_DONE=1 sh scripts/ownership-readback.sh   # after §6
#
# Env:
#   R1             Arbitrum One RPC URL (required)
#   TIMELOCK       default: the live TimelockController
#   SAFE           default: the 2-of-3 Safe
#   DEPLOYER_ADDR  optional; checked for leftover ownership and timelock admin
#   HANDOFF_DONE   1 = every contract must be owned by its expected owner with
#                  nothing pending; otherwise ownership lines are info, and only
#                  a pending transfer to an unexpected address fails
#   FEE_TO_EXPECT  optional; factory.feeTo() and every router's treasury()
#                  must equal it (the beta's new TimbTreasury)
#   CONTRACTS      optional; replaces the default list. Space-separated
#                  Name=address or Name=address=expectedOwner entries, where
#                  expectedOwner is TIMELOCK, SAFE or an address
#   EXTRA          optional; appended to the list in the same format, for the
#                  contracts DeployBeta adds (new router, registry, prize,
#                  treasury, faucet, entropy)
#
# VRFEntropy uses one-step Ownable: transferOwnership takes effect at once, has
# no pendingOwner and cannot be undone, so its line says so.
#
# Exit 0 only when every expectation holds. "info" lines never fail the run.
set -u
: "${R1:?set R1 to an Arbitrum One RPC URL}"
CAST=${CAST:-cast}
TIMELOCK=${TIMELOCK:-0x13e227499b2ce81da39179d113304fa4367efe7a}
SAFE=${SAFE:-0xFbcD2D0581a54cEE87Ab2693B9E9b7dCC19c79F9}
DEPLOYER_ADDR=${DEPLOYER_ADDR:-}
HANDOFF_DONE=${HANDOFF_DONE:-0}
FEE_TO_EXPECT=${FEE_TO_EXPECT:-}
EXPECT_CHAIN=${EXPECT_CHAIN:-42161}
ZERO=0x0000000000000000000000000000000000000000
MIN_DELAY=172800 # 48 hours

# Live Arbitrum One contracts (MAINNET_ADDRESSES.md).
DEFAULT_CONTRACTS="
TimbSwapFactory=0x60d4f18fe205c0ed38507a8fbf89aaa1bd2ce183
TimbSwapRouter=0x4f33df838c0d357c7f1a44ffb5ee0fc49a62b5fe
TIMBSToken=0x44bc0ab521191e839c3cb5bb20c9d044c8471ea1
PrizeEscrow=0xa9355021cef39be7b67fb81a1c91df53fce0dd32
EligibleTokenRegistry=0x0fd3777190380a12f106f57c67913f7159bc8c34
GameRegistry=0x8c40ed0cce3585b694a45106314b09dff4e04137
TimbPrize=0x70e7c0c1470a5d79728cd5676940883e981365ed
VRFEntropy=0x862aa09cbdeb0d7b003b66773304c996ede7c4b9
TimbYieldVault=0x73a33dbe76908cb2b05055931258878b0ae9b3cc
TimbStaking=0xed8d6d5fe6eedcd173dbc09ef9b6474e4f155a83
TimbFarm=0x1cb001784bc085fea2873782c1a0e71f4208a91f
TimbLockVault=0x6bdc48bb03ecedf958a5163d34d47c23655b461c
TimbTreasury=0xee3e403fa75ef3b17f4763880e019ad606837834
TimbGovernance=0x26d1e27132d1d5cdb449d641938c7da26cd5be63
TimbAirdropDistributor=0x955e5800245164EC4DCd1da9062115bBdA132c83
"
LIST="${CONTRACTS:-$DEFAULT_CONTRACTS} ${EXTRA:-}"

fail=0
lc() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
# cast appends " [1e18]" style annotations to large integers; drop them.
call() { "$CAST" call "$@" --rpc-url "$R1" 2>/dev/null | sed 's/ \[.*$//'; }
ok()   { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }
info() { printf '  info  %s\n' "$1"; }
name_of() { # addr -> TIMELOCK / SAFE / DEPLOYER / ZERO / addr
  a=$(lc "$1")
  if   [ "$a" = "$(lc "$TIMELOCK")" ]; then echo "$1 (timelock)"
  elif [ "$a" = "$(lc "$SAFE")" ]; then echo "$1 (Safe)"
  elif [ -n "$DEPLOYER_ADDR" ] && [ "$a" = "$(lc "$DEPLOYER_ADDR")" ]; then echo "$1 (deployer)"
  elif [ "$a" = "$ZERO" ]; then echo "none"
  else echo "$1"; fi
}
resolve() { # TIMELOCK / SAFE / addr -> addr
  case "$1" in TIMELOCK) echo "$TIMELOCK" ;; SAFE) echo "$SAFE" ;; *) echo "$1" ;; esac
}
has_code() {
  code=$("$CAST" code "$1" --rpc-url "$R1" 2>/dev/null)
  [ -n "$code" ] && [ "$code" != "0x" ]
}

echo "== chain"
chain=$("$CAST" chain-id --rpc-url "$R1" 2>/dev/null)
if [ "$chain" = "$EXPECT_CHAIN" ]; then ok "chain id $chain"; else bad "chain id ${chain:-unreachable} (expected $EXPECT_CHAIN)"; exit 1; fi
if has_code "$TIMELOCK"; then ok "timelock has code at $TIMELOCK"; else bad "timelock has no code at $TIMELOCK"; fi
if has_code "$SAFE"; then ok "Safe has code at $SAFE"; else bad "Safe has no code at $SAFE"; fi

echo "== timelock"
delay=$(call "$TIMELOCK" "getMinDelay()(uint256)")
if [ "$delay" = "$MIN_DELAY" ]; then ok "minDelay $delay s (48 h)"; else bad "minDelay ${delay:-unreadable} (expected $MIN_DELAY)"; fi
for role in PROPOSER_ROLE EXECUTOR_ROLE CANCELLER_ROLE; do
  h=$("$CAST" keccak "$role")
  r=$(call "$TIMELOCK" "hasRole(bytes32,address)(bool)" "$h" "$SAFE")
  if [ "$r" = "true" ]; then ok "Safe holds $role"; else bad "Safe does not hold $role"; fi
done
ADMIN=0x0000000000000000000000000000000000000000000000000000000000000000
r=$(call "$TIMELOCK" "hasRole(bytes32,address)(bool)" "$ADMIN" "$TIMELOCK")
info "timelock holds its own DEFAULT_ADMIN_ROLE: ${r:-unreadable}"
if [ -n "$DEPLOYER_ADDR" ]; then
  r=$(call "$TIMELOCK" "hasRole(bytes32,address)(bool)" "$ADMIN" "$DEPLOYER_ADDR")
  if [ "$r" = "true" ]; then
    if [ "$HANDOFF_DONE" = 1 ]; then bad "deployer still holds timelock DEFAULT_ADMIN_ROLE"; else info "deployer still holds timelock DEFAULT_ADMIN_ROLE (renounce at handoff)"; fi
  else ok "deployer holds no timelock admin role"; fi
fi

echo "== ownership"
for entry in $LIST; do
  n=${entry%%=*}; rest=${entry#*=}
  addr=${rest%%=*}; want=TIMELOCK
  [ "$rest" != "$addr" ] && want=${rest#*=}
  want_addr=$(resolve "$want")
  if ! has_code "$addr"; then bad "$n: no code at $addr"; continue; fi
  owner=$(call "$addr" "owner()(address)")
  [ -n "$owner" ] || { bad "$n: owner() unreadable at $addr"; continue; }
  pending=$(call "$addr" "pendingOwner()(address)")
  if [ -z "$pending" ]; then
    kind="one-step Ownable: transferOwnership is immediate and final"; pending=$ZERO
  else kind="Ownable2Step"; fi
  line="$n owner $(name_of "$owner"), pending $(name_of "$pending")"
  if [ "$HANDOFF_DONE" = 1 ]; then
    if [ "$(lc "$owner")" = "$(lc "$want_addr")" ] && [ "$pending" = "$ZERO" ]; then ok "$line"
    else bad "$line (expected owner $(name_of "$want_addr"), nothing pending)"; fi
  elif [ "$pending" != "$ZERO" ] && [ "$(lc "$pending")" != "$(lc "$want_addr")" ]; then
    bad "$line (pending transfer to an unexpected address; expected $(name_of "$want_addr"))"
  else
    info "$line"
  fi
  case "$kind" in one-step*) info "$n is $kind" ;; esac
  if [ -n "$DEPLOYER_ADDR" ] && [ "$HANDOFF_DONE" = 1 ] && [ "$(lc "$owner")" = "$(lc "$DEPLOYER_ADDR")" ]; then
    bad "$n is still owned by the deployer"
  fi
done

echo "== fee recipients"
for entry in $LIST; do
  n=${entry%%=*}; rest=${entry#*=}; addr=${rest%%=*}
  case "$n" in
    TimbSwapFactory*) getter="feeTo()(address)" ;;
    TimbSwapRouter*)  getter="treasury()(address)" ;;
    *) continue ;;
  esac
  v=$(call "$addr" "$getter")
  label="$n.${getter%%(*}"
  if [ -n "$FEE_TO_EXPECT" ]; then
    if [ "$(lc "$v")" = "$(lc "$FEE_TO_EXPECT")" ]; then ok "$label = $v"
    else bad "$label = ${v:-unreadable} (expected $FEE_TO_EXPECT)"; fi
  else
    info "$label = $(name_of "${v:-$ZERO}")"
  fi
done

echo "== delay-free roles (info)"
role() { # Name getter label
  for entry in $LIST; do
    n=${entry%%=*}; rest=${entry#*=}; addr=${rest%%=*}
    [ "$n" = "$1" ] || continue
    v=$(call "$addr" "$2")
    [ -n "$v" ] && info "$1.$3 = $(name_of "$v")"
  done
}
role TimbPrize              "settler()(address)"      settler
role TimbTreasury           "operator()(address)"     operator
role GasFaucet              "dispatcher()(address)"   dispatcher
role GasFaucet              "guardian()(address)"     guardian
role TimbAirdropDistributor "dispatcher()(address)"   dispatcher
role TimbAirdropDistributor "guardian()(address)"     guardian
role TIMBSToken             "stakingPool()(address)"  "stakingPool (minter)"
role TIMBSToken             "farmPool()(address)"     "farmPool (minter)"
role GameRegistry           "protocolSink()(address)" protocolSink

echo
if [ "$fail" = 0 ]; then echo "all checks passed"; else echo "one or more checks FAILED"; fi
exit "$fail"
