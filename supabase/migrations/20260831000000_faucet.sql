-- TimbSwap gas faucet — claim ledger + atomic reserve.
-- Supabase project REPLACE_WITH_MAINNET_SUPABASE_REF.
--
-- The faucet backend (edge function + worker) uses the SERVICE_ROLE key, which
-- bypasses RLS. RLS is ON with NO anon policy, so the publishable/anon key that
-- ships in frontend pages can neither read nor write this table. Mirrors the
-- hardening in dev-docs/supabase-rls-policies.sql.

create table if not exists faucet_claims (
  id          bigint generated always as identity primary key,
  address     text        not null,                 -- lowercased 0x EOA
  ticket_id   numeric     not null,                 -- the active ticket that qualified
  status      text        not null default 'reserved'
                check (status in ('reserved','sent','failed')),
  wallet_tx   text,                                 -- gas-drip tx hash
  pot_tx      text,                                 -- addToPot() tx hash
  reserved_at timestamptz not null default now(),
  sent_at     timestamptz,
  error       text
);

create index if not exists faucet_claims_addr_time on faucet_claims (address, reserved_at desc);
create index if not exists faucet_claims_status     on faucet_claims (status, reserved_at);

alter table faucet_claims enable row level security;   -- no policy → anon denied; service_role bypasses

-- Atomically enforce the 24h-per-address cooldown and enqueue one reservation.
-- Serialized by an advisory lock so two simultaneous requests for the same (or
-- different) address cannot both slip past the window. Returns the new claim id
-- when allowed, or NULL when the address is still on cooldown.
--
-- A 'failed' send does NOT burn the day (excluded below), so a wallet whose
-- dispatch reverted can retry immediately. A 'reserved' row DOES hold the slot
-- until the worker resolves it to 'sent' or 'failed'.
create or replace function reserve_faucet_claim(p_address text, p_ticket_id numeric)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recent boolean;
  v_id     bigint;
begin
  perform pg_advisory_xact_lock(hashtext('timbswap_faucet'));

  select exists (
    select 1 from faucet_claims
    where address = lower(p_address)
      and status <> 'failed'
      and reserved_at > now() - interval '24 hours'
  ) into v_recent;

  if v_recent then
    return null;                                   -- still on cooldown
  end if;

  insert into faucet_claims (address, ticket_id, status)
  values (lower(p_address), p_ticket_id, 'reserved')
  returning id into v_id;

  return v_id;
end;
$$;

-- Safety valve: a 'reserved' row the worker never resolved (crash between
-- reserve and send) would otherwise hold the address's slot for 24h. Run this
-- periodically (or let the worker call it on start) to release reservations
-- older than 15 minutes that never sent.
create or replace function expire_stale_reservations()
returns integer
language sql
security definer
set search_path = public
as $$
  with upd as (
    update faucet_claims
       set status = 'failed', error = 'expired: worker never dispatched'
     where status = 'reserved'
       and reserved_at < now() - interval '15 minutes'
    returning 1
  )
  select count(*)::int from upd;
$$;
