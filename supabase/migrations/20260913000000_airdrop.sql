-- Cross-chain TIMB airdrop — the outbox drained by supabase/functions/airdrop-dispatch.
-- An eligible testnet faucet claim calls enqueue_airdrop() (from faucet-claim); the
-- dispatcher claims a batch, sends real TIMB on Arbitrum One via
-- TimbAirdropDistributor.distribute(), and resolves each row.
--
-- Dedup is layered (see dev-docs/MAINNET_AIRDROP_SPEC.md):
--   1. unique(address, round) here            → can't queue twice
--   2. claim_airdrop_batch FOR UPDATE SKIP LOCKED → two runs can't grab one row
--   3. on-chain claimed[round][recipient]     → can't pay twice even if the DB is wrong
-- The on-chain totalCap/perRoundCap are the authoritative spend ceiling; this
-- layer only dedups + sequences.

-- ── Outbox ──────────────────────────────────────────────────────────────────────
create table if not exists public.airdrop_outbox (
  id          bigserial primary key,
  address     text        not null,
  round       int         not null default 1,
  status      text        not null default 'pending'
              check (status in ('pending','sending','sent','failed','skipped')),
  claim_id    bigint      references public.faucet_claims(id),
  tx_hash     text,
  created_at  timestamptz not null default now(),
  locked_at   timestamptz,
  sent_at     timestamptz,
  error       text,
  unique (address, round)   -- DEDUP LAYER 1
);
create index if not exists airdrop_outbox_pending_idx
  on public.airdrop_outbox (created_at) where status = 'pending';

-- RLS on, NO anon policy: only the service_role backend (edge fn) touches it.
alter table public.airdrop_outbox enable row level security;

-- ── Single-sender lease ───────────────────────────────────────────────────────────
-- One dispatcher run at a time so the on-chain sends share one nonce stream.
create table if not exists public.airdrop_lock (
  id           int primary key,
  locked_until timestamptz not null default 'epoch'
);
insert into public.airdrop_lock (id, locked_until)
  values (1, 'epoch') on conflict (id) do nothing;
alter table public.airdrop_lock enable row level security;

-- ── enqueue (called by faucet-claim after a successful reserve) ──────────────────────
create or replace function public.enqueue_airdrop(p_address text, p_round int)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_id bigint;
begin
  insert into public.airdrop_outbox (address, round)
  values (lower(p_address), p_round)
  on conflict (address, round) do nothing
  returning id into v_id;
  return v_id;               -- null when already queued (dedup)
end;
$$;

-- ── acquire / release the single-sender lease ───────────────────────────────────────
create or replace function public.airdrop_acquire_lease(p_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  update public.airdrop_lock
     set locked_until = now() + make_interval(secs => p_seconds)
   where id = 1 and locked_until < now();
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

create or replace function public.airdrop_release_lease()
returns void
language sql
security definer
set search_path = public
as $$
  update public.airdrop_lock set locked_until = 'epoch' where id = 1;
$$;

-- ── claim a batch atomically (pending → sending) ────────────────────────────────────
create or replace function public.claim_airdrop_batch(p_limit int)
returns table(id bigint, address text, round int)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.airdrop_outbox o
     set status = 'sending', locked_at = now()
    from (
      select ao.id
        from public.airdrop_outbox ao
       where ao.status = 'pending'
       order by ao.created_at
       limit p_limit
       for update skip locked            -- DEDUP LAYER 2
    ) picked
   where o.id = picked.id
  returning o.id, o.address, o.round;
end;
$$;

-- ── resolve a row after the on-chain send ───────────────────────────────────────────
create or replace function public.resolve_airdrop(
  p_id bigint, p_status text, p_tx text default null, p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('pending','sending','sent','failed','skipped') then
    raise exception 'resolve_airdrop: bad status %', p_status;
  end if;
  update public.airdrop_outbox
     set status  = p_status,
         tx_hash = coalesce(p_tx, tx_hash),
         error   = case when p_status = 'failed' then left(p_error, 500) else error end,
         sent_at = case when p_status = 'sent'   then now()            else sent_at end
   where id = p_id;
end;
$$;

-- ── reopen rows a crashed run left 'sending' ────────────────────────────────────────
-- Safe because the on-chain claimed[] guard makes a re-send a no-op the dispatcher
-- detects (isClaimed → resolve as sent) rather than a double-pay.
create or replace function public.expire_stale_airdrop_sending(p_minutes int default 10)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  update public.airdrop_outbox
     set status = 'pending'
   where status = 'sending'
     and locked_at < now() - make_interval(mins => p_minutes);
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ── Lock these down: service_role only (no default PUBLIC execute) ───────────────────
revoke execute on function
  public.enqueue_airdrop(text,int),
  public.airdrop_acquire_lease(int),
  public.airdrop_release_lease(),
  public.claim_airdrop_batch(int),
  public.resolve_airdrop(bigint,text,text,text),
  public.expire_stale_airdrop_sending(int)
  from public, anon, authenticated;
grant execute on function
  public.enqueue_airdrop(text,int),
  public.airdrop_acquire_lease(int),
  public.airdrop_release_lease(),
  public.claim_airdrop_batch(int),
  public.resolve_airdrop(bigint,text,text,text),
  public.expire_stale_airdrop_sending(int)
  to service_role;
