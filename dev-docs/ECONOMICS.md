# TimbSwap Token Economics

Status: **v0.1 planning model.** Numbers marked *(placeholder)* exist so the model
is concrete to react to, not because they're settled. This models **mechanics and
affordability** — it is **not** legal, tax, or investment advice; token
distribution has securities / tax / geofencing implications the litepaper already
makes mainnet gates, handled by counsel separately.

Public-messaging rail throughout: we promise **eligibility + participation rate**,
never a token amount or price, while on testnet.

---

## 1. The two spines

Keep these separate and the whole thing stays simple:

- **The token** — 100M TIMBS, hard cap, **minted once at genesis** to the
  treasury / Gnosis Safe, then **time-released on a halving schedule**. Divided
  one time (below). This is *stock*.
- **The flow** — swap fees (0.05% to treasury) + buybacks recycle value forever,
  never printing new supply, bounded by the 99%-of-obligations solvency stop.
  This is what makes rewards sustainable once volume is real. This is *flow*.

Everything below is about dividing the stock and pacing its release.

---

## 2. Genesis allocation (the 100M)

| Bucket | Share | TIMBS | Role |
|---|---|---|---|
| **Farm + Staking rewards** | 30% | 30,000,000 | emission fuel for the reward pools, released on the halving cadence |
| **Airdrop causes** | 20% | 20,000,000 | the two-phase distribution (§4) |
| **Treasury reserve** | 30% | 30,000,000 | buybacks, mainnet incentive pools, ops, contingency — **and founder/team comp** |
| **LP (locked)** | 20% | 20,000,000 | launch liquidity, paired with ETH, LP tokens locked |

**Founder / team comp comes out of the 30% treasury reserve** as a *dilutable*
portion — not a separate mint, not a fifth bucket. Exact size is deferred until
the team is defined. Doing it this way keeps one honest property: **there is no
hidden team allocation** — every token a contributor receives is visibly drawn
from the transparent, on-chain treasury, and it dilutes against everything else
in that reserve rather than expanding supply.

---

## 3. Release schedule (halving, time-based)

Supply is **not** emitted per round — it is minted at genesis and *unlocked* on a
halving schedule. Each era releases half the previous era's tokens; the series
sums to the 100M cap, approached asymptotically (a true hard cap — a dust tail is
always still locked, Bitcoin-style).

| Era | Released | Over | Cumulative | ≈ Calendar* |
|---|---|---|---|---|
| 1 | 50M | 1,000 rounds | 50M (50%) | ~8 months |
| 2 | 25M | 1,000 rounds | 75M (75%) | ~8 months |
| 3 | 12.5M | 2,000 rounds | 87.5M | ~16 months |
| 4 | 6.25M | ~4,000 rounds *(placeholder tail)* | 93.75M | ~33 months |
| … | halving | doubling | → 100M | tail |

\**Assumes a ~6-hour round (per SECURITY.md's "6-hour round frame"). Round
duration is the single dial that turns rounds into a calendar — confirm it before
publishing any timeline.*

**The headline: ~50% of all TIMBS releases in Era 1 (~8 months).** This
front-loading is the most valuable feature of the whole design — see §7.

> **Reconciliation to finalize at deploy.** Two lenses describe the same 100M:
> the §2 allocation split and this release curve. The clean mapping: **LP's 20M
> is locked at genesis (one-time, not on the curve)**, and the **80M of
> farm/staking + airdrop + treasury releases on the halving curve**. Whether the
> "50M in Era 1" figure is measured against 100M or against the 80M ex-LP is a
> bookkeeping choice to lock when the vesting contract / schedule is set. The
> model's conclusions don't change; the exact per-era per-bucket numbers do.

---

## 4. The airdrop (20M), two concurrent phases

### Phase 1 — daily drip (habit loop, NOT the distribution)
- **1 TIMBS claimable per wallet per 24h.**
- Purpose: a daily-return habit and a soft onboarding reward — *candy*, not the
  prize. At 1/day it is a rounding error against 20M, by design.

> **FIREWALL (critical): drip claims MUST NOT count toward mainnet eligibility.**
> On free-gas testnet a 1-token/day faucet is trivially Sybil-farmed (one person,
> 1,000 wallets). That is fine **only** because eligibility for the Phase-2 bulk
> is decided by **quest TP — real wallet activity** (see INCENTIVES.md), never by
> drip claims. If drip-claims ever fed eligibility, the entire Sybil design
> collapses. Keep the two ledgers separate.

### Phase 2 — bulk transition airdrop (the real distribution)
- At the **testnet → mainnet transition**, eligible participants (the quest
  allowlist, Sybil-passed) receive a **bulk airdrop** of real TIMBS from the 20M
  bucket, **weighted by tier** (OG > Active > Eligible).
- Reserve the large majority of the 20M here (e.g. ~18M *(placeholder)*), with a
  slice held for the ongoing drip.
- This is the payoff that makes Season 1 worth playing — and it flows straight
  from the incentive system already built: TP → tier → bulk weight.

---

## 5. LP & launch price — the one honest tension

20% in LP is **deep** liquidity (low slippage, credible), but the launch price is
purely **ETH paired ÷ 20M TIMBS** — so it's gated by how much real ETH you can
seed. There is no way around this; it's arithmetic.

| ETH seeded | Price / TIMBS | Implied FDV | Avg bulk value* |
|---|---|---|---|
| 2 ETH | ~$0.0003 | ~$30k | ~$3 |
| 5 ETH | ~$0.00075 | ~$75k | ~$7 |
| 10 ETH | ~$0.0015 | ~$150k | ~$14 |

\**ETH ≈ $3,000; ~18M bulk ÷ ~2,000 allowlisted ≈ 9k TIMBS avg; OG tier several×.
All placeholders.*

Modest is fine and honest for a fair launch — **the front-load narrative is a
stronger hook than a big FDV** (§7). But the ETH-for-liquidity budget is the real
lever on "what a tier is worth," and it's the number worth nailing down. Locking
LP tokens (e.g. via TimbLockVault or a timelock) is what makes the depth credible
rather than a rug vector.

---

## 6. Flow: does it fund itself? (treasury runway)

- Emissions (farm/staking) draw from the **30M reward allocation** on the release
  schedule; the **99% solvency stop** guarantees the contracts never promise
  tokens they don't hold (fact, on-chain).
- The self-funding flywheel (0.05% fee → treasury → buybacks) **only spins once
  volume is real.** Until then, incentives are funded from *reserve*, not fees.
- So **treasury runway** is a real number, not an assumption: at a chosen mainnet
  incentive-spend rate (gas rebate / comps, capped — INCENTIVES §9), how many
  months does the 30M treasury + accumulating fees last? Size the incentive pools
  against that, not against hope. Every mainnet incentive pool gets a published
  cap and end date.

---

## 7. Why this shape is a marketing weapon

- **Front-load = built-in urgency.** "~50% of all TIMBS releases in Era 1, and
  Era 1 is happening now" is truer and sharper than any teased number. It is the
  spine of the quest season and the launch thread — you don't manufacture FOMO,
  the schedule provides it.
- **Fixed cap + no hidden team + earned-not-printed** is a clean, verifiable
  story for the skeptics (the same audience the bug bounty and open-source repo
  speak to).
- **Daily drip = retention** — a reason to open the app every day, independent of
  whether a round is exciting that hour.

Public copy stays on the rail: promise *eligibility and participation rate*,
never a price or an amount, while on testnet.

---

## 8. What a wallet's standing is worth (the model in one line)

```
bulk airdrop $ for a wallet
  = (its tier weight / total tier weight across allowlist)
      × bulk pool (~18M TIMBS placeholder)
      × launch price (ETH seeded / 20M)
```

Set {ETH seed, bulk pool size, tier weights, allowlist size} and this resolves to
a dollar range per tier. Everything upstream — point weights, the √-curve, the
diversity bonus — is what decides a wallet's *tier weight*; this line turns that
into value.

---

## 9. Open items (to settle before mainnet)

1. **Schedule reconciliation** — LP-at-genesis vs. on-curve, and whether the era
   figures are of 100M or of the 80M ex-LP (§3). A deploy/vesting-contract detail.
2. **ETH seed for LP** — the real budget lever on launch price and tier value (§5).
3. **Bulk vs. drip split of the 20M**, and whether the daily drip **continues on
   mainnet** (ongoing slow distribution) or ends at the transition.
4. **Founder/team comp size** from the treasury reserve — deferred until the team
   is defined; decide the vesting shape (cliff + linear) when it is.
5. **Round duration** confirmation — turns the release eras into a real calendar.
6. **Mainnet incentive-pool caps** sized against the §6 treasury runway.

---

*This model is the "can we afford it / is it fair" layer. It pairs with
INCENTIVES.md (how standing is earned) and QUESTS_DEPLOY.md (how it's scored).
Legal treatment of the distribution is a separate, gating workstream.*
