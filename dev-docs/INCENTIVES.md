# TimbSwap Incentive Design — Timber Points, quests & Sybil resistance

Status: **proposal / v0.1.** Point weights, caps, and pool sizes below are a
starting point to tune, not settled values. Open founder decisions are listed at
the end. This spec is the plan; the tracking backend and the public page are a
follow-up build.

---

## 1. Why this exists

Three jobs, one system:

1. **Prove engagement.** The [litepaper](../litepaper/) and `ROADMAP.md` make
   *sustained, real engagement* a gating condition for mainnet — right beside the
   audit and legal gates. A points season is how that evidence gets generated and
   measured: repeat players, held positions, eligible volume that tracks rounds.
2. **Build the airdrop allowlist.** The nav already shows **Airdrop · Soon**, and
   the [waitlist](./WAITLIST.md) promises "a priority spot on the airdrop
   allowlist." Points are the fair, legible basis for that allowlist — earned, not
   claimed.
3. **Retain attention.** A leaderboard, streaks, and quests are the dopamine loop
   that turns the existing landing traffic (1k+ US / 24h) into repeat sessions
   instead of one-time visits.

### The core principle

> **Never pay for a claim. Only ever reward a behavior you actually want.**

Every point is earned by a **verifiable on-chain action** (a swap that moved the
meter, a ticket entered, a position staked and *held*), or by a **verified social
action** (join TG, follow X) that is capped and one-time. Nothing is paid for
merely connecting a wallet or clicking a button.

---

## 2. Design constraints unique to testnet

Testnet changes the threat model in one decisive way: **gas is ~free, so the
normal economic cost of Sybil attacks is gone.** A naive "1 point per swap" system
gets farmed by one person with 500 scripted wallets in an afternoon, and the
"engagement" you present at the mainnet gate is fiction.

So the whole design leans on the levers that *still cost something even when gas
is free*:

- **Time** — holding a staked/LP position across many rounds can't be faked
  instantly; it costs calendar time.
- **Diversity** — requiring a *spread* of distinct actions (swap **and** stake
  **and** play **and** hold) is far harder to script convincingly than one action
  repeated.
- **Identity friction** — one verified email (via the [waitlist](./WAITLIST.md))
  and one verified social handle per allowlist slot raises the cost of a fake
  from "a new keypair" to "a new inbox + a new Telegram/X account."
- **Human review at the top** — only the allowlist *cut line* matters for the
  airdrop, and that cut can be reviewed, so farms have to beat scrutiny, not just
  a counter.

These are woven through the point weights and the allowlist gating below, not
bolted on.

---

## 3. The model: Seasons & Timber Points (TP)

- **Timber Points (TP)** are an **off-chain, non-transferable** score kept in a
  Supabase ledger (RLS-hardened, same posture as `faucet_claims` and `waitlist`).
  Off-chain because testnet TP must never become an on-chain asset that itself
  gets farmed or traded, and because scoring rules need to change between seasons.
- **Seasons** are time-boxed (propose **6 weeks** for Season 1). A season has a
  start block, an end block, a published rule set, and a final snapshot. The
  snapshot is what feeds the allowlist. Seasons let you retune weights, close
  exploited quests, and reset farms without arguing about retroactive changes.
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

Points are **capped per action per period** so repetition alone can't dominate;
depth and diversity win. All actions are read from existing on-chain events.

| Action | Signal it proves | TP | Cap |
|---|---|---|---|
| First eligible **swap** in a round | real trading that moves the meter | 10 | once per round |
| Additional eligible swaps in a round | volume | 2 each | max 5/round |
| **Enter a ticket** (play a round) | game engagement | 15 | once per round |
| **Win the pot** | — (luck, not skill; small so it's not farmed) | 25 | per win |
| **Stake TIMBS** and hold ≥ 1 full round | committed capital over time | 20 | once per round held |
| **Provide LP** and hold ≥ 1 full round | liquidity depth over time | 30 | once per round held |
| **Lock** in the Lock Vault (≥ 24h) | time commitment | 15 | per distinct lock, max 3/season |
| **Hold-streak bonus** (see §5) | sustained presence | multiplier | — |
| Verified **Telegram** join | community | 20 | once ever |
| Verified **X** follow / repost of pinned | reach | 20 | once ever |
| **Waitlist** email confirmed | owned contact | 15 | once ever |
| **Referral** that reaches "activated" (see §6) | growth | 40 | max 25/season |
| **Valid bug-bounty** report (any tier) | security contribution | 100–500 | per accepted report |

Weighting logic: the **held-over-time** actions (stake/LP/lock) and **diverse
play** (swap + ticket + hold) are worth the most per unit of Sybil effort;
one-shot social actions are capped one-time; luck (winning) is deliberately small.

### Diminishing returns (anti-whale, anti-farm)

Raw TP from *volume-like* actions is passed through a **square-root curve** before
it hits the leaderboard: `displayTP = Σ(one-time TP) + k·√(Σ volume TP)`. This
keeps a genuine power user ahead of a casual one, but stops a farm (or a whale)
from running away with the board by brute-forcing the same action. `k` is tuned so
the curve bites above roughly the 90th-percentile of honest activity.

---

## 5. Streaks & multipliers

Presence over time is the hardest thing to fake, so reward it:

- **Round streak.** Enter a ticket or hold a position in **N consecutive rounds**
  → a multiplier on that period's earned TP: ×1.1 at 3 rounds, ×1.25 at 6, ×1.5 at
  12. Miss a round → streak resets (grace of 1 round to avoid punishing keeper/RPC
  hiccups).
- **Diversity bonus.** A wallet that has done **≥ 3 of {swap, ticket, stake, LP,
  lock}** in a season gets a flat **+15%** on total TP. This is the single most
  effective anti-Sybil weight — a convincing fake has to reproduce a *portfolio*
  of behaviors, not spam one.

---

## 6. Referrals — growth without the farm

Referrals are the highest-abuse surface, so they pay **only on activation**, never
on signup:

- A referral link carries the referrer's code (reuse the `ref`/UTM capture already
  in [`waitlist.js`](../waitlist.js)).
- The referred wallet counts as **"activated"** only after it independently clears
  a real bar: e.g. **entered ≥ 2 rounds AND holds a stake/LP position for ≥ 1
  round.** No activation → no referral TP, ever.
- Referrer earns **40 TP per activated referral, capped at 25/season** (self-
  referral and A↔B reciprocal rings are filtered by the Sybil pass in §7).
- The referred user gets a small **welcome bonus** (e.g. 25 TP) on activation — so
  both sides win, but only for real engagement.

---

## 7. Sybil resistance

Layered, because no single check is enough on a free-gas network. Points are
computed permissively, then a **Sybil pass** discounts or disqualifies before the
allowlist snapshot.

| Layer | Mechanism | Stops |
|---|---|---|
| **Cost-to-fake weighting** | held-over-time + diversity dominate the point table (§4–5) | one-action spam farms |
| **√ curve + per-period caps** | volume can't run away; repetition saturates | whales & single-action grinders |
| **First-seen / wallet age** | wallets first active *after* a season milestone earn at a reduced rate; brand-new burst wallets are flagged | mass wallet minting |
| **Funding-graph clustering** | wallets funded from one source, or that move funds in rings, are clustered and scored as one | one-human-many-wallets |
| **Timing correlation** | wallets acting in lockstep (same blocks, same sequence) are clustered | scripted fleets |
| **Identity gate for the allowlist** | allowlist eligibility requires a **confirmed waitlist email + one verified social** per slot | cheap keypair Sybils |
| **Referral ring filter** | reciprocal / self / same-cluster referrals don't pay | referral farms |
| **Human review of the cut line** | only wallets near the allowlist threshold are manually spot-checked | anything that beat the automated layers |

**Key stance:** the automated layers don't need to be perfect. They only need to
be good enough that the **cut line** for the airdrop allowlist is reviewable by a
human in an afternoon. Sybil resistance is a *cost-imposition* game, not a
solved-perfectly game.

---

## 8. Airdrop allowlist — how TP converts

TP does **not** map linearly to tokens. It gates **tiers**, and the tiers are what
an eventual airdrop weights. This decouples "who's eligible" (legible, defensible)
from "how much" (decided later, with legal counsel, at mainnet):

| Tier | Requirement (illustrative) | Meaning |
|---|---|---|
| **Allowlisted** | ≥ min TP **AND** diversity bonus earned **AND** identity gate cleared | on the list |
| **Core** | top ~40% of allowlisted by TP | higher weight |
| **OG** | active in Season 1 from the first 2 weeks, top decile, clean Sybil pass | highest weight + a role/badge |

- **Eligibility is thresholds + identity, not a raw score race** — this is what
  keeps it Sybil-defensible and fair to normal users.
- The allowlist is published as **hashed wallet commitments** (so people can
  verify inclusion without you publishing a full email↔wallet map).
- Ties directly into the [waitlist](./WAITLIST.md): the `waitlist` table already
  captures email + optional wallet; the allowlist snapshot is a join of *confirmed
  waitlist identity* × *TP tier* × *Sybil pass*.

> **Never promise a specific token amount or a guaranteed airdrop while on
> testnet.** Promise *eligibility and weighting*; the actual distribution is a
> post-audit, post-legal decision. The site copy already follows this — keep it
> that way.

---

## 9. Mainnet real-value incentives (post-launch)

When mainnet is live and gas costs real money, Sybil economics flip back in your
favor and you can switch on the **real-ETH levers** — each one paying for a
*behavior*, from a **hard-capped** pool, never an open faucet:

1. **Gas rebate.** Refund gas (in ETH) on a new user's **first N real swaps**
   (e.g. N=3), capped per wallet and by a weekly pool ceiling. Removes the
   first-tx friction; bounded and Sybil-costly because each fake now pays real gas.
2. **Trading competition.** A fixed ETH prize pool, weekly, leaderboard by
   *eligible volume* with the same √-curve and Sybil pass. Pure marketing spend
   with a measurable output (volume).
3. **Referral rewards.** Small ETH per referral that reaches real volume (same
   activation gate as §6), capped per referrer.
4. **LP incentive top-up.** A small, time-boxed ETH/TIMBS boost to the farm to
   bootstrap depth at launch, inside the existing waterfall's solvency rules.

Each pool gets a **published cap** and an **end date** up front. The no-brainer:
every dollar buys a named on-chain action (a swap, a filled pool, a referred
trader) you can count — not a claim.

---

## 10. Tooling — build vs. buy (low budget)

| Option | What it is | Cost | Fit |
|---|---|---|---|
| **Guild.xyz** | token/role-gating + on-chain requirement checks, Discord/TG roles | free | great for the *identity gate* + social roles |
| **Galxe / Layer3** | quest campaigns with on-chain verification, big discovery audience | freemium; campaign fees | great for *reach* + a ready hunter/quester crowd |
| **Self-host on Supabase** | a `points` schema + a keeper that scores chain events; a `/quests` page on the site | ~free (your stack) | full control of weights, Sybil rules, and the ledger |

**Recommendation:** self-host the **TP ledger + scoring** (you already run Supabase
+ a keeper + the same-origin Worker — the incremental cost is one schema and one
scoring job), and use **Guild.xyz** for the social/identity gate and
**Galxe/Layer3** for one launch *discovery* campaign to import an audience. Keep the
authoritative score in your own ledger so nobody else owns your allowlist.

---

## 11. Budget & the "no-brainer" math

- **Testnet season: ~$0 in incentive payout.** The reward is TP + allowlist
  standing + status, not cash. Your only spend is optional: a small bounty pool
  (already scoped) and maybe one paid Galxe campaign for reach. You are buying
  *proven engagement* — the mainnet gate — for close to nothing.
- **Mainnet: every ETH is a measured action.** Gas rebates, comps and referrals
  are capped pools tied to swaps/volume/referrals. You set the ceiling; you can't
  overspend; and each unit maps to a KPI (activated wallets, eligible volume).
- **The compounding effect:** testnet TP → allowlist → the airdrop everyone's
  farming toward → sustained volume that funds the real engine (the litepaper's
  loop). Attention captured now becomes the liquidity and volume that make mainnet
  credible.

---

## 12. Rollout plan

1. **Foundations (done / in flight).** Waitlist capture ✓, bug bounty ✓. These are
   the identity + contribution rails TP builds on.
2. **Season 0 — "Genesis" soft-launch (1–2 wks).** Publish the rules and a
   read-only leaderboard scored from existing events; no allowlist commitment yet.
   Purpose: shake out the scoring keeper and the Sybil pass on real data.
3. **Season 1 — the real season (6 wks).** Full point table, streaks, referrals,
   the `/quests` page, Guild identity gate, one Galxe discovery campaign. Ends with
   a published, hashed allowlist snapshot.
4. **Mainnet switch.** After the audit + legal gates: turn on gas rebate + trading
   comp + referral pools; carry OG/Core tiers into airdrop weighting.

---

## 13. Integration map

- **Waitlist** (`supabase/functions/waitlist`, `waitlist.js`) → identity + the
  email↔wallet link the allowlist joins on. Referral `ref`/UTM capture already
  exists.
- **Faucet** (`GasFaucet.sol`, `supabase/migrations/*faucet*`) → the onboarding
  step before a wallet can act; its per-address cooldown is a useful Sybil signal.
- **On-chain events** → the scoring source of truth (swaps, ticket entries, stakes,
  LP, locks, wins, buybacks). Same events the analytics page and keeper already
  read.
- **Keeper** (GitHub Actions) → extend to run the seasonal TP scoring job, or add a
  Supabase cron.
- **Worker** (`workers/timbswap-api.js`) → add a same-origin `/api/quests` read
  route for the leaderboard (first-party, Brave-safe, same pattern as `/api/rpc`
  and `/api/waitlist`).
- **Bounty** (`/bounty/`, `SECURITY.md`) → valid reports grant TP; researchers flow
  into the same allowlist.

---

## 14. Open decisions (founder input needed)

1. **Season length & start** — 6 weeks proposed; when does Season 0 open?
2. **Point weights** — the §4 table is a starting proposal; which actions do you
   most want to pull? (Volume? Liquidity depth? Repeat play?)
3. **Airdrop framing** — confirm we only ever promise *eligibility + weighting*,
   never an amount, while on testnet. (Strongly recommended.)
4. **Identity gate strictness** — require *both* email and a social for the
   allowlist, or email only? (Both = far stronger Sybil resistance, slightly more
   friction.)
5. **Tooling** — green-light self-host TP + Guild + one Galxe campaign?
6. **Mainnet pool sizes** — ballpark caps for gas-rebate / comp / referral, so the
   pools can be spec'd when the mainnet gate is near.

---

*Once the weights and the open decisions are settled, the follow-up build is: the
Supabase `points` schema + the scoring keeper + a public `/quests/` leaderboard
page (same design system as `/bounty/`), plus the Guild/Galxe setup.*
