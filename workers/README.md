# TimbSwap first-party API (Cloudflare Worker)

`timbswap-api.js` serves the app's backend calls from the site's **own origin**
so Brave Shields / adblockers can't throttle or block them (they were failing as
third-party calls to Alchemy/Supabase). It handles two POST routes and passes
everything else through to the origin (GitHub Pages):

| Route | Forwards to | Purpose |
|-------|-------------|---------|
| `POST /api/rpc` | Alchemy JSON-RPC (`ALCHEMY_RPC_URL`) | all on-chain reads (single + batch) |
| `POST /api/debughub_events` | Supabase REST (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`) | DebugHub telemetry |

Because `/api/*` is now **same-origin** with the site, the browser skips CORS and
Brave treats it as first-party — the RPC and telemetry issues both disappear for
every browser.

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
   npx wrangler secret put ALCHEMY_RPC_URL            # the keyed Alchemy Arb-Sepolia URL
   npx wrangler secret put SUPABASE_URL               # https://REPLACE_WITH_MAINNET_SUPABASE_REF.supabase.co
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY  # Supabase service-role key (server-side only)
   npx wrangler deploy
   ```
   `wrangler.toml` already pins the route `timbswap.xyz/api/*` and the entrypoint.

3. **Smoke-test the routes** (from any terminal):
   ```sh
   # RPC — expect {"jsonrpc":"2.0","id":1,"result":"0x66eee"}
   curl -s https://timbswap.xyz/api/rpc \
     -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'

   # Telemetry — expect HTTP 204
   curl -s -o /dev/null -w '%{http_code}\n' https://timbswap.xyz/api/debughub_events \
     -H 'content-type: application/json' \
     -d '{"app":"TimbSwap","type":"checkpoint","name":"relay-smoke","status":"pass"}'
   ```

4. **Tell Claude "Cloudflare is live"** and the config flip lands:
   - `config.js`: `DEDICATED_RPC` → `https://timbswap.xyz/api/rpc`
   - `config.js` DebugHub: `telemetryUrl` → `https://timbswap.xyz/api/debughub_events`

   Until that flip, the app keeps using the Supabase-hosted proxy + direct
   telemetry, so nothing breaks while DNS propagates.

## Notes
- The service-role key stays a Worker secret — never in page JS. (Anon key also
  works, since RLS already allows the telemetry insert; service-role is what the
  earlier relay used.)
- The `ALCHEMY_RPC_URL` upstream is a public frontend RPC regardless; keeping it
  a Worker secret just lets you rotate it without a redeploy of the site.
- Supersedes the earlier standalone `debughub-relay.js` (folded into this Worker).
