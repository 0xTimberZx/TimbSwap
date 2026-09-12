-- TimbSwap Timber Points v2 — wire stake / LP-farm / boost / lock into scoring.
-- Additive over 20260912100000_points.sql. Design: dev-docs/INCENTIVES.md §4–5.
--
-- Adds participation flags for the supporting on-chain signals, then upgrades
-- points_recompute() to award flat participation TP and the REAL diversity bonus
-- (≥3 distinct of {swap, play, stake, LP, lock}) — the strongest anti-Sybil weight
-- with low identity friction. Headline levers (volume √-curve, repeat-play streak)
-- are unchanged.

alter table points_wallets add column if not exists did_stake boolean not null default false; -- staked TIMBS
alter table points_wallets add column if not exists did_lp    boolean not null default false; -- LP farm or boost farm
alter table points_wallets add column if not exists did_lock  boolean not null default false; -- Lock Vault

-- Fold participation flags in (OR-in; once true, stays true for the season).
-- p_rows = [{"a":"0x..","stake":true,"lp":false,"lock":true}, ...]
create or replace function points_apply_flags(p_season bigint, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare r jsonb; c integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('timbswap_points_' || p_season::text));
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into points_wallets (season_id, address, did_stake, did_lp, did_lock)
      values (p_season, lower(r->>'a'),
              coalesce((r->>'stake')::boolean, false),
              coalesce((r->>'lp')::boolean,    false),
              coalesce((r->>'lock')::boolean,  false))
    on conflict (season_id, address) do update set
      did_stake  = points_wallets.did_stake or coalesce((r->>'stake')::boolean, false),
      did_lp     = points_wallets.did_lp    or coalesce((r->>'lp')::boolean,    false),
      did_lock   = points_wallets.did_lock  or coalesce((r->>'lock')::boolean,  false),
      updated_at = now();
    c := c + 1;
  end loop;
  return c;
end; $$;

-- v2 recompute. THE TP FORMULA — tune here without redeploying the keeper.
--   play_tp   = 15 per round played              (repeat play — headline)
--   swap_tp   = 12 first-swap + k·√(3·(n-1))       (volume — headline, √-curved)
--   win_tp    = 25 per pot won                   (luck — small)
--   stake/LP/lock = 15 / 25 / 10 flat            (supporting — Sybil weight)
--   × streak multiplier (best_streak: ≥3→1.15, ≥6→1.35, ≥12→1.6)
--   × diversity bonus (≥3 distinct of {swap, play, stake, LP, lock} → 1.15)
--   × 0 if sybil_flag set (reviewer excludes)
create or replace function points_recompute(p_season bigint)
returns integer language plpgsql security definer set search_path = public as $$
declare v_k numeric; c integer;
begin
  select k_curve into v_k from seasons where id = p_season;
  update points_wallets w set
    diversity = (
        (case when w.swap_count > 0    then 1 else 0 end)
      + (case when w.rounds_played >= 1 then 1 else 0 end)
      + (case when w.did_stake          then 1 else 0 end)
      + (case when w.did_lp             then 1 else 0 end)
      + (case when w.did_lock           then 1 else 0 end)
    ) >= 3,
    display_tp = round(
      ( (15 * w.rounds_played)
        + (case when w.swap_count > 0 then 12 else 0 end)
        + coalesce(v_k, 3) * sqrt(3 * greatest(w.swap_count - 1, 0))
        + (25 * w.wins)
        + (case when w.did_stake then 15 else 0 end)
        + (case when w.did_lp    then 25 else 0 end)
        + (case when w.did_lock  then 10 else 0 end)
      )
      * (case when w.best_streak >= 12 then 1.6
              when w.best_streak >= 6  then 1.35
              when w.best_streak >= 3  then 1.15 else 1.0 end)
      * (case when (
              (case when w.swap_count > 0    then 1 else 0 end)
            + (case when w.rounds_played >= 1 then 1 else 0 end)
            + (case when w.did_stake          then 1 else 0 end)
            + (case when w.did_lp             then 1 else 0 end)
            + (case when w.did_lock           then 1 else 0 end)) >= 3
          then 1.15 else 1.0 end)
      * (case when w.sybil_flag is not null then 0 else 1 end)
    , 2),
    updated_at = now()
  where w.season_id = p_season;
  get diagnostics c = row_count;
  return c;
end; $$;
