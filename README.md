# TimbSwap

A Uniswap-V2-style DEX and on-chain prize game on Arbitrum.

- **App:** https://timbswap.xyz
- **Network:** Arbitrum (mainnet)
- **License:** see [LICENSE](./LICENSE)

## What's here

| Path | |
|------|--|
| `contracts/` | Solidity sources (DEX, prize game, farms, vault, treasury, governance) |
| `abi/` | Published ABIs |
| `tests/` | Foundry tests |
| `scripts/` | Deploy scripts and keepers (settler, epoch, notifiers) |
| `workers/` | Cloudflare Worker — first-party `/api/*` (RPC + telemetry) |
| `supabase/` | Migrations + edge functions |
| the page dirs | Static frontend (vanilla JS) served on GitHub Pages |

## Configuration

Frontend contract addresses, chain, and RPC live in `config.js`. Values ship as
placeholders — set them for the target deployment. Server-side secrets are never
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
