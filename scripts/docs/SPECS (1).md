# TimbSwap — Project Specs & Development Notes

**Protocol:** TimbSwap  
**Token:** TIMBS  
**Network:** Arbitrum Sepolia (Chain ID: 421614)  
**Repo:** Separate GitHub repo — 0xtimberzx.github.io/timbswap (or subdomain)  
**Docs site:** docs.timbswap.xyz (separate)  
**DebugHub appName:** `TimbSwap` (section-tagged checkpoints per module)  
**Verification:** Sourcify preferred over Etherscan  
**Pragma:** `pragma solidity 0.8.20` — exact, never `^`  
**Last updated:** June 2026

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
| 1 | `TIMBSToken.sol` | ERC-20, fixed supply + governance-unlockable emissions | ✅ Written |
| 2 | `TimbSwapFactory.sol` | Pair creation, 0.3% fee, partner pool flag | 🔲 Next |
| 3 | `TimbSwapRouter.sol` | Swap routing, fee split, nudgeScroll hook | 🔲 |
| 4 | `TimbSwapPair.sol` | AMM pair, LP tokens | 🔲 |
| 5 | `TimbStaking.sol` | TIMBS staking, ETH revenue share + buyback distributions | 🔲 |
| 6 | `TimbFarm.sol` | TIMBS/ETH LP farm pool | 🔲 |
| 7 | `TimbLockVault.sol` | ERC-20 locking 24–320h, public registry | 🔲 |
| 8 | `EligibleTokenRegistry.sol` | Shared eligible token list (swap influence + prize) | 🔲 |
| 9 | `GameRegistry.sol` | Entry storage, escrow, string validation, lifecycle | 🔲 |
| 10 | `TimbPrize.sol` | Round logic, segments, scroll, settlement, payouts | 🔲 |
| 11 | `PrizeEscrow.sol` | Holds prize ETH, pays winners on TimbPrize instruction | 🔲 |
| 12 | `TimbTreasury.sol` | Fee routing, buyback execution, protocol split | 🔲 |
| 13 | `TimbGovernance.sol` | Proposals, TIMBS-balance voting, hybrid execution | 🔲 |

### Contract Relationships

```
TIMBSToken
  └── Fixed supply, minted to treasury at deploy
  └── Governance-unlockable emissions cap (vote required)
  └── entryCostTIMBS → GameRegistry (derives all entry prices)
  └── buybackRatio → TimbTreasury (50/50 burn/stake, owner-adjustable)

TimbSwapRouter
  └── swap() → splits fee → TimbTreasury (0.05% protocol)
  └── nudgeScroll() → TimbPrize (eligible token + opt-in)
  └── checks EligibleTokenRegistry before nudge

TimbSwapFactory
  └── createPair() → TimbSwapPair
  └── partner pool flag → BlockpotDAO PrizeVault (opt-in, future)

TimbTreasury
  └── receives protocol fees (swap + round settlement cut)
  └── executes buyback: purchases TIMBS from market
      └── 50% burned via TIMBSToken.burn()
      └── 50% sent to TimbStaking as distribution
  └── remainder → prize pot top-up + operations

TimbStaking
  └── distributes TIMBS from treasury-seeded allocation
  └── receives buyback share (50% of purchased TIMBS)
  └── stakers earn: TIMBS distributions + ETH revenue share

GameRegistry
  └── stores entries on-chain (own contract, gameRegistry.sol)
  └── escrow ringfenced (ETH + TIMBS, never mingled with revenue)
  └── entry status updated by: settler at settlement + self on TimbPrize events

TimbPrize
  └── dual-layer verification at settlement via GameRegistry
  └── instructs PrizeEscrow to pay winners
  └── emits RoundSettled → GameRegistry self-updates

PrizeEscrow
  └── holds prize ETH only
  └── pays on TimbPrize instruction
  └── owner/deployer authorised callers
```

---

## TIMBS Token — Final Spec

**File:** `TIMBSToken.sol` ✅  
**Max supply:** 100,000,000 TIMBS  
**Launch allocation:**

| Bucket | % | Amount | Notes |
|--------|---|--------|-------|
| Community | 40% | 40,000,000 | Staking rewards, game distributions, airdrop |
| Treasury | 20% | 20,000,000 | Operations, dev, audits, marketing |
| Liquidity | 15% | 15,000,000 | Seed TIMBS/ETH pool at launch |
| Team | 15% | 15,000,000 | 4-year vesting |
| Strategic Reserve | 10% | 10,000,000 | Partnerships, future programs |

**No continuous emissions at launch.** Small additional emissions cap unlockable
by governance vote only — requires on-chain proposal + TIMBS-holder vote to activate.

**Key parameters (owner/governance-set):**

| Parameter | Description |
|-----------|-------------|
| `entryCostTIMBS` | Single governance param — cascades to all prize entry costs |
| `maxTransferAmount` | Anti-whale per-tx cap (0 = disabled) |
| `transferWhitelist` | Exempt from cap (pools, treasury auto-whitelisted) |
| `paused` | Emergency halt on all transfers |
| `governanceEmissionsCap` | Additional supply unlockable by governance vote |
| `buybackBurnRatio` | % of buyback tokens burned vs distributed to stakers |

**Security applied (defiSKILL):**
- ReentrancyGuard on mint path
- _update() hook: pause + transfer cap enforcement
- Mint/burn paths bypass cap checks
- Custom errors throughout
- SafeERC20 used by consuming contracts

**Post-deploy checklist:**
- [ ] Deploy `TIMBSToken(treasury, allocations, entryCostTIMBS)`
- [ ] Deploy `TimbStaking` → `setStakingPool(address)`
- [ ] Deploy `TimbFarm` → `setFarmPool(address)`
- [ ] `setTransferWhitelist(router, true)` after router deploy
- [ ] Verify on Sourcify

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
- `positionCounter` uint256, increments +1 per eligible swap
- 36-char alphabet: A–Z + 0–9, fixed sequence
- 6-char window = `alphabet[(counter+i) % 36]` for i 0–5
- `shuffleEnabled` owner toggle for future reshuffle testing
- `ScrollShifted(uint256 newPosition)` emitted per nudge
- Router calls `TimbPrize.nudgeScroll()` after confirmed eligible swap
- Frontend: `getRoundState()` view + event listener + 2–3s poll fallback

### Settlement Freeze
- `freezePosition()` entropy: `keccak256(blockhash(block.number-1) + positionCounter + roundNumber)`
- Random 3-second offset within 0:15 window
- Winning string frozen and recorded on-chain
- VRF swap-in point noted for mainnet upgrade

### Entry Rules
- 1 string per wallet per round (replaceable)
- 6 chars, A–Z + 0–9 only, all caps, no repeating chars
- Entries set in round N → play in round N+1 (no mid-round entries)
- UI shows identical entry count after string set
- Entry always refundable (principal escrow, ringfenced)

### Entry Cost
| Cost | Token | Refundable |
|------|-------|------------|
| Initial entry | ETH or TIMBS | Yes — always |
| Additional rounds | TIMBS required | No — protocol sink |
| Entry replacement | New fees pulled, old deposit transfers | Additional round TIMBS kept as sink |

### Entry Replacement (all-in-one tx)
1. Pre-flight: verify contract can pull new fees
2. Old initial deposit → transfers to new string
3. Old additional-round TIMBS → kept by protocol (out of circulation)
4. New string set on-chain
5. New fees pulled for new round count

### Winners & Payouts
- Exact 6-char match only, no partials
- Pot `x` → `floor(x/n) × n` distributed equally, `r` rolls to next round
- Dual-layer verification: existed at round start + valid at settlement
- Claim: `claimWinnings(uint256 roundNumber)` — auto-lookup via msg.sender
- Claim window: open while player active, expires 2 rounds after lastEligibleRound
- Unclaimed + ineligible → protocol dividend back to prize pot or treasury

### Prize Pool Accounting (balance sheet)
- `currentAccumulatedRewards` — live pot (swap fees + settlement cut + r + seeding)
- `gameUnclaimed_winningsPool` — documented winners pending claim
- Entry escrow — completely separate, never touches either bucket

### Swap Influence
- Opt-in per swap on Swap page
- Eligible tokens: TIMBS, ETH, DAPP + owner-extendable list
- Each qualifying swap: nudges `positionCounter` +1
- Blocked during 0:15 settlement window
- Influence counter displayed on Analytics page (not Compete page)

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
| Key params | entryCostTIMBS, buybackBurnRatio, governanceEmissionsCap |
| Separation | Fully separate from staking |

---

## DebugHub Integration

**appName:** `TimbSwap` (single, section-tagged)

**Checkpoint naming:**
```
Swap:Approve Requested/Submitted/Confirmed
Swap:Swap Requested/Submitted/Confirmed
Farm:Stake Requested/Submitted/Confirmed
Farm:Unstake Requested/Submitted/Confirmed
Farm:Claim Requested/Submitted/Confirmed
Lock:Lock Requested/Submitted/Confirmed
Lock:Withdraw Requested/Submitted/Confirmed
Prize:Entry Requested/Submitted/Confirmed
Prize:Claim Requested/Submitted/Confirmed
Prize:Settlement Requested/Submitted/Confirmed
Gov:Vote Requested/Submitted/Confirmed
```

**Standing checklist (every write function):**
1. `maxFeePerGas` / `maxPriorityFeePerGas` from `getFeeData()` × 1.30
2. Explicit nonce via `getTransactionCount(address, "pending")`
3. `X Requested` → `X Submitted` → `X Confirmed` checkpoints
4. `logError(functionName, error)` + `X Failed` in catch block

---

## Ecosystem Dev Notes (Carried Forward)

- **ethers CDN:** `cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js`, no `type` attribute
- **Gas mobile:** `getFeeData()` × 1.30 both fee params, 50% gasLimit buffer
- **Nonce:** explicit `getTransactionCount(address, "pending")` on every write
- **DebugHub stub:** always define fallback no-op after SDK script tag
- **Requested checkpoint:** log immediately before every `await contract.method()`
- **Script path:** SDK src must be exact path
- **Stale wallet:** "no popup, no error" on specific device → check WalletConnect session first
