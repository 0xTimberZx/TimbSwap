-- Streak continuity across the re-entry gap, and idempotent round folds.
--
-- A ticket whose last round is S is expired in onRoundSettled(S), which runs
-- after the game has rolled to S+1, so the earliest a new ticket can start is
-- S+2. A player who re-enters the first round they are allowed to therefore
-- always leaves round S+1 empty, and the old rule (continue only when
-- p_round = last + 1) reset every streak to the ticket length: four full
-- 13-round tickets read as streak 13, not 52. A gap of exactly one round can
-- only mean "re-entered as soon as the contract allowed", because waiting one
-- more round lands at S+3, so the tolerance below is precise: continue when
-- p_round <= last + 2, reset otherwise.
--
-- Also: a round folded twice (a scorer run that failed after the RPC and before
-- the cursor moved) used to add a second rounds_played and reset the streak to
-- 1. A round at or below last_played_round is now a no-op for that wallet.
--
-- Apply to history with the rescore recipe in dev-docs/QUESTS_DEPLOY.md.
create or replace function points_apply_round(p_season bigint, p_round bigint, p_addresses text[])
returns integer language plpgsql security definer set search_path = public as $$
declare a text; n integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('timbswap_points_' || p_season::text));
  foreach a in array p_addresses loop
    insert into points_wallets (season_id, address, rounds_played, current_streak, best_streak, last_played_round)
      values (p_season, lower(a), 1, 1, 1, p_round)
    on conflict (season_id, address) do update set
      rounds_played     = case
                            when points_wallets.last_played_round is not null
                             and p_round <= points_wallets.last_played_round
                              then points_wallets.rounds_played                 -- replayed round: no-op
                            else points_wallets.rounds_played + 1
                          end,
      current_streak    = case
                            when points_wallets.last_played_round is not null
                             and p_round <= points_wallets.last_played_round
                              then points_wallets.current_streak                -- replayed round: no-op
                            when points_wallets.last_played_round is not null
                             and p_round <= points_wallets.last_played_round + 2
                              then points_wallets.current_streak + 1            -- next round, or the re-entry gap
                            else 1
                          end,
      best_streak       = greatest(points_wallets.best_streak,
                            case
                              when points_wallets.last_played_round is not null
                               and p_round <= points_wallets.last_played_round
                                then points_wallets.current_streak
                              when points_wallets.last_played_round is not null
                               and p_round <= points_wallets.last_played_round + 2
                                then points_wallets.current_streak + 1
                              else 1
                            end),
      last_played_round = greatest(coalesce(points_wallets.last_played_round, 0), p_round),
      updated_at        = now();
    n := n + 1;
  end loop;
  return n;
end; $$;
