-- TimbSwap match notifications — dedupe ledger for "your letter matched" DMs.
-- Supabase project REPLACE_WITH_MAINNET_SUPABASE_REF.
--
-- Rides the same opt-in registry as the reclaim reminders (reclaim_subscribers,
-- 20260901120000_reclaim_reminders.sql). This table just records which
-- match-progress DMs have already gone out so a holder is nudged once per
-- (ticket, round, segment), not every worker run.
--
-- Backend uses the SERVICE_ROLE key (bypasses RLS). RLS is ON with NO anon
-- policy, so the browser-shipped anon key can neither read nor write it.

create table if not exists match_notifications_sent (
  id          bigint generated always as identity primary key,
  wallet      text        not null,   -- lowercased 0x EOA
  generation  numeric     not null,
  round       numeric     not null,
  segment     numeric     not null,   -- which segment matched (1 = first letter)
  matched_char text,                  -- the locked char that matched (display)
  chat_id     text        not null,
  sent_at     timestamptz not null default now(),
  unique (wallet, generation, round, segment)
);

create index if not exists match_notifications_sent_lookup
  on match_notifications_sent (generation, round, segment);

alter table match_notifications_sent enable row level security; -- no policy → anon denied
