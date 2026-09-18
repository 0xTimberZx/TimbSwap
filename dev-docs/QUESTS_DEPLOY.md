# Timber Points / Quests — deploy & season runbook

The incentive system from [`INCENTIVES.md`](./INCENTIVES.md), in three parts on
rails the app already runs:

| Part | File(s) | Role |
|------|---------|------|
| Ledger | `supabase/migrations/20260912100000_points.sql` (+ `..110000_points_v2.sql`) | seasons, per-wallet scores, TP formula (in SQL) |
| Scorer | `scripts/points-scorer.js` + `.github/workflows/points-scorer.yml` | hourly keeper that folds new on-chain activity in |
| Read | `supabase/functions/quests` → Worker `POST /api/quests` → `/quests/` page | public leaderboard + "check my rank" |

Scoring is **incremental**: the keeper only scans blocks/rounds after the season's
cursors, so an hourly cron stays cheap across a 6-week season. The **TP formula
lives in SQL** (`points_recompute`) — retune weights there without redeploying the
keeper; the next run recomputes every wallet.

## What earns TP

See **Scoring (v3)** below — flat per-event points with a four-round settlement
lag, weights in `seasons.weights`. The original √-volume / streak-multiplier
formula (v1–v2) was replaced on Sep 18 2026 before any public season scored.

## Deploy (one-time)

### 1. Database
```sh
supabase db push          # applies both points migrations (seeds a DRAFT season-0)
```

### 2. Read function
```sh
supabase functions deploy quests --no-verify-jwt
# SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected.
```

### 3. Worker route
```sh
cd workers
# Set the upstream in wrangler.toml [vars]:
#   QUESTS_UPSTREAM = "https://<supabase-ref>.supabase.co/functions/v1/quests"
npx wrangler deploy
```

### 4. Scorer keeper
Add repo **Actions secrets** (reuse the ones the other keepers use):
`ARB_SEPOLIA_RPC` (prefer a keyed endpoint for wide `getLogs`), `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, and optionally `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.
The workflow runs hourly and on `workflow_dispatch`.

The scorer reads contract addresses from `config.js` by name
(`TimbPrize`, `GameRegistry`, `TimbsEthPair`, and — optionally — `TimbStaking`,
`TimbFarm`, `TimbBoostFarm`, `TimbLockVault`). A module missing from `config.js`
is **skipped**, not fatal, so scoring still runs on the modules that are wired.

## Open a season

Seasons start as `draft`. To open one, set its window and flip it to `active`
(SQL editor / `psql`):
```sql
update seasons set
  status      = 'active',
  start_block = <current Arbitrum block>,
  start_round = <current prize round>
where slug = 'season-0';
```
The next scorer run begins folding activity from that block/round. Tune
`k_curve` (volume √ coefficient) and `min_rounds` on the same row.

To **end** a season: `update seasons set status='ended', end_block=<block> where slug=...;`
The scorer stops at `end_block`; the final table is the snapshot for the allowlist.

## Scoring (v3, Sep 18 2026) — PRIVATE, not published on the site

Flat and additive. Weights live in `seasons.weights` (jsonb) and are read by
`points_recompute()` at every run, so tune them in the SQL editor with no deploy:

| key            | pts | what the scorer counts                                            |
|----------------|----:|-------------------------------------------------------------------|
| round_played   | 250 | each settled round a wallet's ticket was in (`getRoundEntrants`)  |
| ticket_active  | 200 | `TicketActivated`, once per ticket, only if it then played ≥1 round |
| nudge_swap     |  25 | Pair `Swap` + `ScrollNudged` in the same tx (15 nudge + 10 swap)  |
| plain_swap     |  10 | Pair `Swap` with no nudge                                         |
| panel_nudge    |   5 | `ScrollNudged` with no `Swap` in the tx (Advance the Scroll; N events = N) |
| farm_claim     |  50 | TimbFarm `RewardsClaimed` ≥ 25 TIMBS                              |
| stake_claim    |  25 | TimbStaking `RewardsClaimed` ≥ 25 TIMBS                           |
| faucet_claim   |   1 | `faucet_claims` row with status `sent` (Supabase-side cursor)     |
| win            |   0 | `WinningsClaimed` — kept tunable                                  |

Rules of thumb behind the numbers: rounds are the headline (250/round, and
re-entering a fresh ticket re-earns the 200, so maximising consecutive rounds is
the dominant strategy); trading is a supporting signal; faucet is a tie-breaker.

**Settlement lag.** `seasons.lag_rounds` (4 ≈ 24h at 6h rounds). A round folds
only once it is `lag_rounds` behind the live round, and the block window ends
where round `(current − lag)` settled (the scorer walks `RoundStarted` back from
the head). Nobody can watch their score react in real time.

**Eligibility.** `seasons.min_rounds` (2). Below it a wallet's `display_tp` is 0
and the `quests` function hides it. It appears during its third round.

Tune / inspect:
```sql
update seasons set weights = weights || '{"panel_nudge": 3}' where slug = 'season-0';
select points_recompute(1);                       -- re-apply immediately
select address, display_tp, rounds_played, tickets_activated, nudge_swaps, plain_swaps,
       panel_nudges, farm_claims, stake_claims, faucet_claims
  from points_wallets where season_id = 1 order by display_tp desc limit 20;
```

Rescore from scratch (e.g. after a weight change you want applied to history):
```sql
delete from points_wallets where season_id = 1;
update seasons set last_scored_block = null, last_processed_round = null,
       last_faucet_claim_id = 0 where slug = 'season-0';
```
then run the "TimbSwap Points Scorer" workflow by hand.

Public copy on `/quests/` says only: Play / Trade / Participate, and that points
post about a day after the activity. Keep it that way.

## Manual controls

- **Flag a Sybil / farm wallet** (excludes it from the board on the next recompute):
  ```sql
  update points_wallets set sybil_flag = 'cluster-A'
   where season_id = <id> and address = '0x...';
  select points_recompute(<id>);
  ```
- **Force a full recompute** after changing weights in `points_recompute`:
  `select points_recompute(<season id>);`
- **Read the board yourself:** the `quests` function, or query `points_wallets`
  ordered by `display_tp desc` in the SQL editor.

## Smoke-test
```sh
curl -s https://timbswap.xyz/api/quests -H 'content-type: application/json' -d '{}'
# expect: {"ok":true,"season":{...},"leaderboard":[...]}   (empty board before the first run)
```

## Descoped — referrals / social / email

**Referrals are intentionally NOT part of this program** (founder decision). On a
free-gas testnet a referral rewards *account creation*, which is a Sybil vector,
not real usage — and the program deliberately measures **wallet activity** over
unique-user growth. Referral/social/email were dropped rather than deferred; do
not re-introduce a referral lever on testnet. (Unique-user growth is a mainnet
concern, where real gas is the natural deterrent.)

The `referrals` column on `points_wallets` is left in place but **unused** —
harmless, and cheaper to ignore than to migrate away.

## Still to wire (later, over the same ledger)

- **Per-round** swap attribution + per-day caps (v1/v2 count season-total eligible
  swaps and rely on the √-curve to bound volume farming).
- **Funding-graph / timing Sybil clustering** (INCENTIVES §7) — an automated pass
  that sets `sybil_flag` before the cut line, on top of today's reviewer flag +
  human review.
- **Hold-duration** weighting for stake/LP/lock: v2 credits participation as a
  flag (did it at least once); per-round-held accrual is a future refinement.
