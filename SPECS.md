# TimbSwap — Project Specs & Development Notes

**Protocol:** TimbSwap  
**Token:** TIMBS  
**Network:** Arbitrum Sepolia (Chain ID: 421614)  
**Repo:** Separate GitHub repo — 0xtimberzx/timbswap  
**Docs site:** docs.timbswap.xyz (separate)  
**DebugHub appName:** `TimbSwap` (section-tagged checkpoints per module)  
**Verification:** Sourcify preferred over Etherscan  
**Pragma:** `pragma solidity 0.8.24` — exact, never `^`  
**Last updated:** June 2026

---

## Deployed Contracts — Arbitrum Sepolia

| Contract | Address | Verified |
|----------|---------|---------|
| PrizeEscrow | 0x865C50d933e63BbE388EEAFa017AE634B0A6fB6D | Sourcify ✅ |
| TIMBSToken (TIMBS) | 0x2Aaa61E2c08Ff61c93E960EcCd5Dd7fedF0bfaAa | Sourcify ✅ |
| TimbSwapFactory | 0xCCd6d3f0A86042d2B7056eDd381d367126628AF5 | Sourcify ✅ |
| TimbSwapRouter | 0xf69ca9Ac2E39aD5f86A8410b10D290A49984e6AB | Sourcify ✅ |
| EligibleTokenRegistry | 0xbFF59a3408B2574AcE948F130f0fA2f2CB149F04 | Sourcify ✅ |
| GameRegistry | 0xf6fC4c726071Bd2Ce32826324E52dfC5A24FCb97 | Sourcify ✅ |
| TimbPrize | 0x257F3658e29a7026CeebdcB352509d82A0993e4b | Sourcify ✅ |
| TimbStaking | 0xe776c7b700B190ED8248741F9b518B08d8733C8F | Sourcify ✅ |
| TimbFarm | 0xE319E2206F71A5cD8dd2c411C6F29712935f9011
(0xA07A46f6DF4CBb8cEE9426fa2697756B708cD495.. new)| Sourcify ✅ |
| TimbLockVault | 0x0157086E7670D1eFb15DC6b5158eE78279927a41 | Sourcify ✅ |
| TimbTreasury | 0x486Fa4D8351EF81136E83340eA1e3aa2272c9955 | Sourcify ✅ |
| TimbGovernance | 0x8a324EfDc457BfB9Cf3D077E4CBC5A16a1c6a061 | Sourcify ✅ |
| TIMBS/ETH Pair | 0x5a911CBfD2808Ad5214E842a0E8ae34d8199BB95 | via Factory ✅ |

## Deployment Log

- [x] PrizeEscrow deployed + verified
- [x] TIMBSToken deployed + verified
- [x] TimbSwapFactory deployed + verified (v2: 0xCCd6d3f0A86042d2B7056eDd381d367126628AF5)
- [x] TimbSwapRouter deployed + verified (v2: 0xf69ca9Ac2E39aD5f86A8410b10D290A49984e6AB)
- [x] EligibleTokenRegistry deployed + verified
- [x] GameRegistry deployed + verified
- [x] TimbPrize deployed + verified (v2: 0x257F3658e29a7026CeebdcB352509d82A0993e4b) (v2: 0x257F3658e29a7026CeebdcB352509d82A0993e4b)
- [x] TimbStaking deployed + verified
- [x] TimbFarm deployed + verified
- [x] TimbLockVault deployed + verified
- [x] TimbTreasury deployed + verified
- [x] TimbGovernance deployed + verified
- [x] TIMBS/ETH Pair created via factory (real bytecode: 0x5a911CBfD2808Ad5214E842a0E8ae34d8199BB95)
- [x] All contracts wired (setters called)
- [x] PrizeEscrow seeded with ETH 
- [x] notifyRewardAmount() — TimbStaking (25000000000000000000 TIMBS, 2592000s)
- [x] notifyRewardAmount() — TimbFarm (50000000000000000000 TIMBS, 2592000s)
- [x] All contracts rewired after factory/router/pair/prize redeploy
- [x] startGame() — TimbPrize (v2) — GAME IS LIVE

---

## Core Principle

The game should be entertaining even if the token price is flat.
Revenue comes from gameplay and trading volume, not token inflation.
TIMBS represents ownership of the ecosystem, not just a reward token.
Player entry principal is always refundable — zero capital risk to participate.

---

## Ecosystem Relationship

TimbSwap is fully isolated at deploy. Does not share contracts with the existing
0xtimberzx ecosystem (BlockpotDAO, MessageBoard, 0xFaucet) at launch. The DAPP
token address may be referenced by address only (importable pool token).

**Future cross-ecosystem hook (opt-in, not at launch):**
- Partner pool flag — any TimbSwap pool can route its LP fees to BlockpotDAO PrizeVault v3.

---

## Navigation Structure

```
Dashboard     → Swap · Analytics · Governance
Earn TIMBS    → Farm · Compete · Airdrop (soon)
Tools         → Lock vault · Docs · Debugger
```

---

## Contract Architecture

### Build Order

| # | Contract | Purpose | Status |
|---|----------|---------|--------|
| 1 | TIMBSToken.sol | ERC-20, fixed supply + governance-unlockable emissions | ✅ Deployed |
| 2 | TimbSwapFactory.sol | Pair creation, 0.3% fee, partner pool flag | ✅ Deployed |
| 3 | TimbSwapRouter.sol | Swap routing, fee split, nudgeScroll hook | ✅ Deployed |
| 4 | TimbSwapPair.sol | AMM pair, LP tokens | ✅ Deployed (via factory) |
| 5 | TimbStaking.sol | TIMBS staking, ETH revenue share + buyback distributions | ✅ Deployed |
| 6 | TimbFarm.sol | TIMBS/ETH LP farm pool | ✅ Deployed |
| 7 | TimbLockVault.sol | ERC-20 locking 24–320h, public registry | ✅ Deployed |
| 8 | EligibleTokenRegistry.sol | Shared eligible token list (swap influence + prize) | ✅ Deployed |
| 9 | GameRegistry.sol | Entry storage, escrow, string validation, lifecycle | ✅ Deployed |
| 10 | TimbPrize.sol | Round logic, segments, scroll, settlement, payouts | ✅ Deployed |
| 11 | PrizeEscrow.sol | Holds prize ETH, pays winners on TimbPrize instruction | ✅ Deployed |
| 12 | TimbTreasury.sol | Fee routing, buyback execution, protocol split | ✅ Deployed |
| 13 | TimbGovernance.sol | Proposals, TIMBS-balance voting, hybrid execution | ✅ Deployed |

---

## Revenue & Fee Structure

### Swap Fees
| Fee | Amount | Destination |
|-----|--------|-------------|
| Total swap fee | 0.3% | — |
| LP share | 0.25% | Liquidity providers |
| Protocol share | 0.05% | TimbTreasury |

### Round Settlement Cut
| Cut | Amount | Destination |
|-----|--------|-------------|
| Protocol game fee | Owner-set % | TimbTreasury |
| Prize pool | Remainder | PrizeEscrow (winners) |
| Snowball (r) | Pot remainder mod winners | Next round pot |

### Treasury Flow
```
TimbTreasury receives:
  → swap protocol fees (0.05%)
  → round settlement cut
  → expired unclaimed winnings dividend (owner-toggle)

TimbTreasury executes:
  → buyback TIMBS from market
      50% burned (deflationary)
      50% distributed to TimbStaking pool
  → remainder to prize pot top-up + operations
```

---

## Prize Game — Full Spec

### Round Structure
- Perpetual, self-continuing rounds
- 6 hours per round = 6 segments × 60 min
- Each segment: 59:45 user interaction + 0:15 blockchain settlement
- Segment timing enforced on-chain (settler call reverts if too early)
- Settler = owner wallet initially, architecture supports automation

### Scroll Mechanic
- positionCounter uint256, increments +1 per eligible swap
- 36-char alphabet: A–Z + 0–9, fixed sequence
- 6-char window = alphabet[(counter+i) % 36] for i 0–5
- shuffleEnabled owner toggle for future reshuffle testing
- ScrollShifted(uint256 newPosition) emitted per nudge
- Router calls TimbPrize.nudgeScroll() after confirmed eligible swap
- Frontend: getRoundState() view + event listener + 2–3s poll fallback

### Settlement Freeze
- freezePosition() entropy: keccak256(blockhash(block.number-1) + positionCounter + roundNumber)
- Random 3-second offset within 0:15 window
- Winning string frozen and recorded on-chain
- VRF swap-in point noted for mainnet upgrade

### Entry Rules
- 1 string per wallet per round (replaceable)
- 6 chars, A–Z + 0–9 only, all caps, no repeating chars
- Entries set in round N → play in round N+1 (no mid-round entries)
- UI shows identical entry count after string set
- Entry always refundable (principal escrow, ringfenced)

### Winners & Payouts
- Exact 6-char match only, no partials
- Pot x → floor(x/n) × n distributed equally, r rolls to next round
- Dual-layer verification: existed at round start + valid at settlement
- Claim: claimWinnings(uint256 roundNumber) — auto-lookup via msg.sender
- Claim window: open while player active, expires 2 rounds after lastEligibleRound
- Unclaimed + ineligible → protocol dividend back to prize pot or treasury

---

## Staking & Farm

| Pool | Reward Source | Type |
|------|--------------|------|
| TIMBS single-asset | Treasury TIMBS allocation + buyback distributions | Fixed distribution |
| TIMBS/ETH LP | TIMBS distributions + 0.25% swap fees | Emissions + fees |
| DAPP/ETH | 0.25% swap fees only | Standard |
| LINK/ETH | 0.25% swap fees only | Standard |
| Any imported pair | 0.25% swap fees only | Standard |

**Mechanics:** Free add/reduce/withdraw anytime, no lock, no penalty.
No unique stake IDs — accumulated balance per address.

---

## Lock Vault

| Parameter | Value |
|-----------|-------|
| Duration range | 24–320 hours |
| Accepted tokens | Default whitelist + permissionless import |
| Custody | Contract holds tokens, returns at unlock |
| Early exit | Not permitted |
| Visibility | Public registry, searchable, watchlist |
| TIMBS locks | Badge/highlight in UI |

---

## Governance

| Parameter | Value |
|-----------|-------|
| Voting power | TIMBS balance in governance contract |
| Proposal rights | Owner only (community votes) |
| Execution | Hybrid — on-chain proposals + votes, owner-executed |
| Separation | Fully separate from staking |

---

## DebugHub Integration

**appName:** TimbSwap (single, section-tagged)

**Standing checklist (every write function):**
1. maxFeePerGas / maxPriorityFeePerGas from getFeeData() × 1.30
2. Explicit nonce via getTransactionCount(address, "pending")
3. X Requested → X Submitted → X Confirmed checkpoints
4. logError(functionName, error) + X Failed in catch block

---

## Ecosystem Dev Notes (Carried Forward)

- ethers CDN: cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js, no type attribute
- Gas mobile: getFeeData() × 1.30 both fee params, 50% gasLimit buffer
- Nonce: explicit getTransactionCount(address, "pending") on every write
- DebugHub stub: always define fallback no-op after SDK script tag
- Requested checkpoint: log immediately before every await contract.method()
- Script path: SDK src must be exact path
- Stale wallet: "no popup, no error" on specific device → check WalletConnect session first
