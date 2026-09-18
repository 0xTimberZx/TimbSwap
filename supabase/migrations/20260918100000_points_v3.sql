-- TimbSwap Timber Points v3 — flat, event-based scoring with a settlement lag.
-- Additive over points.sql / points_v2.sql. Weights live in seasons.weights
-- (jsonb) so they can be tuned in SQL without redeploying the keeper. They are
-- deliberately NOT published on the site.
--
--   round_played   250   per settled round a wallet's ticket was in
--   ticket_active  200   per ticket that activated and then played ≥1 round
--   nudge_swap      25   eligible swap that nudged the meter (15 nudge + 10 swap)
--   plain_swap      10   swap that did not nudge
--   panel_nudge      5   "Advance the Scroll" nudge (gas-only, no swap)
--   farm_claim      50   TimbFarm RewardsClaimed ≥ 25 TIMBS
--   stake_claim     25   TimbStaking RewardsClaimed ≥ 25 TIMBS
--   faucet_claim     1   faucet drip sent
--   win              0   (kept tunable)
--
-- Activity is folded only once it is lag_rounds behind the live round (~24h at
-- 6h rounds), and a wallet appears on the board after min_rounds rounds.

alter table seasons add column if not exists lag_rounds integer not null default 4;
alter table seasons add column if not exists last_faucet_claim_id bigint not null default 0;
alter table seasons add column if not exists weights jsonb not null default
  '{"round_played":250,"ticket_active":200,"nudge_swap":25,"plain_swap":10,"panel_nudge":5,"farm_claim":50,"stake_claim":25,"faucet_claim":1,"win":0}'::jsonb;

alter table points_wallets add column if not exists nudge_swaps       integer not null default 0;
alter table points_wallets add column if not exists plain_swaps       integer not null default 0;
alter table points_wallets add column if not exists panel_nudges      integer not null default 0;
alter table points_wallets add column if not exists tickets_activated integer not null default 0;
alter table points_wallets add column if not exists farm_claims       integer not null default 0;
alter table points_wallets add column if not exists stake_claims      integer not null default 0;
alter table points_wallets add column if not exists faucet_claims     integer not null default 0;

-- Fold a batch of per-wallet activity counters in.
-- p_rows = [{"a":"0x..","ns":1,"ps":0,"pn":3,"ta":1,"fc":0,"sc":1,"fb":123}, ...]
create or replace function points_apply_activity(p_season bigint, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare r jsonb; c integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('timbswap_points_' || p_season::text));
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into points_wallets (season_id, address, nudge_swaps, plain_swaps, panel_nudges,
                                tickets_activated, farm_claims, stake_claims, swap_count, first_seen_block)
      values (p_season, lower(r->>'a'),
              coalesce((r->>'ns')::int,0), coalesce((r->>'ps')::int,0), coalesce((r->>'pn')::int,0),
              coalesce((r->>'ta')::int,0), coalesce((r->>'fc')::int,0), coalesce((r->>'sc')::int,0),
              coalesce((r->>'ns')::int,0) + coalesce((r->>'ps')::int,0),
              (r->>'fb')::bigint)
    on conflict (season_id, address) do update set
      nudge_swaps       = points_wallets.nudge_swaps       + coalesce((r->>'ns')::int,0),
      plain_swaps       = points_wallets.plain_swaps       + coalesce((r->>'ps')::int,0),
      panel_nudges      = points_wallets.panel_nudges      + coalesce((r->>'pn')::int,0),
      tickets_activated = points_wallets.tickets_activated + coalesce((r->>'ta')::int,0),
      farm_claims       = points_wallets.farm_claims       + coalesce((r->>'fc')::int,0),
      stake_claims      = points_wallets.stake_claims      + coalesce((r->>'sc')::int,0),
      swap_count        = points_wallets.swap_count + coalesce((r->>'ns')::int,0) + coalesce((r->>'ps')::int,0),
      first_seen_block  = least(coalesce(points_wallets.first_seen_block, (r->>'fb')::bigint), coalesce((r->>'fb')::bigint, points_wallets.first_seen_block)),
      updated_at        = now();
    c := c + 1;
  end loop;
  return c;
end; $$;

-- Fold faucet drips (status = 'sent', reserved before p_until) since the season's
-- faucet cursor. Idempotent via seasons.last_faucet_claim_id.
create or replace function points_fold_faucet(p_season bigint, p_until timestamptz)
returns integer language plpgsql security definer set search_path = public as $$
declare v_last bigint; v_max bigint; c integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('timbswap_points_' || p_season::text));
  select last_faucet_claim_id into v_last from seasons where id = p_season;
  select coalesce(max(id), v_last) into v_max from faucet_claims
   where id > v_last and status = 'sent' and reserved_at <= p_until;
  if v_max <= v_last then return 0; end if;
  insert into points_wallets (season_id, address, faucet_claims)
    select p_season, lower(address), count(*) from faucet_claims
     where id > v_last and id <= v_max and status = 'sent' and reserved_at <= p_until
     group by lower(address)
  on conflict (season_id, address) do update set
    faucet_claims = points_wallets.faucet_claims + excluded.faucet_claims,
    updated_at    = now();
  get diagnostics c = row_count;
  update seasons set last_faucet_claim_id = v_max, updated_at = now() where id = p_season;
  return c;
end; $$;

-- v3 recompute: flat and additive, weights from seasons.weights; a wallet scores
-- 0 (hidden) until it has played min_rounds rounds; sybil flag zeroes it.
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
          pw.rounds_played     * coalesce((w->>'round_played')::numeric,  250)
        + pw.tickets_activated * coalesce((w->>'ticket_active')::numeric, 200)
        + pw.nudge_swaps       * coalesce((w->>'nudge_swap')::numeric,     25)
        + pw.plain_swaps       * coalesce((w->>'plain_swap')::numeric,     10)
        + pw.panel_nudges      * coalesce((w->>'panel_nudge')::numeric,     5)
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

-- Season 0: board eligibility after two rounds; four-round settlement lag.
update seasons set min_rounds = 2, lag_rounds = 4 where slug = 'season-0';
