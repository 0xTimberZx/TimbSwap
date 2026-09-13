# Faucet + Airdrop — go-live runbook

Tick-through for taking the faucet (Arbitrum **Sepolia**) and the TIMB airdrop
(Arbitrum **One**) live. Code is merged; every step below is **operator work**
(keys / deploys / secrets). Nothing is exposed until Part B's final flip.

> **The golden rule:** the **faucet is testnet** (Sepolia addresses) and the
> **airdrop is mainnet** (Arb One). Never cross the two address sets.

---

## Part A — Testnet gas faucet (Arbitrum Sepolia)

### A1. Deploy `GasFaucet`
`.env` (never commit):
```
DEPLOYER_PRIVATE_KEY=…            # deployer (becomes faucet owner)
TREASURY_ADDRESS=…                # TimbTreasury (Sepolia)
TIMBS_ADDRESS=…                   # TIMBSToken (Sepolia)
GAME_REGISTRY_ADDRESS=…           # GameRegistry (Sepolia)
TIMBPRIZE_ADDRESS=…               # TimbPrize (Sepolia)
FAUCET_DISPATCHER=…               # keeper hot wallet (gas only)
FAUCET_GUARDIAN=0x0               # optional fast-pause key
FAUCET_DRIP_ETH=5000000000000     # 0.000005 ETH to the claimant
FAUCET_POT_ETH=5000000000000      # 0.000005 ETH to the pot
FAUCET_TIMBS_PER_CLAIM=1000000000000000000   # 1 TIMB (or 0 to disable the leg)
FAUCET_COOLDOWN=86400             # 24h
FAUCET_ETH_CAP=…                  # cumulative ETH ceiling (wei)
FAUCET_TIMBS_CAP=…                # cumulative TIMBS ceiling (18dp)
```
```sh
forge script scripts/DeployFaucet.s.sol --rpc-url <SEPOLIA_RPC> --broadcast
```
→ **note the printed GasFaucet address.**

### A2. Treasury wiring (run as the treasury's owner / Safe — not the deployer)
- `treasury.setOperator(<faucet>)`
- `treasury.setOperatorEthCap(<amount>, <windowSeconds>)`
- `treasury.withdrawToken(<TIMBS>, <faucet>, <budget>)`  ← **pre-fund the TIMBS leg**
- Without the first two the ETH legs revert; without the pre-fund the TIMBS leg reverts.

### A3. Supabase — DB + edge function
- Apply migrations if not already: `faucet_claims` + `reserve_faucet_claim` +
  `expire_stale_reservations` (`supabase db push`).
- Deploy the gatekeeper: `supabase functions deploy faucet-claim --no-verify-jwt`
- Set its secrets (Project Settings → Edge Functions):
  ```
  FAUCET_RPC_URL=<SEPOLIA_RPC>
  GAME_REGISTRY_ADDR=<GameRegistry, Sepolia>
  TIMB_YIELD_VAULT_ADDR=<TimbYieldVault, Sepolia>
  TURNSTILE_SECRET=<Cloudflare Turnstile secret>
  FAUCET_PROXY_SECRET=<random>        # optional; must match the Worker's
  # SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected
  ```

### A4. Cloudflare Worker
- In `workers/wrangler.toml` set `FAUCET_UPSTREAM` = the faucet-claim function URL
  (`https://<ref>.supabase.co/functions/v1/faucet-claim`).
- `cd workers && npx wrangler secret put FAUCET_PROXY_SECRET` (optional, must match A3).
- `npx wrangler deploy`

### A5. `config.js` (the LIVE/private config)
- `ADDRESSES.GasFaucet` = the A1 address.
- `window.TURNSTILE_SITE_KEY` = the Turnstile **site** key.
- Confirm `CHAIN_ID` / `CHAIN_NAME` / RPCs point at **Sepolia** (users must be on
  the chain that holds their Active ticket to claim).

### A6. Keeper (GitHub Actions → repo secrets)
```
ARB_SEPOLIA_RPC, FAUCET_DISPATCHER_PRIVATE_KEY,
SUPABASE_URL, SUPABASE_SERVICE_KEY,
TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID        # optional alerts
FAUCET_DISPATCH_TOKEN                        # optional self-chain PAT
```
The `faucet.yml` workflow runs on cron once Actions is enabled.

### A7. Smoke test
- Wallet WITH an Active ticket on Sepolia → claim → gas (+ TIMBS) arrive within a minute.
- Same wallet again → **429** (24h cooldown).
- Address with no ticket → **403**.
- Bad/absent Turnstile → **403**.

**Part A done = the testnet faucet is live.** Part B is optional and independent.

---

## Part B — Real TIMB airdrop (Arbitrum One)

### B1. Deploy `TimbAirdropDistributor`
`.env`:
```
DEPLOYER_PRIVATE_KEY=…
TIMBS_ADDRESS=0x44BC0AB521191E839C3CB5bB20c9d044C8471eA1   # TIMBS on Arb One
AIRDROP_DISPATCHER=…              # the off-chain dispatcher hot wallet
AIRDROP_GUARDIAN=0x0             # optional fast-pause key
AIRDROP_AMOUNT_PER_CLAIM=1000000000000000000   # 1 TIMB
AIRDROP_TOTAL_CAP=…              # hard cumulative ceiling (18dp) — your VaR backstop
AIRDROP_PER_ROUND_CAP=…         # per-round ceiling (18dp)
```
```sh
forge script scripts/DeployAirdropDistributor.s.sol \
  --rpc-url <ARB_ONE_RPC> --broadcast --gas-estimate-multiplier 300
```
→ **note the printed distributor address.** (The 300 multiplier is the Arbitrum
gas-estimation workaround from the game deploy.)

### B2. Pre-fund a SMALL float
- `timbs.transfer(<distributor>, <small budget>)` — a loss you'd accept. This float
  is your entire value-at-risk here.
- Optionally `transferOwnership(<Safe>)` now (Ownable2Step → Safe accepts).

### B3. Supabase — migration + dispatcher
- Apply `supabase/migrations/20260913000000_airdrop.sql` (`supabase db push`).
- `supabase functions deploy airdrop-dispatch` (keep `verify_jwt` ON).
- Set its secrets:
  ```
  AIRDROP_RPC_URL=<ARB_ONE_RPC>
  DISTRIBUTOR_ADDRESS=<B1 address>
  DISTRIBUTOR_PRIVATE_KEY=<dispatcher hot wallet>
  AIRDROP_DISPATCH_SECRET=<random>     # required trigger header
  # optional: AIRDROP_BATCH_LIMIT (50), AIRDROP_LEASE_SECONDS (120)
  ```

### B4. Schedule the dispatcher
- Supabase → Database → Cron (pg_cron), every ~5 min, POST to the airdrop-dispatch
  function URL with header `X-Dispatch-Secret: <AIRDROP_DISPATCH_SECRET>`.
  (Example: `select cron.schedule('airdrop','*/5 * * * *', $$ select net.http_post(
  url:='…/functions/v1/airdrop-dispatch',
  headers:='{"X-Dispatch-Secret":"…"}'::jsonb) $$);`)

### B5. Flip the leg on
- On the **faucet-claim** edge fn set `AIRDROP_ENABLED=true` (+ `AIRDROP_ROUND=1`).
- In **config.js** set `window.AIRDROP_ENABLED = true` (shows the "+ real TIMB"
  explainer on the faucet page).

### B6. Smoke test + risk docs
- A testnet claim → an `airdrop_outbox` row appears → the dispatcher sends TIMB on
  Arb One within a cycle → verify on Arbiscan. Claim again → no double-pay.
- Add the distributor float + caps to `CAPPED_BETA_GUARDRAILS.md` and add the
  distributor to `SECURITY.md` bounty scope (now that it's live).

---

## Verify-with-Claude checkpoint
Before A7 / B6, push your `config.js` + `wrangler.toml` changes to a branch (or
paste the blocks) and I'll check the `addrFromConfig` keys, chain coherence,
edge-fn env, and Worker upstreams against the code. Secrets I can't (and
shouldn't) see — self-verify those against A3/A6/B3.
