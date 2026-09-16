# Mainnet waitlist (capture layer)

Turns landing-page traffic into an owned list instead of letting it bounce.
Three moving parts, all on rails the app already runs on:

| Part | File | Role |
|------|------|------|
| Frontend | `index.html` (section) + `waitlist.css` + `waitlist.js` | email + optional wallet/Telegram form; captures UTM + referrer |
| Transport | `workers/timbswap-api.js` → `POST /api/waitlist` | same-origin proxy (first-party, so Brave/adblockers don't drop it) |
| Backend | `supabase/functions/waitlist` + `supabase/migrations/20260912000000_waitlist.sql` | validate, dedupe, salted-IP rate-limit, store |

The frontend never talks to Supabase directly — it POSTs same-origin to the
Worker, which relays to the edge function. Same reasoning as the RPC proxy in
`config.js` (Brave Shields throttle third-party calls).

## Data captured

`email` (required), `wallet` + `telegram` (optional), plus attribution:
`utm_source/medium/campaign`, `ref` (referrer), `landing` (path), `country`
(coarse, from Cloudflare), and a **salted SHA-256 hash of the IP** — never the
raw IP. RLS is ON with no anon policy, so rows are unreadable with the
publishable key (same hardening as `faucet_claims`).

## Deploy (one-time)

### 1. Database
```sh
supabase db push          # applies migrations/20260912000000_waitlist.sql
```

### 2. Edge function
```sh
supabase functions deploy waitlist --no-verify-jwt
# Project Settings → Edge Functions → Secrets:
#   WAITLIST_IP_SALT        <random string>          (required — salts the IP hash)
#   WAITLIST_PROXY_SECRET   <random string>          (optional — must match the Worker's)
#   WAITLIST_TG_CHAT_ID     <your private chat id>   (optional — founder ping per new signup)
#   RESEND_API_KEY          <resend key>             (optional — sends the confirmation email per NEW signup)
#   WAITLIST_FROM           "TimbSwap <hello@timbswap.xyz>"  (optional — verified Resend domain, SPF/DKIM)
#   WAITLIST_UNSUB_MAILTO   hello@timbswap.xyz       (optional — unsubscribe inbox)
# SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected; TELEGRAM_BOT_TOKEN is reused.
# Without RESEND_API_KEY the function behaves exactly as before (no email; signup still saved).
```

### 3. Worker
```sh
cd workers
# Set the upstream (the deployed function URL) as a var in wrangler.toml:
#   WAITLIST_UPSTREAM = "https://<supabase-ref>.supabase.co/functions/v1/waitlist"
npx wrangler secret put WAITLIST_PROXY_SECRET   # optional; same value as the function's
npx wrangler deploy
```

### 4. Smoke-test
```sh
curl -s https://timbswap.xyz/api/waitlist \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","source":"smoke-test"}'
# expect: {"ok":true,"status":"new"}   (a second call → "updated")
```

## Reading the list

Service-role only (RLS blocks the anon key). In the Supabase SQL editor:
```sql
select created_at, email, wallet, telegram, utm_source, country
  from waitlist
 order by created_at desc;

-- Which channel is converting?
select coalesce(nullif(utm_source,''),'(direct)') as channel, count(*)
  from waitlist group by 1 order by 2 desc;
```

## Notes
- The founder Telegram ping is best-effort — a failed send never fails the signup.
- `confirmed` is reserved for a future double-opt-in step; nothing sets it yet.
- Before any public export or CSV, remember these are real emails — treat as PII.
