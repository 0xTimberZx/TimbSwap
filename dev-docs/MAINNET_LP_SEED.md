# Mainnet liquidity seed — blue-chip pools before the game

The DEX has been live on Arbitrum One since 2026-09-11 (Phase 1,
`MAINNET_ADDRESSES.md`). The prize game, the farm and the staking seat come
later, and the airdrop later still. Between now and then the exchange should
have real markets, so the first thing a visitor can do is trade. This document
covers seeding four pools and nothing else.

**These are plain pools.** No emissions, no farm seat, no boost tier, no game
hook. They earn the ordinary 0.25 % LP fee from the first swap, the protocol
takes its 0.05 % into the treasury, and that is the whole economic story. They
do not interact with the TIMBS allocation, the emissions taper, or the airdrop.

## 1. The pools

| Pool | Why |
|---|---|
| WBTC/WETH | the two assets everyone holds; the reference pair |
| WBTC/USDC | a dollar leg for BTC |
| WETH/USDT | a dollar leg for ETH on the stable the campaigns already pay in |
| LINK/WETH | the oracle token the game itself runs on |

Pair creation is permissionless on `TimbSwapFactory` and the router creates a
missing pair on the first `addLiquidity`, so seeding is a wallet holding the
tokens calling the router four times. `scripts/seed-pools.js` does exactly
that, with the guards below.

## 2. The one real risk: the first add sets the price

A new pool has no price until someone adds to it. The ratio of the first add
**is** the price. Seed WBTC/WETH one percent off the market and an arbitrage
bot takes that percent out of the pool in the next block, at the LP's expense,
and keeps doing so on every later drift you seed. So no amount in the script is
typed by hand: each side is derived at run time from a Chainlink feed on
Arbitrum One, and the four feeds are identity-checked (`description()` must be
exactly `BTC / USD` and so on) and freshness-checked before anything is
computed.

An **existing** pool is different. The router ignores the ratio you ask for
and takes the pool's. If the pool has drifted from the feed by more than
`SEED_MAX_DEVIATION_BPS` (default 50), joining it at that ratio loses value,
so the script refuses the pool and says by how much. Arbitrage it first, or
wait for someone else to, then re-run.

Other guards, all before the first transaction: chain id must be 42161; every
token address must return the expected symbol and decimals (a mistyped address
fails here, not by seeding the wrong asset); the wallet must hold enough of
every token for the whole plan, with the shortfall printed per token if not.
Approvals are exact amounts, never unlimited.

## 3. Sizing

`SEED_USD_PER_SIDE` is the dollar value of **each** token in a pool, so a
pool costs twice it, and the four pools together cost eight times it in
inventory, with WETH appearing in three of them. The number is a per-run
decision and is deliberately not recorded here or defaulted in the script:
the dry run prints exactly what it implies before anything is sent.

What depth buys is low price impact. In a constant-product pool a trade of
size `t` against reserves of `R` moves the price by about `t / R`, so a trade
of a tenth of one side moves the price about ten percent, and a trade of a
hundredth moves it about one. The pools exist to make the exchange usable,
not to compete on depth, so start where the inventory is comfortable and add
later: adding to an existing pool at the feed ratio is the same script with
the same guards.

Fee income is 0.25 % of volume to LPs. At these sizes it is small; the pools
are infrastructure, not yield.

## 4. When, and where it sits in the runbook

Any time after Phase 1 and before `startGame`. It does not depend on Phase 2,
the wiring matrix, the vesting wallets, the faucet or the airdrop, and none of
them depend on it. The runbook lists it under §3 next to the TIMBS/WETH seed,
which remains a separate step with its own price logic (the launch FDV,
`EMISSIONS_SCHEDULE.md` §7), because that pool's first add is a policy
decision and these four are market-following.

LP tokens go to `SEED_LP_TO`. Use the Safe, not the sending wallet: the LP
position is protocol inventory and should sit with the other treasury assets,
and removing liquidity later is then a Safe transaction like any other.

## 5. Running it

```
# in .env.mainnet (gitignored): the Pool seeding block from env.mainnet.example,
# every address re-read from Arbiscan and the Chainlink feed list, never typed
# from memory. SEED_PRIVATE_KEY only for --execute; read -s it in, never paste.
node scripts/seed-pools.js --self-test     # pure math, no network
node scripts/seed-pools.js                 # dry run: feeds, plan, balances
node scripts/seed-pools.js --execute       # sends
```

The dry run is the review. It prints the feed prices it will use, the exact
amounts per pool with their minimums, whether each pool is a create, an empty
pair or a join, and the wallet's balance against the total need. Nothing about
the execute path differs except that it sends.

## 6. Frontend follow-ups (mainnet cutover, not now)

- The mainnet `config.js` token list needs a WBTC entry (symbol, address,
  8 decimals) so the swap page can pick it, and real addresses for USDC, USDT
  and LINK where the mirror currently carries zeros.
- The explore page prices pools in USD through the USDC/WETH pair. With no
  such pair, WETH-side values show unpriced until one exists; WBTC/USDC gives a
  dollar anchor for BTC but not for ETH. Either add a small USDC/WETH pool or
  teach the explore page to anchor on USDT/WETH as well. Not required for the
  pools to trade.
- None of these tokens need to be in `EligibleTokenRegistry`. Eligibility only
  decides which swaps nudge the game meter once the game is running; it has no
  effect on pools, fees or the swap page.
