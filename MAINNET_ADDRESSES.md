# TimbSwap — Mainnet Address Ledger (Arbitrum One, chain 42161)

Canonical record of deployed mainnet contracts. Two-phase deploy: **Phase 1
(DeployCore)** = the standalone DEX; **Phase 2 (DeployGame)** = TIMBS + the prize
game + incentive layer, attached to the Phase-1 DEX. See
`dev-docs/MAINNET_DEPLOY_RUNBOOK.md` for the full procedure.

> Addresses here are public on-chain facts. No keys, RPC URLs, or secrets belong
> in this file.

---

## Phase 1 — DeployCore (standalone DEX) ✅ LIVE

Deployed 2026-09-11. 3 transactions, ~0.00011 ETH total. Both contracts verified
on Sourcify (`exact_match`).

| Contract | Address | Notes |
|---|---|---|
| **TimbSwapFactory** | `0x60d4f18fe205c0ed38507a8fbf89aaa1bd2ce183` | `router()` → Router (wired) |
| **TimbSwapRouter** | `0x4f33df838c0d357c7f1a44ffb5ee0fc49a62b5fe` | `weth()` → WETH (immutable) |
| WETH (canonical, not deployed by us) | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | Arbitrum One WETH9 |

Post-deploy sanity (both confirmed):
- `Router.weth()` == canonical WETH ✓
- `Factory.router()` == TimbSwapRouter ✓

First real swap deferred to the Phase-2 TIMBS/WETH pair (no throwaway smoke pair).

---

## Phase 2 — DeployGame (TIMBS + game + incentives) — ⏳ PENDING

To be filled in after DeployGame broadcasts. Verify each against the wiring
matrix in `dev-docs/MAINNET_DEPLOY_RUNBOOK.md` §4 before `startGame`.

| Contract | Address |
|---|---|
| TIMBS token | `TBD` |
| PrizeEscrow | `TBD` |
| EligibleTokenRegistry | `TBD` |
| GameRegistry | `TBD` |
| TimbPrize | `TBD` |
| Prize VRFEntropy | `TBD` |
| TimbYieldVault | `TBD` |
| TimbStaking | `TBD` |
| TimbFarm | `TBD` |
| LockVault | `TBD` |
| TimbTreasury | `TBD` |
| TimbGovernance | `TBD` |
| TimelockController | `TBD` |
| TIMBS/WETH pair | `TBD` |

---

## Ownership / governance

| Item | Value | Status |
|---|---|---|
| Deployer | burner (gas-only; owns nothing after handoff) | — |
| Gnosis Safe / multisig (`GOV_MULTISIG`) | `TBD` | pending |
| TimelockController | `TBD` (Phase 2) | pending |
| Ownable2Step handoff → timelock | all 13 contracts | pending (runbook §6) |

Factory `feeTo` and Router `treasury` are owner-mutable (`setFeeTo` /
`setTreasury`), so the fee recipient can be repointed and ultimately governed by
the timelock after handoff.
