-- TimbSwap reclaim reminders — Telegram opt-in registry + dedupe ledger.
-- Supabase project REPLACE_WITH_MAINNET_SUPABASE_REF.
--
-- Purpose: DM a ticket holder before their §14 refund window lapses, so an
-- eventual forfeiture is rare and unambiguously fair (see
-- dev-docs/ABANDONED_TICKET_REVENUE.md, dev-docs/RECLAIM_REMINDERS.md).
--
-- Like the faucet, the backend (edge function + worker) uses the SERVICE_ROLE
-- key, which bypasses RLS. RLS is ON with NO anon policy, so the publishable/
-- anon key that ships in frontend pages can neither read nor write these tables
-- (a subscriber's wallet↔chat_id link is not public). Opt-in happens through the
-- Telegram bot, never a browser write.

-- ── Opt-in registry: wallet ↔ Telegram chat ────────────────────────────────
create table if not exists reclaim_subscribers (
  wallet     text        primary key,          -- lowercased 0x EOA
  chat_id    text        not null,             -- Telegram chat id to DM
  active     boolean     not null default true, -- /stop flips this to false
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists reclaim_subscribers_chat on reclaim_subscribers (chat_id);

alter table reclaim_subscribers enable row level security; -- no policy → anon denied

-- ── Dedupe ledger: one reminder per ticket-expiry ───────────────────────────
-- A ticket has exactly one forfeitRound; keyed by (wallet, generation,
-- forfeit_round) we send at most one reminder as it enters the lead window,
-- so a holder is never spammed each worker run.
create table if not exists reclaim_reminders_sent (
  id            bigint generated always as identity primary key,
  wallet        text        not null,           -- lowercased 0x EOA
  generation    numeric     not null,
  forfeit_round numeric     not null,
  chat_id       text        not null,
  sent_at       timestamptz not null default now(),
  unique (wallet, generation, forfeit_round)
);

create index if not exists reclaim_reminders_sent_wallet
  on reclaim_reminders_sent (wallet, generation);

alter table reclaim_reminders_sent enable row level security; -- no policy → anon denied
