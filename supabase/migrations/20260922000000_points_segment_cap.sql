-- Timber Points: cap meter activity at seasons.weights->>'segment_cap' points
-- per wallet per segment.
--
-- Nudge-swaps, plain swaps and "Advance the Scroll" panel nudges now share one
-- budget per segment. Uncapped, the gas-only panel path was the cheapest way to
-- farm the board: 5 points x the UI's Max(10) is 50 a segment, 300 a round,
-- more than the 250 a round is worth.
--
-- The cap cannot be expressed here: it needs each event's segment, which only
-- the keeper sees. So the keeper prices meter events, caps each segment, and
-- banks the result in points_wallets.meter_tp; this function adds it straight
-- in. nudge_swaps / plain_swaps / panel_nudges stay as raw counters for display
-- and for the reconciler to check against.
--
-- Consequence worth knowing: nudge_swap, plain_swap, panel_nudge and
-- segment_cap are applied at fold time, so changing them affects future folds
-- only. To apply a new value to history, clear points_wallets and rewind the
-- season cursors (see dev-docs/QUESTS_DEPLOY.md). Every other weight is still
-- counters x weights here, and stays fully retroactive.

alter table points_wallets add column if not exists meter_tp numeric not null default 0;

alter table seasons alter column weights set default
  '{"round_played":250,"ticket_active":200,"nudge_swap":25,"plain_swap":10,"panel_nudge":5,"segment_cap":30,"farm_claim":50,"stake_claim":25,"faucet_claim":1,"win":0}'::jsonb;

update seasons set weights = weights || '{"segment_cap":30}'::jsonb
 where not (weights ? 'segment_cap');

-- p_rows gains "mt": capped meter points for this window.
create or replace function points_apply_activity(p_season bigint, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare r jsonb; c integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('timbswap_points_' || p_season::text));
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into points_wallets (season_id, address, nudge_swaps, plain_swaps, panel_nudges,
                                tickets_activated, farm_claims, stake_claims, swap_count,
                                meter_tp, first_seen_block)
      values (p_season, lower(r->>'a'),
              coalesce((r->>'ns')::int,0), coalesce((r->>'ps')::int,0), coalesce((r->>'pn')::int,0),
              coalesce((r->>'ta')::int,0), coalesce((r->>'fc')::int,0), coalesce((r->>'sc')::int,0),
              coalesce((r->>'ns')::int,0) + coalesce((r->>'ps')::int,0),
              coalesce((r->>'mt')::numeric,0),
              (r->>'fb')::bigint)
    on conflict (season_id, address) do update set
      nudge_swaps       = points_wallets.nudge_swaps       + coalesce((r->>'ns')::int,0),
      plain_swaps       = points_wallets.plain_swaps       + coalesce((r->>'ps')::int,0),
      panel_nudges      = points_wallets.panel_nudges      + coalesce((r->>'pn')::int,0),
      tickets_activated = points_wallets.tickets_activated + coalesce((r->>'ta')::int,0),
      farm_claims       = points_wallets.farm_claims       + coalesce((r->>'fc')::int,0),
      stake_claims      = points_wallets.stake_claims      + coalesce((r->>'sc')::int,0),
      swap_count        = points_wallets.swap_count + coalesce((r->>'ns')::int,0) + coalesce((r->>'ps')::int,0),
      meter_tp          = points_wallets.meter_tp          + coalesce((r->>'mt')::numeric,0),
      first_seen_block  = least(coalesce(points_wallets.first_seen_block, (r->>'fb')::bigint), coalesce((r->>'fb')::bigint, points_wallets.first_seen_block)),
      updated_at        = now();
    c := c + 1;
  end loop;
  return c;
end; $$;

-- Meter points come in pre-capped; everything else is still counters x weights.
create or replace function points_recompute(p_season bigint)
returns integer language plpgsql security definer set search_path = public as $$
declare w jsonb; v_min integer; c integer;
begin
  select weights, min_rounds into w, v_min from seasons where id = p_season;
  update points_wallets pw set
    diversity = (
        (case when pw.swap_count > 0    then 1 else 0 end)
      + (case when pw.rounds_played >= 1 then 1 else 0 end)
      + (case when pw.did_stake          then 1 else 0 end)
      + (case when pw.did_lp             then 1 else 0 end)
      + (case when pw.did_lock           then 1 else 0 end)
    ) >= 3,
    display_tp = case
      when pw.sybil_flag is not null then 0
      when pw.rounds_played < coalesce(v_min, 0) then 0
      else round((
          pw.meter_tp
        + pw.rounds_played     * coalesce((w->>'round_played')::numeric,  250)
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
