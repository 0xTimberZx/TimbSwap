-- TimbSwap mainnet waitlist — capture-layer signup ledger + atomic insert.
-- Supabase project REPLACE_WITH_MAINNET_SUPABASE_REF.
--
-- The waitlist edge function (supabase/functions/waitlist) calls add_to_waitlist()
-- with the SERVICE_ROLE key, which bypasses RLS. RLS is ON with NO anon policy,
-- so the publishable/anon key that ships in frontend pages can neither read nor
-- write this table (signup emails never leak client-side). Mirrors the faucet
-- hardening and dev-docs/supabase-rls-policies.sql.

create table if not exists waitlist (
  id            bigint generated always as identity primary key,
  email         text        not null,                 -- lowercased, validated in the edge fn
  wallet        text,                                  -- optional lowercased 0x EOA
  telegram      text,                                  -- optional @handle (stored without @)
  source        text        not null default 'landing',
  ref           text,                                  -- document.referrer at signup
  landing       text,                                  -- path the signup came from
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  country       text,                                  -- CF-IPCountry (coarse, non-PII)
  ip_hash       text,                                  -- salted SHA-256 (never the raw IP)
  confirmed     boolean     not null default false,    -- reserved for future double opt-in
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One row per email. Re-signups update the existing row in place (see below).
create unique index if not exists waitlist_email_key on waitlist (lower(email));
create index if not exists waitlist_ip_time on waitlist (ip_hash, created_at desc);
create index if not exists waitlist_created  on waitlist (created_at desc);

alter table waitlist enable row level security;   -- no policy → anon denied; service_role bypasses

-- Insert one signup (or refresh an existing email's details), enforcing a soft
-- per-IP rate limit so a single network can't bulk-stuff the list. Serialized by
-- an advisory lock so two concurrent submits can't both slip past the window.
--
-- Returns:
--   'new'          first time this email joined
--   'updated'      email already present; wallet/telegram/attribution refreshed
--   'rate_limited' too many NEW rows from this ip_hash inside the window
--
-- An empty ip_hash (proxy didn't forward one) skips the rate check, and an
-- existing email is always refreshed — returning users are never blocked.
create or replace function add_to_waitlist(
  p_email        text,
  p_wallet       text,
  p_telegram     text,
  p_source       text,
  p_ref          text,
  p_landing      text,
  p_utm_source   text,
  p_utm_medium   text,
  p_utm_campaign text,
  p_country      text,
  p_ip_hash      text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exists boolean;
  v_recent integer;
begin
  perform pg_advisory_xact_lock(hashtext('timbswap_waitlist'));

  select exists (select 1 from waitlist where lower(email) = lower(p_email)) into v_exists;

  -- Existing email → refresh details, keep the original created_at, never rate-limit.
  if v_exists then
    update waitlist set
      wallet       = coalesce(nullif(p_wallet, ''),       wallet),
      telegram     = coalesce(nullif(p_telegram, ''),     telegram),
      source       = coalesce(nullif(p_source, ''),       source),
      ref          = coalesce(nullif(p_ref, ''),          ref),
      landing      = coalesce(nullif(p_landing, ''),      landing),
      utm_source   = coalesce(nullif(p_utm_source, ''),   utm_source),
      utm_medium   = coalesce(nullif(p_utm_medium, ''),   utm_medium),
      utm_campaign = coalesce(nullif(p_utm_campaign, ''), utm_campaign),
      country      = coalesce(nullif(p_country, ''),      country),
      updated_at   = now()
    where lower(email) = lower(p_email);
    return 'updated';
  end if;

  -- New email → soft per-IP cap: at most 10 new rows per ip_hash in 24h.
  if coalesce(p_ip_hash, '') <> '' then
    select count(*) into v_recent
      from waitlist
     where ip_hash = p_ip_hash
       and created_at > now() - interval '24 hours';
    if v_recent >= 10 then
      return 'rate_limited';
    end if;
  end if;

  insert into waitlist (
    email, wallet, telegram, source, ref, landing,
    utm_source, utm_medium, utm_campaign, country, ip_hash
  ) values (
    lower(p_email),
    nullif(p_wallet, ''),
    nullif(p_telegram, ''),
    coalesce(nullif(p_source, ''), 'landing'),
    nullif(p_ref, ''),
    nullif(p_landing, ''),
    nullif(p_utm_source, ''),
    nullif(p_utm_medium, ''),
    nullif(p_utm_campaign, ''),
    nullif(p_country, ''),
    nullif(p_ip_hash, '')
  );

  return 'new';
end;
$$;
