-- A fresh deposit's first round earns the activation, not the round.
--
-- A ticket that takes an entirely new deposit earns ticket_active (200) for the
-- round it activates in, and round_played (250) only from that deposit's second
-- round on, including rounds carried into a replacement ticket. Before this,
-- the first round earned both (450).
--
-- tickets_activated already counts fresh-deposit activations only (the scorer
-- skips replacements, supersedes != 0), and each one has exactly one first
-- round inside rounds_played, so the change is a formula change here: one
-- round_played per activation becomes the activation alone. No scorer change,
-- no rescore; select points_recompute(1) applies it to history.
--
-- Eligibility (min_rounds) still counts every round played.
create or replace function points_recompute(p_season bigint)
returns integer language plpgsql security definer set search_path = public as $$
declare w jsonb; v_min integer; c integer;
begin
  select weights, min_rounds into w, v_min from seasons where id = p_season;
  update points_wallets pw set
    diversity = ((case when pw.swap_count > 0 then 1 else 0 end) + (case when pw.rounds_played >= 1 then 1 else 0 end) + (case when pw.did_stake then 1 else 0 end) + (case when pw.did_lp then 1 else 0 end) + (case when pw.did_lock then 1 else 0 end)) >= 3,
    display_tp = case
      when pw.sybil_flag is not null then 0
      when pw.rounds_played < coalesce(v_min, 0) then 0
      else round((
          pw.meter_tp
        + greatest(pw.rounds_played - pw.tickets_activated, 0)
                                * coalesce((w->>'round_played')::numeric,  250)
        + pw.tickets_activated * coalesce((w->>'ticket_active')::numeric, 200)
        + pw.farm_claims       * coalesce((w->>'farm_claim')::numeric,     50)
        + pw.stake_claims      * coalesce((w->>'stake_claim')::numeric,    25)
        + pw.faucet_claims     * coalesce((w->>'faucet_claim')::numeric,    1)
        + pw.wins              * coalesce((w->>'win')::numeric,             0)
      )::numeric, 2)
    end,
    updated_at = now()
  where pw.season_id = p_season;
  get diagnostics c = row_count;
  return c;
end; $$;

-- create or replace keeps the existing grants; restated so this file stands alone.
revoke execute on function public.points_recompute(bigint) from public, anon, authenticated;
grant execute on function public.points_recompute(bigint) to service_role;
