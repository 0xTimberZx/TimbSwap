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

## Phase 2 — DeployGame (TIMBS + game + incentives) — ✅ LIVE

Deployed 2026-09-11, verified on Sourcify (`exact_match`, all 14 contracts).
Token set: native ETH (WETH) + TIMBS only. VRF: native payment, 2-gwei lane.
Addresses below are the authoritative `run-latest.json` deployment records.

| Contract | Address |
|---|---|
| TIMBSToken | `0x44bc0ab521191e839c3cb5bb20c9d044c8471ea1` |
| PrizeEscrow | `0xa9355021cef39be7b67fb81a1c91df53fce0dd32` |
| EligibleTokenRegistry | `0x0fd3777190380a12f106f57c67913f7159bc8c34` |
| GameRegistry | `0x8c40ed0cce3585b694a45106314b09dff4e04137` |
| TimbPrize | `0x70e7c0c1470a5d79728cd5676940883e981365ed` |
| Prize VRFEntropy | `0x862aa09cbdeb0d7b003b66773304c996ede7c4b9` |
| TimbYieldVault | `0x73a33dbe76908cb2b05055931258878b0ae9b3cc` |
| TimbStaking | `0xed8d6d5fe6eedcd173dbc09ef9b6474e4f155a83` |
| TimbFarm | `0x1cb001784bc085fea2873782c1a0e71f4208a91f` |
| TimbLockVault | `0x6bdc48bb03ecedf958a5163d34d47c23655b461c` |
| TimbTreasury | `0xee3e403fa75ef3b17f4763880e019ad606837834` |
| TimbGovernance | `0x26d1e27132d1d5cdb449d641938c7da26cd5be63` |
| TimelockController | `0x13e227499b2ce81da39179d113304fa4367efe7a` |
| TIMBS/WETH pair | `0x6103c1145a0090ec0e39e9e75e6efb3c0099b86f` |

VRF subscription (native-funded), Prize VRFEntropy added as consumer:
`72983366175497031969234161895668664021089442402555517736315009804992223907473`

> Post-deploy sequence still pending: on-chain wiring-matrix verification (runbook
> §4), fund/seed (§3), then `startGame`, then ownership handoff (§6).

---

## Ownership / governance

| Item | Value | Status |
|---|---|---|
| Deployer | burner (gas-only; owns nothing after handoff) | — |
| Gnosis Safe / multisig (`GOV_MULTISIG`) | `0xFbcD2D0581a54cEE87Ab2693B9E9b7dCC19c79F9` (2-of-3) | ✅ set (timelock proposer/executor) |
| TimelockController | `0x13e227499b2ce81da39179d113304fa4367efe7a` | ✅ deployed |
| Treasury / sink / initial TIMBS mint | `0xFbcD2D0581a54cEE87Ab2693B9E9b7dCC19c79F9` (the Safe) | ✅ set |
| Ownable2Step handoff → timelock | all 13 contracts | ⏳ pending (runbook §6) |

Factory `feeTo` and Router `treasury` are owner-mutable (`setFeeTo` /
`setTreasury`), so the fee recipient can be repointed and ultimately governed by
the timelock after handoff.
