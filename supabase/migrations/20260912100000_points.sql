-- TimbSwap Timber Points (TP) — incentive-season scoring ledger.
-- Design: dev-docs/INCENTIVES.md. Deploy: dev-docs/QUESTS_DEPLOY.md.
--
-- The scorer keeper (scripts/points-scorer.js) and the quests read function use
-- the SERVICE_ROLE key, which bypasses RLS. RLS is ON with NO anon policy, so the
-- publishable/anon key that ships in frontend pages can neither read nor write
-- these tables directly — the public leaderboard is served by the `quests` edge
-- function (service role). Mirrors the faucet/waitlist hardening.
--
-- The TP formula lives in points_recompute() (SQL) so weights can be tuned
-- without redeploying the keeper. Aggregates are accumulated incrementally by the
-- apply_* RPCs; the keeper only ever feeds NEW blocks/rounds (per-season cursors).

-- ─── Seasons ─────────────────────────────────────────────────────────
create table if not exists seasons (
  id                  bigint generated always as identity primary key,
  slug                text        not null unique,
  name                text        not null,
  status              text        not null default 'draft'
                        check (status in ('draft','active','ended')),
  start_block         bigint,                          -- set when the season opens
  end_block           bigint,                          -- null while running
  start_round         bigint,                          -- first prize round in scope
  k_curve             numeric     not null default 3,  -- volume √-curve coefficient
  grace_blocks        bigint      not null default 0,  -- reserved for late-join weighting
  min_rounds          integer     not null default 3,  -- eligibility floor (used by reads)
  last_scored_block   bigint,                          -- cursor: last block folded into swaps
  last_processed_round bigint,                         -- cursor: last settled round folded in
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table seasons enable row level security;   -- service_role only

-- ─── Per-wallet, per-season scores ────────────────────────────────────
create table if not exists points_wallets (
  season_id         bigint  not null references seasons(id) on delete cascade,
  address           text    not null,                  -- lowercased 0x EOA (the real trader)
  -- Aggregates (accumulated by the apply_* RPCs) --
  swap_count        integer not null default 0,        -- eligible swaps (volume / nudges)
  rounds_played     integer not null default 0,        -- distinct rounds entered (repeat play)
  current_streak    integer not null default 0,        -- running consecutive-round streak
  best_streak       integer not null default 0,        -- longest streak this season
  last_played_round bigint,                             -- for streak continuity
  wins              integer not null default 0,         -- pots claimed
  referrals         integer not null default 0,         -- activated referrals (fed later)
  first_seen_block  bigint,                             -- earliest block we saw this wallet act
  -- Derived --
  display_tp        numeric not null default 0,          -- recomputed from aggregates
  diversity         boolean not null default false,      -- earned the diversity bonus
  sybil_flag        text,                                -- non-null => excluded from the board (reviewer-set)
  updated_at        timestamptz not null default now(),
  primary key (season_id, address)
);

create index if not exists points_wallets_board on points_wallets (season_id, display_tp desc);

alter table points_wallets enable row level security;   -- service_role only

-- ─── Scoring-run audit log ────────────────────────────────────────
create table if not exists points_runs (
  id            bigint generated always as identity primary key,
  season_id     bigint references seasons(id) on delete cascade,
  ran_at        timestamptz not null default now(),
  from_block    bigint,
  to_block      bigint,
  rounds_added  integer,
  swaps_added   integer,
  wallets_total integer,
  note          text
);
alter table points_runs enable row level security;   -- service_role only

-- ─── Write RPCs (security definer; called by the keeper with service role) ────────

-- Fold one settled round's entrants in: +1 round played, streak continuity.
-- Addresses MUST be de-duplicated by the caller (one row per wallet per round).
create or replace function points_apply_round(p_season bigint, p_round bigint, p_addresses text[])
returns integer language plpgsql security definer set search_path = public as $$
declare a text; n integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('timbswap_points_' || p_season::text));
  foreach a in array p_addresses loop
    insert into points_wallets (season_id, address, rounds_played, current_streak, best_streak, last_played_round)
      values (p_season, lower(a), 1, 1, 1, p_round)
    on conflict (season_id, address) do update set
      rounds_played     = points_wallets.rounds_played + 1,
      current_streak    = case when p_round = points_wallets.last_played_round + 1
                               then points_wallets.current_streak + 1 else 1 end,
      best_streak       = greatest(points_wallets.best_streak,
                            case when p_round = points_wallets.last_played_round + 1
                                 then points_wallets.current_streak + 1 else 1 end),
      last_played_round = p_round,
      updated_at        = now();
    n := n + 1;
  end loop;
  return n;
end; $$;

-- Fold a batch of swap counts in. p_rows = [{"a":"0x..","n":3,"fb":123}, ...]
create or replace function points_apply_swaps(p_season bigint, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare r jsonb; c integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('timbswap_points_' || p_season::text));
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into points_wallets (season_id, address, swap_count, first_seen_block)
      values (p_season, lower(r->>'a'), (r->>'n')::int, (r->>'fb')::bigint)
    on conflict (season_id, address) do update set
      swap_count       = points_wallets.swap_count + (r->>'n')::int,
      first_seen_block = least(coalesce(points_wallets.first_seen_block, (r->>'fb')::bigint), (r->>'fb')::bigint),
      updated_at       = now();
    c := c + 1;
  end loop;
  return c;
end; $$;

-- Fold a batch of wins in. p_rows = [{"a":"0x..","n":1}, ...]
create or replace function points_apply_wins(p_season bigint, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare r jsonb; c integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('timbswap_points_' || p_season::text));
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into points_wallets (season_id, address, wins)
      values (p_season, lower(r->>'a'), (r->>'n')::int)
    on conflict (season_id, address) do update set
      wins       = points_wallets.wins + (r->>'n')::int,
      updated_at = now();
    c := c + 1;
  end loop;
  return c;
end; $$;

-- Recompute display_tp for every wallet in a season from its aggregates.
-- THE TP FORMULA LIVES HERE — tune weights without touching the keeper.
--   play_tp   = 15 per round played            (repeat play — headline lever)
--   swap_tp   = 12 first-swap + k·√(3·(n-1))     (volume — headline, √-curved)
--   win_tp    = 25 per pot won                 (luck — kept small)
--   × streak multiplier (best_streak: ≥3→1.15, ≥6→1.35, ≥12→1.6)
--   × diversity bonus  (swap>0 AND rounds≥2 → 1.15)
--   × 0 if sybil_flag set (reviewer excludes)
create or replace function points_recompute(p_season bigint)
returns integer language plpgsql security definer set search_path = public as $$
declare v_k numeric; c integer;
begin
  select k_curve into v_k from seasons where id = p_season;
  update points_wallets w set
    diversity  = (w.swap_count > 0 and w.rounds_played >= 2),
    display_tp = round(
      ( (15 * w.rounds_played)
        + (case when w.swap_count > 0 then 12 else 0 end)
        + coalesce(v_k, 3) * sqrt(3 * greatest(w.swap_count - 1, 0))
        + (25 * w.wins)
      )
      * (case when w.best_streak >= 12 then 1.6
              when w.best_streak >= 6  then 1.35
              when w.best_streak >= 3  then 1.15 else 1.0 end)
      * (case when w.swap_count > 0 and w.rounds_played >= 2 then 1.15 else 1.0 end)
      * (case when w.sybil_flag is not null then 0 else 1 end)
    , 2),
    updated_at = now()
  where w.season_id = p_season;
  get diagnostics c = row_count;
  return c;
end; $$;

-- ─── Read RPCs (service role, via the quests edge function) ───────────────────

-- 1-based rank of a wallet on the board (non-flagged, positive TP). 0 = unranked.
create or replace function points_wallet_rank(p_season bigint, p_address text)
returns integer language sql security definer set search_path = public as $$
  select case when me.display_tp is null or me.display_tp <= 0 then 0 else
    (select count(*) + 1 from points_wallets w
      where w.season_id = p_season and w.sybil_flag is null and w.display_tp > me.display_tp)
  end
  from (select display_tp from points_wallets
         where season_id = p_season and address = lower(p_address)) me;
$$;

-- ─── Season 0 placeholder ──────────────────────────────────────────
-- Seeded as DRAFT. To open the season (see QUESTS_DEPLOY.md):
--   update seasons set status='active',
--     start_block = <current block>, start_round = <current round>
--   where slug = 'season-0';
insert into seasons (slug, name, status)
  values ('season-0', 'Season 0 — Genesis', 'draft')
  on conflict (slug) do nothing;
