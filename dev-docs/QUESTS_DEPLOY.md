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

**Headline levers (Season 1):**
- **Volume** — eligible **swaps**, attributed to the real trader (`tx.from`, not the
  router). √-curved so a script can't brute-force the board.
- **Repeat play** — **rounds entered** (from `getRoundEntrants`), with a
  **streak multiplier** for consecutive rounds (the strongest lever).

**Supporting (Sybil weight + diversity), wired in v2:**
- **Stake** (`TimbStaking.Staked`), **LP farm** (`TimbFarm.Staked` +
  `TimbBoostFarm.Deposited`), **lock** (`TimbLockVault.Locked`) each grant a flat
  participation TP and set a flag.
- The **diversity bonus** (×1.15) fires when a wallet did **≥3 distinct** of
  {swap, play, stake, LP, lock} — the main anti-Sybil weight under low KYC.
- Wins (`WinningsClaimed`) are worth a little. Full model: `INCENTIVES.md` §4–5.

**By design, TP rewards WALLET ACTIVITY, not unique users.** There is no referral
lever — see "Descoped" below.

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
