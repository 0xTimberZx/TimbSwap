# Timber Points / Quests — deploy & season runbook

The incentive system from [`INCENTIVES.md`](./INCENTIVES.md), in three parts on
rails the app already runs:

| Part | File(s) | Role |
|------|---------|------|
| Ledger | `supabase/migrations/20260912100000_points.sql` | seasons, per-wallet scores, TP formula (in SQL) |
| Scorer | `scripts/points-scorer.js` + `.github/workflows/points-scorer.yml` | hourly keeper that folds new on-chain activity in |
| Read | `supabase/functions/quests` → Worker `POST /api/quests` → `/quests/` page | public leaderboard + "check my rank" |

Scoring is **incremental**: the keeper only scans blocks/rounds after the season's
cursors, so an hourly cron stays cheap across a 6-week season. The **TP formula
lives in SQL** (`points_recompute`) — retune weights there without redeploying the
keeper; the next run recomputes every wallet.

## What earns TP (Season 1 headline levers)

- **Volume** — eligible **swaps**, attributed to the real trader (`tx.from`, not the
  router). √-curved so a script can't brute-force the board.
- **Repeat play** — **rounds entered** (from `getRoundEntrants`), with a
  **streak multiplier** for consecutive rounds (the strongest lever).
- Wins are worth a little; the **diversity bonus** (traded *and* played ≥ 2 rounds)
  is the main anti-Sybil weight. Full model + weights: `INCENTIVES.md` §4–5.

## Deploy (one-time)

### 1. Database
```sh
supabase db push          # applies 20260912100000_points.sql (seeds a DRAFT season-0)
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

## Notes & v2

- **Sybil resistance** in v1 is: √-curve on volume, streak/diversity weighting,
  reviewer `sybil_flag`, and human review of the cut line. Funding-graph and
  timing clustering (INCENTIVES §7) are a v2 pass over the same ledger.
- **Referrals / social / email** columns exist but are fed later from the
  `waitlist` + referral tables; the on-chain scorer sets play/volume/wins only.
- Per-**round** swap attribution and per-day caps are a v2 refinement; v1 counts
  season-total eligible swaps and relies on the √-curve to bound volume farming.
