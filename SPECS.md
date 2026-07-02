# TimbSwap — Project Specs & Development Notes

**Protocol:** TimbSwap  
**Token:** TIMBS  
**Network:** Arbitrum Sepolia (Chain ID: 421614)  
**Repo:** github.com/0xTimberZx/TimbSwap  
**Live:** 0xtimberzx.github.io/TimbSwap/  
**DebugHub:** 0xtimberzx.github.io/MyDapp/debughub/  
**Pragma:** `pragma solidity 0.8.24` — exact, never `^`  
**Compiler:** viaIR enabled, optimizer 200 runs, EVM london  
**Verification:** Sourcify preferred  
**Last updated:** July 2026

---

## Deployed Contracts — Arbitrum Sepolia

| Contract | Address | Verified |
|----------|---------|---------|
| PrizeEscrow | 0x865C50d933e63BbE388EEAFa017AE634B0A6fB6D | Sourcify ✅ |
| TIMBSToken (TIMBS) | 0x2Aaa61E2c08Ff61c93E960EcCd5Dd7fedF0bfaAa | Sourcify ✅ |
| TimbSwapFactory | 0xCCd6d3f0A86042d2B7056eDd381d367126628AF5 | Sourcify ✅ |
| TimbSwapRouter v3 | 0x781833D60800b93C3a9EFf234b15934F9AE0C5E7 | Sourcify ✅ |
| EligibleTokenRegistry | 0xbFF59a3408B2574AcE948F130f0fA2f2CB149F04 | Sourcify ✅ |
| GameRegistry | 0xf6fC4c726071Bd2Ce32826324E52dfC5A24FCb97 | Sourcify ✅ |
| TimbPrize | 0x257F3658e29a7026CeebdcB352509d82A0993e4b | Sourcify ✅ |
| TimbStaking | 0xe776c7b700B190ED8248741F9b518B08d8733C8F | Sourcify ✅ |
| TimbFarm | 0xE319E2206F71A5cD8dd2c411C6F29712935f9011 | Sourcify ✅ |
| TimbLockVault | 0x0157086E7670D1eFb15DC6b5158eE78279927a41 | Sourcify ✅ |
| TimbTreasury | 0x486Fa4D8351EF81136E83340eA1e3aa2272c9955 | Sourcify ✅ |
| TimbGovernance | 0x8a324EfDc457BfB9Cf3D077E4CBC5A16a1c6a061 | Sourcify ✅ |
| TIMBS/ETH Pair | 0x5a911CBfD2808Ad5214E842a0E8ae34d8199BB95 | via Factory ✅ |
| WETH (Arb Sepolia) | 0x980B62Da83eFf3D4576C647993b0c1D7faf17c73 | — |
| DAPP Token | 0x3d0cB8929c22F93A9dd33921E6f43C1621FCfC04 | — |

### Router Version History

| Version | Address | Status |
|---------|---------|--------|
| v1 | 0x1f4C522E55FfE336eD474e6deAAc3a4bBe3Fd117 | Retired |
| v2 | 0xf69ca9Ac2E39aD5f86A8410b10D290A49984e6AB | Retired |
| v3 | 0x781833D60800b93C3a9EFf234b15934F9AE0C5E7 | **Current** |

### Deprecated / Dead Addresses

| Address | Reason |
|---------|--------|
| 0x06aebE938113524D9E29C51BacE7d7A155051a60 | Old factory — no bytecode redeployed |
| 0xefFea3C2D1aA32eE9D93Cc0E888647E6A168293f | Phantom pair — 500k TIMBS permanently locked (treated as burned) |

---

## Deployment Log

- [x] All 13 contracts deployed + Sourcify verified
- [x] Factory v2 + Router v3 deployed after phantom pair bug fix
- [x] TIMBS/ETH pair created with real bytecode (0x5a911CB…)
- [x] All contracts wired and re-pointed to Router v3
- [x] PrizeEscrow seeded with ETH (tx: 0x0e03bc015b64df175a932f5129d4ebc9f23fe5bd48afbb7a0866cb456510b808)
- [x] TimbStaking funded: 25e18 TIMBS, 2592000s
- [x] TimbFarm funded: 50e18 TIMBS, 2592000s
- [x] startGame() called — Round #1 LIVE
- [x] GitHub Actions settler running — confirmed green run #63
- [x] DebugHub TimbSwap tab live
- [x] All 7 frontend pages deployed to GitHub Pages

### Permanent Burn Event

| Field | Detail |
|-------|--------|
| Amount | 500,000 TIMBS (0.5% of supply) |
| Address | 0xefFea3C2D1aA32eE9D93Cc0E888647E6A168293f |
| Cause | Phantom pair — no bytecode, unrecoverable |
| Date | June 2026 |
| Effect | Effective circulating supply ~99.5M TIMBS |

---

## Core Principle

The game should be entertaining even if the token price is flat. Revenue comes from gameplay and trading volume, not token inflation. TIMBS represents ownership of the ecosystem. Player entry principal is always refundable — zero capital risk to participate.

---

## Protocol Architecture

### Fee Structure

| Fee | Amount | Destination |
|-----|--------|-------------|
| Total swap fee | 0.3% | — |
| LP share | 0.25% | Liquidity providers |
| Protocol share | 0.05% | TimbTreasury |
| Protocol game cut | Owner-set % | TimbTreasury |
| Buyback burn | 50% of purchased TIMBS | Burned via burn() |
| Buyback staking | 50% of purchased TIMBS | TimbStaking distributions |

### Capital Bucket Separation — Never Violate

```
GameRegistry escrow    → player principal only, always refundable
PrizeEscrow            → protocol-funded prize ETH only
TimbTreasury           → protocol revenue, buybacks, operations
```

These three buckets must never mingle.

### Prize Game

- **Round:** 6 segments × 60 min = 6 hours
- **Segment:** 59:45 interaction + 0:15 settlement
- **Scroll:** positionCounter +1 per eligible swap, never resets
- **Window:** alphabet[(counter+i) % 36] for i 0–5
- **Freeze:** keccak256(blockhash(n-1) + counter + round) % 3 offset
- **Entry:** 6 chars, A-Z + 0-9, no repeats, plays in round N+1
- **Payout:** floor(pot/n) × n, remainder r snowballs
- **Claim window:** 2 rounds after lastEligibleRound
- **Verification:** dual-layer — verifyEntryExisted() + verifyEntryValid()

---

## Frontend

### Pages

| Page | URL | Status |
|------|-----|--------|
| Landing | /TimbSwap/ | ✅ Live |
| Swap | /TimbSwap/frontend/swap/ | ✅ Live |
| Compete | /TimbSwap/frontend/compete/ | ✅ Live |
| Farm | /TimbSwap/frontend/farm/ | ✅ Live |
| Lock Vault | /TimbSwap/frontend/lock/ | ✅ Live |
| Governance | /TimbSwap/frontend/gov/ | ✅ Live |
| Analytics | /TimbSwap/frontend/analytics/ | ✅ Live |

### Path Rule

Inner pages at `frontend/*/index.html` use `../style.css` and `../config.js`.  
Root `index.html` uses `frontend/style.css` and `frontend/config.js`.  
Both `style.css` and `config.js` exist at repo root AND `frontend/` — root copies serve the landing page only.

### Key Frontend Rules

- ethers CDN: `cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js`, no `type` attribute
- Gas: `getFeeData()` × 1.30 on both fee params + 50% gasLimit buffer
- Nonce: explicit `getTransactionCount(address, "pending")` on every write
- Wallet persistence: `autoReconnect()` via sessionStorage on every page load
- DebugHub stub: always defined after SDK script tag — never let it break the page

---

## Settler Automation

| Setting | Value |
|---------|-------|
| Schedule | Every 10 minutes (cron) |
| Health check | Daily at 12:00 UTC |
| Working directory | `scripts` (plural) |
| Node version | 22 |
| Retry logic | Up to 3 attempts with 8s backoff |
| Error categories | NONCE / FUNDS / REVERT / NETWORK / GAS / UNKNOWN |

### Required GitHub Secrets

| Secret | Description |
|--------|-------------|
| `ARB_SEPOLIA_RPC` | Arbitrum Sepolia RPC URL (Alchemy/Infura/public) |
| `SETTLER_PRIVATE_KEY` | Deployer wallet private key (no 0x prefix) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token — regenerate after any exposure |
| `TELEGRAM_CHAT_ID` | `8726225587` |

---

## Tokenomics

| Parameter | Value |
|-----------|-------|
| Hard cap | 100,000,000 TIMBS |
| Effective supply | ~99,500,000 TIMBS |
| Entry cost | 100 TIMBS (governance-adjustable) |
| Buyback burn ratio | 50% (adjustable via TimbTreasury) |
| Emissions | Governance-unlockable, off by default |
| Protocol fee | 0.05% of swap volume |

---

## DebugHub Integration

**appName:** `TimbSwap`

Error catalog lives in `MyDapp/debughub/app.js` → `ERROR_EXPLANATIONS`.  
**Must evolve** — add new entries every time a new error pattern is encountered.  
Never treat the catalog as complete.

### Checkpoint Format

```
Module:Action Stage
e.g. Swap:Approve Confirmed / Prize:Claim Failed / Gov:Vote Submitted
```

---

## Ecosystem Notes

TimbSwap is isolated from BlockpotDAO/MessageBoard/0xFaucet at launch.  
All four share the DebugHub dashboard.  
Deployer: `0x42536623b503D4926DfAF6173B0357b7DfD19800`

Optional future hook: partner pool flag routes LP fees to BlockpotDAO PrizeVault v3 (not active at launch).
