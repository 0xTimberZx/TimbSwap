-- points_recompute: cast the score expression to numeric before round().
-- sqrt() returns double precision, so the whole expression was double and
-- round(double precision, integer) does not exist in Postgres. Every scorer
-- run died on "function round(double precision, integer) does not exist".
-- Formula unchanged.
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
    display_tp = round((
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
    )::numeric, 2),
    updated_at = now()
  where w.season_id = p_season;
  get diagnostics c = row_count;
  return c;
end; $$;
