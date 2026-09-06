-- Faucet soft check (double measure): record the wallet's yield-vault "reserve
-- weight" on each claim, for observability only. The active-ticket check remains
-- the SOLE eligibility gate — this column never blocks a claim. The edge function
-- reads TimbYieldVault.weightOf(ticketId) and passes it through reserve_faucet_claim.

alter table faucet_claims add column if not exists reserve_weight numeric;

-- Replace the 2-arg reserve with a 3-arg version that stores the soft-check
-- weight. Drop the old signature first so there's no overload ambiguity — the
-- edge function is the only caller and always passes all three named args.
drop function if exists reserve_faucet_claim(text, numeric);

create or replace function reserve_faucet_claim(
  p_address        text,
  p_ticket_id      numeric,
  p_reserve_weight numeric default null
)
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

  -- Cooldown is keyed on ADDRESS + reserved_at only (never ticket_id), so it
  -- does not reset on a new ticket, a withdrawal, or a ticket-type change.
  select exists (
    select 1 from faucet_claims
    where address = lower(p_address)
      and status <> 'failed'
      and reserved_at > now() - interval '24 hours'
  ) into v_recent;

  if v_recent then
    return null;                                   -- still on cooldown
  end if;

  insert into faucet_claims (address, ticket_id, status, reserve_weight)
  values (lower(p_address), p_ticket_id, 'reserved', p_reserve_weight)
  returning id into v_id;

  return v_id;
end;
$$;
