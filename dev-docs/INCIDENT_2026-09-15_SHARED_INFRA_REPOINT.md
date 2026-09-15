# Incident — 2026-09-15: live shared infra repointed at a dev-mirror game

**Severity:** medium (testnet; no funds lost; live game degraded ~6 h)
**Status:** resolved; prevention shipped (pre-flight guard in `DeployGen3Migration`)

## TL;DR

`DeployGen3Migration.s.sol` was run from the **TimbSwap dev-mirror** checkout
under the belief that it served timbswap.xyz. It does not — **TestSwap** does.
The script's steps 6–7 repoint the *shared* `PrizeEscrow`, `TimbSwapRouter`,
`EligibleTokenRegistry` and `TimbYieldVault` at whatever prize/registry it just
deployed, and the `.env` it read held the **live** addresses of those shared
contracts. Result: the live game kept running, but its yield vault silently
stopped registering ticket weight, and its escrow/router briefly trusted a game
nobody plays.

## Timeline (UTC)

Times are approximate except where a tx is cited; the migration's exact block
is the deploy tx of registry `0x474D43…`.

| when | what |
|---|---|
| morning | Investigating "tickets stuck Pending" on the dev mirror; concluded it was the live site and that the live game had the gen-2 `onlyTimbPrize` activation bug. |
| morning | `DeployGen3Migration` broadcast from the dev mirror → new registry `0x474D43…`, prize `0x53ac69…`, entropy `0x252973…`. Steps 6–7 repointed the **live** escrow/router/vault at them. |
| later | Discovered the two-repo topology: TimbSwap = dev mirror (0xtimberzx.github.io), TestSwap = live (timbswap.xyz). Live game (registry `0x11C24…`, prize `0x6027a1…`) had never had the bug. |
| 11:33 | Faucet ported to TestSwap and proven live (first `dispense()`). User reports analytics "4 tickets" vs compete "1 entry". |
| ~11:50 | Root cause found: `vault.gameRegistry() == 0x474D43…`. Tickets 9–11 (activated after the repoint) had `weightOf == 0`; `remove()` for expiring tickets 5–7 had also been swallowed, stranding 3e14 weight. |
| 12:14 | Repair (owner txs, `0x8121395…`): `vault.setGameRegistry(0x11C24…)`; escrow/router `timbPrize()` confirmed already back on `0x6027a1…`; tickets 9–11 re-registered and 5–7 removed via a temporary `setGameRegistry(deployer)` window; `totalWeight` reconciled to 3e14 = the three live tickets. |
| 12:31 | Dev entropy `0x252973…` removed from the VRF sub (`0x2d0cf6c…`); dev-mirror keepers stripped of cron + self-chaining (TimbSwap #32) and in-flight runs cancelled. |

## Blast radius

- **Yield weight:** every ticket activated between ~06:30 and ~12:10 was
  `Active` (valid for winning) but carried no vault weight — `register()` from
  `0x11C24…` reverted `NotGameRegistry` inside the registry's try/catch. Same for
  `remove()`, which stranded the weight of tickets that expired in the window.
  Visible as analytics (`verifyEntryValid`) and compete (`weightOf`) disagreeing.
- **Escrow / router:** `setTimbPrize(devPrize)` was broadcast. `PrizeEscrow.pay`
  is `onlyTimbPrize`, so live `claimWinnings` / protocol-cut withdrawals would
  have reverted while it held; router swap-nudges would have gone to the dev
  prize. By the time they were read back both already pointed at the live prize
  — no winner claim was observed to fail in the window.
- **VRF:** the dev entropy was a live consumer on the shared subscription and
  the dev settler was on a 10-min cron, so dev-game settlements were spending
  the sub's LINK.
- **Not affected:** entry escrow (held in the registry, never touched), the
  AMM, farms, staking, TIMBS. Settlement itself kept running (escrow `deposit`
  is permissionless) — rounds advanced 43 → 46 through the incident.

## Root causes

1. **Wrong-repo assumption.** Two near-identical repos, neither with a CNAME
   file; the custom domain lives in TestSwap's Pages settings only. Nothing in
   either checkout says which one is live.
2. **The migration script repoints shared contracts with no check of what
   they are currently bound to.** It trusts `.env` completely. The `.env` was
   copied from the live runbook, so the *addresses* were right and the *intent*
   was wrong — and nothing on-chain was consulted before overwriting.
3. **Silent failure by design.** The registry's vault calls are try/catch-fenced
   (correctly — a vault outage must not brick the game), which turned a
   permission error into a slow, invisible drift instead of a loud revert.

## Prevention (shipped)

- **Pre-flight guard in `DeployGen3Migration`** (`_preflight`): the operator
  must set `EXPECT_OLD_PRIZE` and `EXPECT_OLD_REGISTRY`, and the script reads
  `escrow.timbPrize()`, `router.timbPrize()`, `vault.timbPrize()`,
  `vault.gameRegistry()` and refuses to broadcast unless all four match. It runs
  in simulation too, so a `--broadcast`-less run catches it. With this guard,
  the 06:30 run would have aborted: the escrow was bound to `0x6027a1…`, not the
  `0x5AED…` the operator believed was live.
- **Dev mirror can't run keepers unattended** (TimbSwap #32): every keeper
  workflow is `workflow_dispatch`-only; settler/faucet self-chaining removed.
- **Runbook:** `GEN3_MIGRATION.md` now leads with "confirm which repo is live"
  and the pre-flight env vars.

## Repair reference (owner-only, reusable)

```sh
# rebind the vault
cast send $VAULT "setGameRegistry(address)" $LIVE_REG --private-key $K --rpc-url $R
# re-register tickets activated during the window (1e14 = VAULT_WEIGHT_UNIT) /
# remove ids that expired during it — borrow the gate for a few blocks
cast send $VAULT "setGameRegistry(address)" $DEPLOYER --private-key $K --rpc-url $R
for ID in <activated-in-window>; do cast send $VAULT "register(uint256,address,uint256)" $ID 0x0000000000000000000000000000000000000000 100000000000000 --private-key $K --rpc-url $R; done
for ID in <expired-in-window>;   do cast send $VAULT "remove(uint256)" $ID --private-key $K --rpc-url $R; done
cast send $VAULT "setGameRegistry(address)" $LIVE_REG --private-key $K --rpc-url $R
# audit: scan weightOf(1..N) against registry.effectiveStatus — only Active ids may carry weight
```

## Lessons

- Before any owner tx that touches a shared contract, **read its current
  binding on-chain and compare it to the live config** — don't trust a repo
  or a `.env` to tell you what's live.
- When a codebase deliberately swallows errors from a dependency, add a
  **reconciliation read** somewhere visible (here: analytics vs compete entry
  counts) — that mismatch is what surfaced this.
- A repo that can deploy is a repo that can break production. Mirrors should
  not carry keeper schedules or live secrets.
