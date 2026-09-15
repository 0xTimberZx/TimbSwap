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
- **Airdrop** *(once deployed and listed in `MAINNET_ADDRESSES.md`)* —
  `TimbAirdropDistributor`, the Arbitrum One sink for the testnet-claim →
  mainnet-TIMB airdrop. It custodies a small pre-funded TIMB float behind
  `totalCap` / `perRoundCap` / a one-way `claimed[round][recipient]` flag.
  In scope: draining or exceeding the float or caps, paying an address twice,
  bypassing the dispatcher/owner gate or the pause.

We're most interested in: **theft or permanent loss/freezing of user or protocol
funds**, breaking the reward-solvency invariant (paying tokens not held), prize
outcome manipulation, escrow/pot drainage, wiring/authorization bypass, and
settlement/liveness griefing.

## Scope (out)

- The **frontend / static site**, `config.js`, and any off-chain keeper or
  telemetry infrastructure — *cosmetic* issues only. A display bug that could
  **mislead a user into a losing on-chain action** is in scope as **T1** below.
  The airdrop's **off-chain half** (the faucet-claim gate, Turnstile, the
  `airdrop_outbox` table, the `airdrop-dispatch` sender) follows the same rule:
  getting an *ineligible* address queued is **T2** at most, because the
  on-chain caps and `claimed[]` flag bound what any queued row can ever be
  worth; only an off-chain fault that produces a **duplicate or over-cap
  on-chain payment** lands in T3–T4 — and that requires a contract bug, which
  is in scope above.
  (During the capped beta client telemetry is **localStorage-only** — no network
  sink, so no user-data pipeline to exploit; if an aggregated sink is re-enabled
  post-audit it will be hardened and brought explicitly into scope.)
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

### Wallet & frontend interaction

"Wallet connection issues" split on one line — is a user's **money** at risk, or
just their **convenience**?

- **Out** (a normal bug / support request, not the bounty): failure to connect,
  disconnect, wrong-network detection, chain-switch prompts — and any fault in
  the wallet software, the WalletConnect relay, or an RPC provider (third-party).
- **In**: anything that can **misdirect or drain funds** —
  - a **`config.js` contract address pointing to a wrong/unintended contract**,
    so approvals and swaps route to the wrong place → **T3 (misrouting)**;
  - a **transaction or signature that does more than the UI states** — e.g. an
    oversized/unbounded token approval where none is needed → **T1**, scaling up
    by impact;
  - **chain/network confusion** that leads a user to sign on the wrong network
    believing they are on Arbitrum One → **T1**.

Rule of thumb: *connection* problems are out; *interaction* problems that can
cost a user funds are in.

## Severity & rewards

Severity is **impact-based** (roughly funds-at-risk × likelihood). Rewards are
paid in **ETH or USDC**. Amounts below are the **capped-beta starting bands**.
During the capped beta **no single payout exceeds $500** (the program cap); the
bands and the cap rise after the independent audit as the value-at-risk ceiling
is lifted.

| Tier | Class | What lands here | Reward (capped beta) |
|---|---|---|---|
| **T1** | UI / display | A display or labelling bug that could **mislead a user into a losing on-chain action** (e.g. wrong pot/price/reward numbers shown). Pure cosmetic issues are out of scope. | **credit + up to $50** |
| **T2** | Operational / fallback | Keeper/automation failures, the observability events firing (`YieldHarvestFailed`, `PotShareForwardFailed`, …), VRF stall / `rerequest` griefing, **recoverable** settlement/liveness DoS. Value stuck or degraded, not lost. | **$50 – $100** |
| **T3** | Misrouting / contractual | Value routed to the wrong place or mis-split: buyback 5/20/75, lapse 70/30, pot/escrow/refund accounting. Bounded, usually per-round. Off-chain-signaling **governance** manipulation (voting-power/quorum bypass) lands here — real authority is the timelock/multisig, so it cannot directly move funds during beta. **Airdrop:** a duplicate payment to one address (`claimed[]` bypass) or a `perRoundCap` breach — bounded by `totalCap`. | **$100 – $250** |
| **T4** | Token & DEX structural | TIMBS mint/inflate/cap- or transfer-cap-bypass, whitelist bypass, DEX `k`-invariant break, **reward-solvency** break (paying tokens the contract doesn't hold), LP theft. **Airdrop:** draining the distributor float, exceeding `totalCap`, or calling `distribute()` without the dispatcher/owner key or through the pause. | **$250 – $450** |
| **T5** | Deep exploit / drain | Full drain of `PrizeEscrow` / `TimbYieldVault` / `TimbTreasury` / the pair; **prize-outcome manipulation** (predicting or biasing the VRF draw); owner/privilege escalation; chained multi-contract exploit. | **up to $500** (program cap) |

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
  ceiling** that keeps the exploit prize bounded so disclosing still wins.

**The cap and the ceiling move together.** A $500 top bounty only out-competes a
drain while the drainable stock stays roughly at or below it. That makes the
program cap a *discipline on accumulation*: total reachable value (LP + pot +
staked + vault + treasury + the airdrop distributor's float, when that leg is
live) must be held low enough that $500 remains the rational choice over
exploiting. The airdrop float is a *stock* in this sense — it sits in one
contract and a bug takes all of it at once — which is why it is kept small
and topped up in tranches rather than funded to the cap
([`dev-docs/CAPPED_BETA_GUARDRAILS.md` §1](./dev-docs/CAPPED_BETA_GUARDRAILS.md)). When accumulation approaches that line, it is a
graduation trigger — raise the cap and the bands, or tighten the on-chain caps
([`dev-docs/CAPPED_BETA_GUARDRAILS.md`](./dev-docs/CAPPED_BETA_GUARDRAILS.md)).

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
