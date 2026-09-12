# TimbSwap Incentive Design — Timber Points, quests & Sybil resistance

Status: **v0.2 — core decisions locked** (season length, headline levers, airdrop
framing, low-KYC posture). Point weights, caps, and pool sizes below are still a
starting point to tune. Remaining open items are at the end. This spec is the
plan; the tracking backend and the public page are a follow-up build.

**Decisions locked (from founder):**
- Season length: **6 weeks.**
- Season 1 pulls hardest on **volume (swaps / meter nudges)** and **repeat play**;
  hold/LP move to a supporting, Sybil-resistance role.
- The airdrop promise is **eligibility + participation rate** — never a token
  amount, while on testnet.
- **Low-KYC.** The allowlist is *wallets that genuinely played* (behavioral Sybil
  pass). Email is collected **optionally, for a one-time mainnet-transition
  message**, not as a gate. No social/KYC wall on testnet.

---

## 1. Why this exists

Three jobs, one system:

1. **Prove engagement.** The [litepaper](../litepaper/) and `ROADMAP.md` make
   *sustained, real engagement* a gating condition for mainnet — right beside the
   audit and legal gates. A points season is how that evidence gets generated and
   measured: repeat players, eligible volume that tracks rounds, wallets that keep
   coming back.
2. **Build the airdrop allowlist.** The nav already shows **Airdrop · Soon**, and
   the [waitlist](./WAITLIST.md) promises "a priority spot on the airdrop
   allowlist." Points are the fair, legible basis for that allowlist — earned, not
   claimed. **The wallets that actually played are who we carry into the mainnet
   transition.**
3. **Retain attention.** A leaderboard, streaks, and quests are the dopamine loop
   that turns the existing landing traffic (1k+ US / 24h) into repeat sessions
   instead of one-time visits.

### The core principle

> **Never pay for a claim. Only ever reward a behavior you actually want.**

Every point is earned by a **verifiable on-chain action** (a swap that nudged the
meter, a ticket entered, a position staked and *held*). Social actions and email
are **optional bonuses**, capped and one-time — never required, and never the
thing that earns the reward.

---

## 2. Design constraints unique to testnet

Testnet changes the threat model in one decisive way: **gas is ~free, so the
normal economic cost of Sybil attacks is gone.** A naive "1 point per swap" system
gets farmed by one person with 500 scripted wallets in an afternoon, and the
"engagement" you present at the mainnet gate is fiction.

We've also chosen **low identity friction** (little KYC): that's the right call for
growth and conversion, but it means we **cannot** lean on email/social walls to
stop Sybils. So the load shifts onto the levers that still cost something even with
free gas *and* no identity gate:

- **Time** — repeat play across many rounds, and holding a staked/LP position over
  rounds, can't be faked instantly; it costs calendar time.
- **Diversity** — rewarding a *spread* of distinct actions (swap **and** play
  **and** hold) is far harder to script convincingly than one action repeated.
- **Behavioral clustering** — funding-graph and timing analysis catch
  one-human-many-wallets fleets without asking anyone for ID.
- **Human review at the cut line** — only the allowlist *threshold* matters, and
  that thin band can be spot-checked. Farms have to beat scrutiny, not just a
  counter.

Honest tradeoff to hold in mind: **less KYC = more Sybil pressure on the
behavioral layers.** That's an acceptable trade for a testnet season whose payout
is status, not cash — but it's the reason the point weights below deliberately
reward *time and diversity*, not raw click-count, and why the cut line stays
human-reviewed.

---

## 3. The model: Seasons & Timber Points (TP)

- **Timber Points (TP)** are an **off-chain, non-transferable** score kept in a
  Supabase ledger (RLS-hardened, same posture as `faucet_claims` and `waitlist`).
  Off-chain because testnet TP must never become an on-chain asset that itself
  gets farmed or traded, and because scoring rules need to change between seasons.
- **Seasons** are time-boxed at **6 weeks**. A season has a start block, an end
  block, a published rule set, and a final snapshot. The snapshot is what feeds the
  allowlist. Seasons let you retune weights, close exploited quests, and reset
  farms without arguing about retroactive changes.
- **Scoring is a pure function of on-chain history.** A keeper (extend the
  existing GitHub Actions keeper, or a Supabase cron) reads events over the
  season window and (re)computes each wallet's TP. Because it's recomputed from
  chain state, it is **fully auditable and reversible** — if a farm is found, you
  re-run with a patched rule and the leaderboard corrects itself. This mirrors the
  bounty's "recompute from chain" philosophy.

### What TP is not

- Not a token, not transferable, not a promise of a specific airdrop amount.
- Not redeemable on testnet for anything of value (keeps it out of securities-ish
  territory while on testnet; the airdrop's legal treatment is a separate gate).

---

## 4. Earning actions & weights — Season 1 (testnet)

**Season 1 headline levers: volume (swaps / nudges) and repeat play.** Those carry
the most TP and are the actions the streak multipliers (§5) compound. Hold/LP/lock
still earn, but their main job is **Sybil resistance and depth**, not the top of
the board.

Points are **capped per action per period** so repetition alone can't dominate;
the √ curve (below) then tempers volume farming while still rewarding real traders.

| Action | Signal it proves | TP | Cap |
|---|---|---|---|
| First eligible **swap** in a round | real trading that nudges the meter | 12 | once per round |
| Additional eligible **swaps** (volume / nudges) | **headline lever** — volume | 3 each | max 8 / round |
| **Enter a ticket** (play the round) | **headline lever** — repeat play | 15 | once per round |
| **Repeat-play streak** (consecutive rounds) | **headline lever** — retention | multiplier | see §5 |
| **Win the pot** | luck, not skill — kept small so it's not farmed | 25 | per win |
| **Stake TIMBS**, held ≥ 1 full round | committed capital over time (Sybil weight) | 15 | once / round held |
| **Provide LP**, held ≥ 1 full round | liquidity depth over time (Sybil weight) | 25 | once / round held |
| **Lock** in the Lock Vault (≥ 24h) | time commitment (Sybil weight) | 10 | per lock, max 3 / season |
| **Diversity bonus** (≥ 3 distinct action types) | hardest thing to Sybil (see §5) | +15% total | once / season |
| Verified **Telegram** join | community (optional bonus) | 15 | once ever |
| Verified **X** follow / repost of pinned | reach (optional bonus) | 15 | once ever |
| **Email** captured via waitlist | comms channel for the mainnet message (optional) | 10 | once ever |
| **Referral** that reaches "activated" (§6) | growth | 40 | max 25 / season |
| **Valid bug-bounty** report (any tier) | security contribution | 100–500 | per accepted report |

Note the emphasis: a wallet that **trades across many rounds and keeps playing**
climbs fastest; the social/email lines are small, optional toppings, never the
path to the top.

### Diminishing returns (anti-whale, anti-farm)

Because **volume is a headline lever**, it needs a brake so a script can't win by
brute force. Raw TP from *volume-like* actions (swaps beyond the first, extra
nudges) passes through a **square-root curve** before it hits the leaderboard:

```
displayTP  =  Σ(one-time & per-round TP)  +  k · √(Σ volume TP)
```

A genuine high-volume trader still ranks well above a casual one, but the 500th
scripted swap is worth a sliver of the 5th. `k` is tuned so the curve starts
biting above ~the 90th percentile of honest per-wallet volume.

---

## 5. Streaks & multipliers — the repeat-play engine

Repeat play is a headline lever *and* the hardest signal to fake, so it gets the
strongest multiplier:

- **Round streak.** Enter a ticket or make an eligible swap in **N consecutive
  rounds** → a multiplier on that period's earned TP: **×1.15 at 3 rounds, ×1.35 at
  6, ×1.6 at 12.** Miss a round → streak resets (1-round grace so a keeper/RPC
  hiccup doesn't punish honest players).
- **Diversity bonus.** A wallet that has done **≥ 3 of {swap, ticket, stake, LP,
  lock}** in a season gets **+15%** on total TP. With low KYC this is the single
  most important anti-Sybil weight — a convincing fake has to reproduce a
  *portfolio* of behaviors over time, not spam one action from many keypairs.

Together these make the winning strategy "show up, trade, and play, round after
round" — exactly the engagement the mainnet gate wants to see.

---

## 6. Referrals — growth without the farm

Referrals are the highest-abuse surface, so they pay **only on activation**, never
on signup:

- A referral link carries the referrer's code (reuse the `ref`/UTM capture already
  in [`waitlist.js`](../waitlist.js)).
- The referred wallet counts as **"activated"** only after it independently clears
  a real bar: **entered ≥ 2 rounds AND made eligible swaps in ≥ 2 rounds** (a
  volume/repeat-play bar, matching the season's levers). No activation → no
  referral TP, ever.
- Referrer earns **40 TP per activated referral, capped at 25/season** (self-
  referral and A↔B reciprocal rings are filtered by the Sybil pass in §7).
- The referred user gets a small **welcome bonus** (25 TP) on activation — both
  sides win, but only for real engagement.

---

## 7. Sybil resistance (low-KYC edition)

With little identity friction by design, resistance is **behavioral, not
identity-based.** Points are computed permissively, then a **Sybil pass** discounts
or disqualifies before the allowlist snapshot.

| Layer | Mechanism | Stops |
|---|---|---|
| **Cost-to-fake weighting** | time + diversity dominate the table (§4–5); volume is √-curved | one-action spam farms |
| **√ curve + per-period caps** | volume can't run away; repetition saturates | whales & single-action grinders |
| **First-seen / wallet age** | wallets first active *after* a season milestone earn at a reduced rate; brand-new burst wallets are flagged | mass wallet minting |
| **Funding-graph clustering** | wallets funded from one source, or moving funds in rings, are scored as one | one-human-many-wallets |
| **Timing correlation** | wallets acting in lockstep (same blocks, same sequence) are clustered | scripted fleets |
| **Faucet-cooldown signal** | the faucet's per-address history is a cheap liveness/uniqueness hint | throwaway wallets |
| **Referral ring filter** | reciprocal / self / same-cluster referrals don't pay | referral farms |
| **Human review of the cut line** | only wallets near the allowlist threshold are spot-checked | anything that beat the automated layers |

**Key stance:** the automated layers don't need to be perfect. They only need to be
good enough that the **cut line** for the allowlist is reviewable by a human in an
afternoon. Because email/social are optional (not gates), they act as *soft
positive signals* in review — a wallet with a confirmed email + a coherent play
history is lower-risk — but their absence never disqualifies a wallet that clearly
played. Sybil resistance here is a *cost-imposition* game, not a solved-perfectly
game.

---

## 8. Airdrop allowlist — eligibility & participation rate

Per the locked decision, TP does **not** map to token amounts. It establishes
**eligibility** and a **participation rate**, and those are all we publish while on
testnet:

- **Eligible = wallets that genuinely played** — cleared a minimum of the headline
  actions (volume + repeat play), earned the diversity bonus, and passed the Sybil
  pass (§7). That's the bar. No email, no social, no KYC required to be eligible.
- **Participation rate** — each eligible wallet gets a published *rate* (e.g. its
  TP percentile, or a banded score like Bronze/Silver/Gold), **not** a promised
  amount. This is the honest, defensible thing to say now; the actual distribution
  math is a post-audit, post-legal decision.

| Band | Requirement (illustrative) | Meaning |
|---|---|---|
| **Eligible** | ≥ min TP from headline actions **AND** diversity bonus **AND** clean Sybil pass | on the list |
| **Active** | above the season median TP among eligible wallets | higher participation rate |
| **OG** | eligible from the first 2 weeks, top decile, spotless Sybil pass | highest rate + a role/badge |

- The allowlist is published as **hashed wallet commitments** so anyone can verify
  their own inclusion without you publishing a wallet↔identity map.
- **Email is for the transition, not the gate.** Emails captured via the
  [waitlist](./WAITLIST.md) (and the optional email line in §4) exist so you can
  send **one message** — "mainnet is opening, here's your Season 1 standing / how
  to claim" — to the wallets that played. A wallet with no email is still eligible;
  it just won't get the courtesy email nudge.
- **KYC stays deferred.** None on testnet. If a real-value mainnet airdrop later
  requires it for a *payout*, that check happens at claim time for the amounts that
  need it — not as a barrier to earning or to being on the list.

> **Never promise a specific token amount or a guaranteed airdrop while on
> testnet.** Promise *eligibility and a participation rate*; the distribution is a
> post-audit, post-legal decision. The site copy already follows this — keep it so.

---

## 9. Mainnet real-value incentives (post-launch)

When mainnet is live and gas costs real money, Sybil economics flip back in your
favor and you can switch on the **real-ETH levers** — each one paying for a
*behavior*, from a **hard-capped** pool, never an open faucet:

1. **Gas rebate.** Refund gas (in ETH) on a new user's **first N real swaps**
   (e.g. N=3), capped per wallet and by a weekly pool ceiling. Removes first-tx
   friction; bounded, and Sybil-costly because each fake now pays real gas.
2. **Trading competition.** A fixed ETH prize pool, weekly, leaderboard by
   *eligible volume* (your headline lever) with the same √-curve and Sybil pass.
   Marketing spend with a measurable output.
3. **Referral rewards.** Small ETH per referral that reaches real volume (same
   activation gate as §6), capped per referrer.
4. **LP incentive top-up.** A small, time-boxed ETH/TIMBS boost to bootstrap farm
   depth at launch, inside the existing waterfall's solvency rules.

Each pool gets a **published cap** and an **end date** up front. The no-brainer:
every dollar buys a named on-chain action (a swap, a filled pool, a referred
trader) you can count — not a claim.

---

## 10. Tooling — build vs. buy (low budget)

| Option | What it is | Cost | Fit |
|---|---|---|---|
| **Self-host on Supabase** | a `points` schema + a keeper that scores chain events; a `/quests` page on the site | ~free (your stack) | authoritative TP ledger, full control of weights + Sybil rules |
| **Galxe / Layer3** | quest campaigns with on-chain verification, a ready quester audience | freemium; campaign fees | one launch *discovery* campaign for reach |
| **Guild.xyz** | optional TG/Discord role-gating on TP or on-chain requirements | free | optional community roles — **not** a required gate (low-KYC) |

**Recommendation:** self-host the **TP ledger + scoring** (you already run Supabase
+ a keeper + the same-origin Worker — the incremental cost is one schema and one
scoring job); run **one Galxe/Layer3 campaign** at season start for reach; use
**Guild.xyz only for optional roles**, consistent with the low-KYC stance. Keep the
authoritative score in your own ledger so nobody else owns your allowlist.

---

## 11. Budget & the "no-brainer" math

- **Testnet season: ~$0 in incentive payout.** The reward is TP + allowlist
  standing + status, not cash. Your only spend is optional: the small bug-bounty
  pool (already scoped) and maybe one paid Galxe campaign for reach. You are buying
  *proven engagement* — the mainnet gate — for close to nothing.
- **Mainnet: every ETH is a measured action.** Gas rebates, comps and referrals
  are capped pools tied to swaps/volume/referrals. You set the ceiling; you can't
  overspend; each unit maps to a KPI (activated wallets, eligible volume).
- **The compounding effect:** testnet TP → allowlist → the airdrop everyone's
  playing toward → sustained volume that funds the real engine (the litepaper's
  loop). Attention captured now becomes the liquidity and volume that make mainnet
  credible.

---

## 12. Rollout plan

1. **Foundations (done / in flight).** Waitlist capture ✓, bug bounty ✓. These are
   the contact + contribution rails TP builds on.
2. **Season 0 — "Genesis" soft-launch (1–2 wks).** Publish the rules and a
   read-only leaderboard scored from existing events; no allowlist commitment yet.
   Purpose: shake out the scoring keeper and the Sybil pass on real data.
3. **Season 1 — the real season (6 wks).** Full point table, streak engine,
   referrals, the `/quests` page, one Galxe discovery campaign. Ends with a
   published, hashed allowlist snapshot + participation rates.
4. **Mainnet switch.** After the audit + legal gates: send the one-time transition
   email to wallets that played; turn on gas rebate + trading comp + referral
   pools; carry OG/Active bands into airdrop weighting.

---

## 13. Integration map

- **Waitlist** (`supabase/functions/waitlist`, `waitlist.js`) → the email captured
  for the **one-time mainnet-transition message**, and the `ref`/UTM capture reused
  for referrals. Email is a comms channel, not an allowlist gate.
- **Faucet** (`GasFaucet.sol`, `supabase/migrations/*faucet*`) → onboarding step
  before a wallet can act; its per-address cooldown is a Sybil signal.
- **On-chain events** → the scoring source of truth (swaps, ticket entries, stakes,
  LP, locks, wins). Same events the analytics page and keeper already read.
- **Keeper** (GitHub Actions) → extend to run the seasonal TP scoring job, or add a
  Supabase cron.
- **Worker** (`workers/timbswap-api.js`) → add a same-origin `/api/quests` read
  route for the leaderboard (first-party, Brave-safe, same pattern as `/api/rpc`
  and `/api/waitlist`).
- **Bounty** (`/bounty/`, `SECURITY.md`) → valid reports grant TP; researchers flow
  into the same allowlist.

---

## 14. Status of decisions

**Locked:**
1. Season length — **6 weeks.**
2. Headline levers — **volume (swaps/nudges) + repeat play**; hold/LP as supporting
   Sybil weight.
3. Airdrop framing — **eligibility + participation rate**, never an amount, on
   testnet.
4. Identity — **low-KYC**; allowlist = wallets that played (behavioral Sybil pass);
   email optional, collected for the one-time mainnet-transition message.

**Still open (for later):**
5. **Tooling green-light** — confirm self-host TP + one Galxe campaign + optional
   Guild roles.
6. **Mainnet pool sizes** — ballpark caps for gas-rebate / comp / referral, to be
   spec'd as the mainnet gate nears.
7. **Exact thresholds** — the min-TP cut line, √-curve `k`, and band boundaries are
   best set empirically off Season 0 data rather than guessed now.

---

*Next build once you green-light: the Supabase `points` schema + the scoring keeper
+ a public `/quests/` leaderboard page (same design system as `/bounty/`), plus the
Galxe campaign setup.*
