# Audit Prep — the low-budget path to a mainnet-ready audit

Goal: reach mainnet audited **without** a five-figure boutique engagement, by
de-risking with free tooling first and handing any paid reviewer a clean,
tested, well-scoped codebase (which is the single biggest lever on their price).

Sequence: **free tooling now → fix/triage → freeze scope → cheap review →
ongoing bounty → mainnet.**

---

## 1. Free tooling (run before paying anyone)

| Tool | What it catches | How |
|---|---|---|
| **Slither** | reentrancy, access-control, arithmetic, uninitialized state, shadowing | **Now in CI** — `.github/workflows/slither.yml` (runs on every contracts change; findings land in the repo **Security** tab as SARIF). Locally: `slither .` in a Foundry checkout. |
| **Aderyn** (Cyfrin, Rust) | complementary static findings, nice markdown report | `cargo install aderyn && aderyn .` |
| **Foundry coverage** | untested code = unaudited code | `forge coverage --report summary` — drive the value contracts up (below) |
| **Foundry fuzz / invariant** | property violations | already configured (`[fuzz] runs=1000`); write invariant tests for the rules in §3 |
| **Echidna / Medusa** | deep property fuzzing | optional, high value on the AMM + solvency math |
| **Mythril** | symbolic execution | optional, slow; run on the highest-risk contracts only |

> The sandbox can't run these (the proxy blocks the solc binary host), which is
> exactly why Slither lives in **CI** — GitHub runners fetch solc fine. Treat the
> Security tab as your rolling free-audit dashboard.

## 2. Read the Slither output like an auditor

Every finding is one of: **fix it**, or **justify it**. For each high/medium:
- Real bug → fix + add a regression test.
- False positive / accepted risk → document *why* (a one-line code comment or a
  row in the known-issues doc). Auditors bill by the hour; a triaged codebase
  where you've already dispositioned the static findings is a cheaper audit.

## 3. Repo hardening (what actually lowers the quote)

- **Coverage on the value-holding contracts first:** `TimbSwapPair`,
  `TimbSwapRouter`, `PrizeEscrow`, `TimbYieldVault`, `TimbTreasury`,
  `TimbStaking`, `TimbFarm`, `TimbBoostFarm`, `TimbPrize`. Aim high here before
  worrying about the periphery.
- **Write the invariants as tests**, not prose: the 99%-solvency stop (accrued ≤
  reserves), the constant-product `k` on the pair, pot backing ≥ accounted pot,
  `totalStaked` never exceeds balances, no mint past the 100M cap. An auditor who
  sees these as passing invariant tests spends their time on the hard stuff.
- **NatSpec** on every external/public function.
- **Freeze the scope:** a single commit hash + the address list in
  `MAINNET_ADDRESSES.md` = the audit target. Moving code mid-audit costs money.
- **Hand over a known-issues doc** (you already reference
  `dev-docs/PRE_MAINNET_AUDIT.md`): FoT/rebasing unsupported, timelock-gated admin
  powers, read-only reentrancy on `getReserves()`, etc. Don't pay someone to
  rediscover what you already know.

## 4. Low-budget audit avenues (cheapest → pricier)

1. **Free-first (live now):** the CI Slither/Aderyn gate + the **testnet bug
   bounty** (`/gov/#bounty`) — continuous, crowd-sourced review at $0 fixed cost.
2. **Solo / independent auditor** — via the **Cantina marketplace** or a
   freelance auditor. A small AMM+game codebase can land in the low-thousands,
   not tens of thousands.
3. **Competitive audit** — **Code4rena / Cantina / Sherlock**: fund a prize pool,
   a crowd competes. More eyes per dollar than a single firm; you set the pool.
4. **Ongoing bounty vault** — **Hats Finance** (permissionless, low-budget) for
   continuous post-launch coverage; graduate to **Immunefi** once value-at-risk
   justifies its minimums.
5. **Subsidies** — open-source + Sourcify-verified projects sometimes get auditor
   discounts; check **Arbitrum ecosystem grants** for security funding.

Realistic plan on a shoestring: **CI static analysis + testnet bounty now → one
solo/competitive review of the frozen scope → Hats vault for the tail.**

## 5. Pre-audit checklist (tick before you engage anyone)

- [ ] `contracts` CI green (build + tests) and `slither` CI triaged
- [ ] Coverage at target on the value contracts (§3) (`forge coverage --ir-minimum`, 2026-10-20: Line A 83.5% lines at the freeze `28a343c`; after the tests-only coverage suites, 88.0% lines, 82.8% statements, 51.9% branches, 87.0% functions. EligibleTokenRegistry, TimbSwapFactory, TIMBSToken and VRFEntropy are at 100%. The remaining gaps are revert branches in the larger game and router contracts. 2026-10-28: GameRegistry branches 61.0% → 91.5% (129/141) with `tests/GameRegistryMoneyPaths.t.sol`, 27 tests on entry payment and refunds, replace, cancel, the refund window, lapse retry, admin refund, settlement pagination and the fenced vault calls; 9 mutants on those guards, each caught. TimbPrize branches 44.0% → 93.3% (70/75) with `tests/TimbPrizeMoneyPaths.t.sol`, 12 tests on the dual-layer winner filter against an adversarial registry, pot funding, the protocol cut, the harvest fence, lazy settlement and the settlement pause; 10 mutants, each caught)
- [x] Invariants written as passing fuzz/invariant tests (Line A, 2026-10-20: `tests/invariants/` — game solvency, pair `k` and LP accounting, TIMBS cap, yield-vault backing; each suite mutation-checked. `totalStaked` waits for Line C, TimbStaking is not in the beta)
- [x] Slither high/medium each **fixed or documented** (2026-10-21, run locally because Actions is off: Slither 0.11.6 at the freeze, 23 High and 36 Medium on Line A, none exploitable; re-run at each freeze move, latest `aa82111`. One hardening note: `submitEntry` sends its overpayment refund before writing state, guarded by `nonReentrant`. Triage in the audit handover)
- [x] Scope frozen: commit hash + `MAINNET_ADDRESSES.md` (`aa82111`, 2026-10-27; moved from `936288a`, `28a343c`, `78edf17`, `f2549d8`, `59ad191`, `ff2cdce`, `331762d` and `08d0360` for tests, the TS-056 fix, the TS-062 router fix, the TS-063 TimbPrize fix, the TS-068 router fix, the TS-072 pair/router fix, the TS-073 router fix and the TS-076/TS-077 GameRegistry fixes)
- [x] Known-issues doc ready for the reviewer (`audit-handover/TIMBSWAP_KNOWN_ISSUES.md`)
- [ ] Security contact filled in `SECURITY.md` + GitHub private advisories enabled
- [ ] Litepaper / spec current, so the auditor understands intent fast

Cheaper audits come from preparation, not negotiation. Every box ticked here is
hours you're not paying an auditor to spend.
