# TimbSwap first-party API (Cloudflare Worker)

`timbswap-api.js` serves the app's on-chain reads from the site's **own origin**
so Brave Shields / adblockers can't throttle or block them (they were failing as
third-party calls to Alchemy). It handles POST routes and passes everything else
through to the origin (GitHub Pages):

| Route | Forwards to | Purpose |
|-------|-------------|---------|
| `POST /api/rpc` | Alchemy JSON-RPC (`ALCHEMY_RPC_URL`) | all on-chain reads (single + batch) |
| `POST /api/waitlist` | Supabase `waitlist` edge fn (`WAITLIST_UPSTREAM`) | mainnet signup capture |
| `POST /api/quests` | Supabase `quests` edge fn (`QUESTS_UPSTREAM`) | read-only leaderboard |
| `POST /api/faucet-claim` | Supabase `faucet-claim` edge fn (`FAUCET_UPSTREAM`) | faucet claim gatekeeper (adds `X-Real-IP` for Turnstile; optional `FAUCET_PROXY_SECRET`) |

Because `/api/*` is **same-origin** with the site, the browser skips CORS and
Brave treats it as first-party — the RPC issues (and now the signup POST)
disappear for every browser. For `/api/waitlist` the Worker also forwards the
caller's real IP (`X-Real-IP`) and country (`X-Client-Country`) — which only
Cloudflare sees — plus an optional `X-Proxy-Secret`, so the public Supabase
function can trust only proxied calls. See `dev-docs/WAITLIST.md`.

> **Removed:** `POST /api/debughub_events` (DebugHub telemetry sink). Client
> telemetry is localStorage-only during the capped beta (see `config.js`), so
> nothing calls it, and an unauthenticated service-role write sink was pointless
> surface. The `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` secrets are now unused
> — delete them in the Cloudflare dashboard. See `SECURITY.md` before re-adding a
> sink (harden it and bring it into bounty scope first).

## Migration steps (one-time)

1. **Move `timbswap.xyz` to Cloudflare (free plan).**
   - Add the site in the Cloudflare dashboard; it imports your existing DNS.
   - Change the domain's nameservers (at your registrar) to the two Cloudflare
     nameservers Cloudflare shows you. Wait for "Active" (usually minutes–hours).
   - Keep the GitHub Pages records **Proxied** (orange cloud) so the Worker route
     can sit in front. GitHub Pages custom-domain setup is unchanged.

2. **Deploy the Worker.**
   ```sh
   cd workers
   npx wrangler login
   npx wrangler secret put ALCHEMY_RPC_URL            # the keyed Alchemy Arbitrum-One URL
   # For the waitlist route: set WAITLIST_UPSTREAM in wrangler.toml [vars] first, then
   npx wrangler secret put WAITLIST_PROXY_SECRET      # optional; must match the waitlist fn
   # For the faucet route: set FAUCET_UPSTREAM in wrangler.toml [vars] first, then
   npx wrangler secret put FAUCET_PROXY_SECRET        # optional; must match the faucet-claim fn
   npx wrangler deploy
   ```
   `wrangler.toml` already pins the route `timbswap.xyz/api/*` and the entrypoint.

3. **Smoke-test the routes** (from any terminal):
   ```sh
   # RPC — expect a JSON-RPC result, e.g. {"jsonrpc":"2.0","id":1,"result":"0xa4b1"}
   curl -s https://timbswap.xyz/api/rpc \
     -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'

   # Waitlist — expect {"ok":true,"status":"new"}
   curl -s https://timbswap.xyz/api/waitlist \
     -H 'content-type: application/json' \
     -d '{"email":"you@example.com","source":"smoke-test"}'

   # Faucet — expect 403 "No active ticket…" for a random address (proves the
   # route + edge fn are reachable; a real claim needs an Active ticket + Turnstile)
   curl -s https://timbswap.xyz/api/faucet-claim \
     -H 'content-type: application/json' \
     -d '{"address":"0x0000000000000000000000000000000000000001"}'
   ```

4. **Tell Claude "Cloudflare is live"** and the config flip lands:
   - `config.js`: `DEDICATED_RPC` → `https://timbswap.xyz/api/rpc`

   Until that flip, the app keeps using the fallback RPC, so nothing breaks while
   DNS propagates.

## Notes
- The `ALCHEMY_RPC_URL` upstream is a public frontend RPC regardless; keeping it
  a Worker secret just lets you rotate it without a redeploy of the site.
- The full waitlist deploy (DB migration + edge function + Worker) is documented
  in `dev-docs/WAITLIST.md`.
- Supersedes the earlier standalone `debughub-relay.js`; the telemetry relay it
  folded in has since been removed (see the note above).
