# TimbSwap

A Uniswap-V2-style DEX and on-chain prize game on Arbitrum.

- **App:** https://timbswap.xyz
- **Start here:** https://timbswap.xyz/start/ — first round in 2 minutes, no extension needed
- **Network:** Arbitrum (mainnet)
- **License:** see [LICENSE](./LICENSE)

Connect with an extension / in-app wallet, or **Continue with email** — a one-time code creates an
embedded wallet ([Privy](https://www.privy.io/)) that is an ordinary Ethereum address, with a
confirmation sheet before every action, optional authenticator-app or passkey MFA, private-key
export, and a 360-minute idle timeout. Details: [`dev-docs/EMAIL_LOGIN.md`](./dev-docs/EMAIL_LOGIN.md).

## What's here

| Path | |
|------|--|
| `contracts/` | Solidity sources (DEX, prize game, farms, vault, treasury, governance) |
| `abi/` | Published ABIs |
| `assets/`, `vendor/` | Email-wallet sheet (`email-login.js`) and the esbuild bundles it loads (Privy core, WebAuthn, HPKE, QR); rebuilt by `scripts/build-vendor.mjs` |
| `tests/` | Foundry tests |
| `scripts/` | Deploy scripts, keepers (settler, epoch, faucet, notifiers), the witness fleet (heartbeat, settler liveness, epoch / faucet / points reconciliation, dead-man switch; `dev-docs/KEEPER_FLEET.md`), their shared plumbing in `lib/`, and `seed-pools.js` for the mainnet pools (`dev-docs/MAINNET_LP_SEED.md`) |
| `workers/` | Cloudflare Worker — first-party `/api/*` (RPC + telemetry) |
| `supabase/` | Migrations + edge functions |
| the page dirs | Static frontend (vanilla JS) served on GitHub Pages |

## Configuration

Frontend contract addresses, chain, and RPC live in `config.js`. Values ship as
placeholders — set them for the target deployment. `PRIVY_APP_ID` (a public app
id) turns the email wallet on; an empty string hides the option entirely. Server-side secrets are never
committed; see `env.example` for the variable names and provide them via your CI
secrets / Worker secrets.

## Build & test

```sh
forge build
forge test
```

## Deploy

Deploy scripts are under `scripts/` (Foundry). Provide the required env vars
(see `env.example`) via your secrets manager — never commit real keys.
