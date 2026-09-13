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
- [ ] Coverage at target on the value contracts (§3)
- [ ] Invariants written as passing fuzz/invariant tests
- [ ] Slither high/medium each **fixed or documented**
- [ ] Scope frozen: commit hash + `MAINNET_ADDRESSES.md`
- [ ] Known-issues doc ready for the reviewer
- [ ] Security contact filled in `SECURITY.md` + GitHub private advisories enabled
- [ ] Litepaper / spec current, so the auditor understands intent fast

Cheaper audits come from preparation, not negotiation. Every box ticked here is
hours you're not paying an auditor to spend.
