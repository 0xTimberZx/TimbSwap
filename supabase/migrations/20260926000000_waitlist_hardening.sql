-- Waitlist hardening (2026-09-26).
--
-- A script posted five signups in seven seconds from one network: five
-- throwaway-domain emails, one wallet, no landing path (the real form always
-- sends one). The 10-per-network daily cap let all five through, and each
-- triggered a founder ping and a confirmation email to an address the sender
-- did not need to own.
--
-- This migration tightens the SQL side; the edge function adds Turnstile and a
-- disposable-domain block in front of it.
--   * per-network cap: 10 -> 3 new rows per ip_hash per 24h
--   * one wallet, one signup: a wallet already on the list cannot be attached
--     to a second email
-- Same signature, so the edge function call is unchanged.

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

  -- New email → soft per-IP cap: at most 3 new rows per ip_hash in 24h.
  if coalesce(p_ip_hash, '') <> '' then
    select count(*) into v_recent
      from waitlist
     where ip_hash = p_ip_hash
       and created_at > now() - interval '24 hours';
    if v_recent >= 3 then
      return 'rate_limited';
    end if;
  end if;

  -- One wallet, one signup: a wallet already on the list cannot be attached to
  -- a second email. (2026-09-26: one wallet arrived behind five throwaway
  -- addresses in seven seconds, probing whether signups feed the allowlist.)
  if coalesce(p_wallet, '') <> '' and exists (
       select 1 from waitlist where wallet = lower(p_wallet)) then
    return 'rate_limited';
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
