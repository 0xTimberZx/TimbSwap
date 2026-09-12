# Security Policy & Bug Bounty

TimbSwap runs on **Arbitrum One** with a **capped beta** posture: real value is
live but bounded, behind a timelock + multisig, while an independent audit is
pending. We welcome good-faith security research and will reward responsibly
disclosed vulnerabilities.

> **Report privately — do not open a public issue or exploit on mainnet.**
> Primary channel: **GitHub → this repo → Security → "Report a vulnerability"**
> (private advisory). Backup: `<security contact — e.g. security@timbswap.xyz>`.

---

## How to report

1. Send a report via the private channel above with: affected contract(s) +
   address, a description, impact, and a **proof of concept** (a Foundry test
   or a fork script is ideal).
2. We acknowledge within **72 hours**, trap-triage severity, and keep you
   updated through the fix.
3. Please give us **up to 90 days** (or until a fix ships, whichever is sooner)
   before any public disclosure. Coordinated disclosure only.

---

## Scope (in)

The **deployed Arbitrum One contracts** recorded in
[`MAINNET_ADDRESSES.md`](./MAINNET_ADDRESSES.md) — and their source in
`contracts/`. In scope by category:

- **DEX core** — `TimbSwapFactory`, `TimbSwapRouter`, the TIMBS/WETH pair.
- **Prize game** — `TimbPrize`, `GameRegistry`, `PrizeEscrow`, `VRFEntropy`,
  `EligibleTokenRegistry`.
- **Token & incentives** — `TIMBSToken`, `TimbStaking`, `TimbFarm`,
  `TimbLockVault`, `TimbYieldVault`, `TimbTreasury`.
- **Governance** — `TimbGovernance`, `TimelockController`.

We're most interested in: **theft or permanent loss/freezing of user or protocol
funds**, breaking the reward-solvency invariant (paying tokens not held), prize
outcome manipulation, escrow/pot drainage, wiring/authorization bypass, and
settlement/liveness griefing.

## Scope (out)

- The **frontend / static site**, `config.js`, and any off-chain keeper or
  telemetry infrastructure — *cosmetic* issues only. A display bug that could
  **mislead a user into a losing on-chain action** is in scope as **T1** below.
- **Testnet** (Arbitrum Sepolia) deployments — no value, not in scope.
- **Third-party** code and infra: Chainlink VRF, OpenZeppelin, the Arbitrum
  sequencer/bridge, RPC providers, wallets.
- **Already-documented behavior**, including items in
  [`dev-docs/PRE_MAINNET_AUDIT.md`](./dev-docs/PRE_MAINNET_AUDIT.md): FoT/
  rebasing tokens are **unsupported** (standard ERC-20 only); intentional,
  timelock-gated admin powers (pause, `emergencyWithdraw`, `adminMarkIneligible`);
  read-only reentrancy on `Pair.getReserves()` (standard V2 integrator hazard).
- Gas-optimization suggestions, best-practice notes without a concrete exploit,
  and automated-scanner output without a working PoC.

## Severity & rewards

Severity is **impact-based** (roughly funds-at-risk × likelihood). Rewards are
paid in **ETH or USDC**. Amounts below are the **capped-beta starting bands** —
they scale with the live value-at-risk and grow after the independent audit. Any
single payout is capped at the program budget.

| Tier | Class | What lands here | Reward (starting band) |
|---|---|---|---|
| **T1** | UI / display | A display or labelling bug that could **mislead a user into a losing on-chain action** (e.g. wrong pot/price/reward numbers shown). Pure cosmetic issues are out of scope. | **$50 – $150** |
| **T2** | Operational / fallback | Keeper/automation failures, the observability events firing (`YieldHarvestFailed`, `PotShareForwardFailed`, …), VRF stall / `rerequest` griefing, **recoverable** settlement/liveness DoS. Value stuck or degraded, not lost. | **$150 – $500** |
| **T3** | Misrouting / contractual | Value routed to the wrong place or mis-split: buyback 5/20/75, lapse 70/30, pot/escrow/refund accounting. Bounded, usually per-round. Off-chain-signaling **governance** manipulation (voting-power/quorum bypass) lands here — real authority is the timelock/multisig, so it cannot directly move funds during beta. | **$500 – $1,500** |
| **T4** | Token & DEX structural | TIMBS mint/inflate/cap- or transfer-cap-bypass, whitelist bypass, DEX `k`-invariant break, **reward-solvency** break (paying tokens the contract doesn't hold), LP theft. | **$1,500 – $5,000** |
| **T5** | Deep exploit / drain | Full drain of `PrizeEscrow` / `TimbYieldVault` / `TimbTreasury` / the pair; **prize-outcome manipulation** (predicting or biasing the VRF draw); owner/privilege escalation; chained multi-contract exploit. | **10–20% of value-at-risk, floor ~$5,000** |

Reentrancy that bypasses the `nonReentrant` guards is priced by its **impact** —
a reentrancy that drains escrow is a T5, not a tier of its own.

Final severity and reward are at the maintainers' discretion, guided by the
[Immunefi severity classification](https://immunefi.com/immunefi-vulnerability-severity-classification-system-v2-3/)
as a reference. First valid reporter of a unique issue is eligible.

### Why disclosure beats exploitation (flow vs. stock)

Two independent controls keep the honest payout larger than the exploit payoff,
each covering a different class of bug:

- **Flow bugs** siphon what *moves through* a round — ticket entries, pot
  contributions, lapse splits, buyback throughput. The **6-hour round frame**
  bounds these: realizable value ≈ one round's flow × the few rounds before
  monitoring + a multisig `pause()` stop it (see
  [`dev-docs/CAPPED_BETA_GUARDRAILS.md`](./dev-docs/CAPPED_BETA_GUARDRAILS.md)).
  The haul is small, so a T2–T3 bounty dominates. Most of the game-mechanic
  surface is here.
- **Stock bugs** hit *accumulated* value — draining escrow, a vault, the
  treasury, or the LP in a single transaction. The round frame does **nothing**
  for these; there are no rounds to wait out. Here it is the **value-at-risk
  ceiling** that keeps the exploit prize bounded, and the T5 band scales to it
  so disclosing still wins.

The two levers do different jobs — the round frame bounds *flow*, the VaR cap
bounds *stock* — and together they make "collect the bounty and close the gap"
the rational move across the whole table.

## Rules of engagement

- **Test on local forks or testnet only.** Never exploit, drain, or DoS the live
  mainnet contracts or infrastructure.
- **Never touch other users' funds or data.** No mainnet transactions beyond what
  a minimal, non-destructive PoC needs.
- No social engineering, phishing, physical attacks, or targeting of team members
  or third parties.
- One report per unique root cause; don't spam variants.

## Safe harbor

For research conducted in **good faith** and within these rules, we will not
pursue or support legal action against you, and we consider your activity
authorized. This is **not** authorization to violate any law or to access
accounts/data that are not yours. If in doubt, ask first via the private channel.

## Eligibility

- Not open to current or former TimbSwap contributors, or their immediate family.
- You must comply with applicable sanctions/AML law; we cannot pay sanctioned
  individuals or jurisdictions. KYC may be required before payout.

---

*This policy covers the capped-beta window. After the independent audit and as
the value-at-risk ceiling rises, scope and reward bands will be revised upward.
See [`dev-docs/CAPPED_BETA_GUARDRAILS.md`] for the surrounding safety posture.*
