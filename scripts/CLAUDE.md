# TimbSwap — Claude Code Project Rules

## Protocol Context

**Protocol:** TimbSwap — AMM DEX with prize game, staking, LP farming, lock vault, governance  
**Token:** TIMBS (ERC-20, fixed supply 100M, governance-unlockable emissions cap)  
**Network:** Arbitrum Sepolia (Chain ID: 421614) — testnet  
**Pragma:** `pragma solidity 0.8.20` — exact, never `^`  
**Verification:** Sourcify preferred over Etherscan  
**Repo:** 0xtimberzx/timbswap  

---

## Skill Auto-Invoke Rules

Before writing or modifying any Solidity contract (.sol files), you MUST invoke:
- /solidity-coding
- /solidity-security
- /defi-security (always — this is a DeFi protocol)

Before writing or modifying test files (*.t.sol), you MUST invoke:
- /solidity-testing

Before deploying contracts or writing deployment scripts (*.s.sol), you MUST invoke:
- /solidity-deploy
- /defi-security
- /solidity-checklist

Before any on-chain operation (cast send, forge script --broadcast), you MUST invoke:
- /solidity-checklist

Before debugging failed on-chain transactions, you MUST invoke:
- /solidity-debug

Before conducting security audits or code reviews, you MUST:
- Run slither MCP analysis first (if available)
- Then invoke /solidity-audit
- Cross-reference both results

Before creating git commits or PRs, you MUST invoke:
- /git-workflow

## Context Recovery

After every `/clear`, you MUST re-invoke:
- /claude-code-usage
- Re-read SPECS.md and TOKENOMICS_AND_GAME_THEORY.md before making any changes

---

## Contract Registry

| Contract | File | Purpose |
|----------|------|---------|
| TIMBSToken | src/TIMBSToken.sol | ERC-20, fixed supply, governance param |
| TimbSwapFactory | src/TimbSwapFactory.sol | Pair creation, fee config, partner pool flag |
| TimbSwapPair | src/TimbSwapPair.sol | AMM pair, LP tokens, TWAP |
| TimbSwapRouter | src/TimbSwapRouter.sol | Swap routing, fee split, prize nudge hook |
| TimbStaking | src/TimbStaking.sol | TIMBS single-asset staking |
| TimbFarm | src/TimbFarm.sol | TIMBS/ETH LP farming |
| TimbLockVault | src/TimbLockVault.sol | Public ERC-20 lock vault, registry |
| EligibleTokenRegistry | src/EligibleTokenRegistry.sol | Swap influence eligible token list |
| GameRegistry | src/GameRegistry.sol | Prize entry storage, escrow, lifecycle |
| TimbPrize | src/TimbPrize.sol | Round logic, scroll, settlement, payouts |
| PrizeEscrow | src/PrizeEscrow.sol | Prize ETH custody |
| TimbTreasury | src/TimbTreasury.sol | Fee routing, buyback, protocol split |
| TimbGovernance | src/TimbGovernance.sol | Proposals, TIMBS voting, hybrid execution |

---

## Critical Architecture Rules

### Never violate these — they are core protocol invariants:

1. **Entry escrow is ringfenced** — GameRegistry escrow (ETH + TIMBS) must NEVER
   be sent to TimbTreasury, PrizeEscrow, or any protocol wallet. Player principal
   is always refundable. Never mix buckets.

2. **Prize pool never holds entry deposits** — PrizeEscrow holds only protocol
   revenue-funded ETH. GameRegistry holds only player principal.

3. **nudgeScroll() called AFTER confirmed token transfer** — never before.
   Eligible check verified against EligibleTokenRegistry, not caller-supplied data.
   nudgeScroll() failure must be silently caught — prize game never blocks a swap.

4. **Dual-layer verification at settlement** — both verifyEntryExisted() AND
   verifyEntryValid() must pass before documenting a winner. Never skip either layer.

5. **Settlement timing enforced on-chain** — settleSegment() reverts if called
   before INTERACTION_WINDOW (59:45) has elapsed. Never relax this check.

6. **DEX pair TOCTOU** — TimbSwapPair.swap() takes explicit amount0Out/amount1Out
   from Router. Direction must NEVER be inferred from balance/reserve delta inside
   the pair. This is a known attack vector.

7. **LP token lock in TimbFarm** — lpTokenLocked flips true on first stake.
   setLpToken() must never be callable after first stake. Do not bypass this.

8. **positionCounter never resets** — it is a raw incrementing uint256.
   window = alphabet[(counter+i) % 36] for i 0..5. Never add a reset function.

9. **Buyback split** — burned TIMBS must use TIMBSToken.burn(), not transfer
   to dead address. Only burn() reduces totalSupply correctly.

10. **One governance param cascades** — entryCostTIMBS in TIMBSToken is the
    single source of truth for all prize entry cost derivatives. Never hardcode
    entry costs elsewhere.

---

## Standing Checklist — Every Write Function

Before any contract write function is considered done:

1. `maxFeePerGas` / `maxPriorityFeePerGas` from `getFeeData()` × 1.30
2. Explicit nonce via `getTransactionCount(address, "pending")`
3. `X Requested` → `X Submitted` → `X Confirmed` DebugHub checkpoints
4. `logError(functionName, error)` + `X Failed` in catch block
5. `ReentrancyGuard` on all state-changing external functions
6. `SafeERC20` for all token transfers
7. Custom errors (no revert strings)

---

## DebugHub Integration

**appName:** `TimbSwap` (single, section-tagged per module)

```javascript
// SDK tag in every page head
window.DEBUGHUB_CONFIG = { appName: "TimbSwap" };
```

**Checkpoint prefix format:** `Module:Action Stage`

```
Swap:Approve Requested / Submitted / Confirmed
Swap:Swap Requested / Submitted / Confirmed
Farm:Stake Requested / Submitted / Confirmed
Farm:Unstake Requested / Submitted / Confirmed
Farm:Claim Requested / Submitted / Confirmed
Lock:Lock Requested / Submitted / Confirmed
Lock:Withdraw Requested / Submitted / Confirmed
Prize:Entry Requested / Submitted / Confirmed
Prize:Replace Requested / Submitted / Confirmed
Prize:Claim Requested / Submitted / Confirmed
Prize:Settlement Requested / Submitted / Confirmed
Gov:Deposit Requested / Submitted / Confirmed
Gov:Vote Requested / Submitted / Confirmed
Gov:Withdraw Requested / Submitted / Confirmed
```

**Security checks:**
```
Chain Check — on wallet connect, verify chainId === 421614
Contract Check — verify contract addresses resolve on-chain
```

**DebugHub tab:** TimbSwap gets its own tab in the existing DebugHub dashboard.
Add `{ appName: "TimbSwap", storageKey: "TimbSwap_sessions" }` to the APPS array
in `0xtimberzx.github.io/MyDapp/debughub/app.js`.

**Fallback stub:** Always define the no-op stub after the SDK script tag.
DebugHub must NEVER break TimbSwap if the SDK fails to load.

```javascript
if (!window.DebugHub) {
  window.DebugHub = {
    startSession:    () => {},
    endSession:      () => {},
    logCheckpoint:   () => {},
    logError:        () => {},
    logPerf:         () => {},
    logSecurity:     () => {}
  };
}
```

---

## Security Restrictions

- **NEVER read, open, or access `.env` files** — no AI agent is allowed to view
  `.env` under any circumstances.
- Only `.env.example` may be read to understand environment variable structure.
- Never broadcast a transaction without running through /solidity-checklist first.
- Never modify TimbSwapPair._update() to infer operation type from balance delta.
- Never add a reset function to positionCounter.
- Never allow PrizeEscrow.pay() to be called by any address other than TimbPrize.
- Never allow GameRegistry escrow to be withdrawn by protocol — only by player.

---

## Deployment Order

Contracts must be deployed in this exact order — later contracts depend on earlier:

```
1.  TIMBSToken(treasury, initialSupply, entryCostTIMBS)
2.  PrizeEscrow()
3.  TimbSwapFactory(feeTo=treasury)
4.  TimbSwapPair(token0, token1)           ← deployed by factory
5.  TimbSwapRouter(factory, treasury, address(0), address(0))
6.  EligibleTokenRegistry([TIMBS, WETH, DAPP])
7.  GameRegistry(timbsToken, protocolSink, address(0))
8.  TimbPrize(prizeEscrow, gameRegistry, router)
9.  TimbStaking(timbsToken, rewardRate)
10. TimbFarm(timbsToken, rewardRate)
11. TimbLockVault(timbsToken)
12. TimbTreasury(timbsToken, staking, prizeEscrow, pair)
13. TimbGovernance(timbsToken, threshold, quorum, period, delay)
```

**Post-deploy wiring (run Deploy.s.sol):**
```
factory.setRouter(router)
factory.setTimbsToken(timbs)
factory.createPair(TIMBS, WETH) → factory.setEmissionsWhitelist(pair, true)
router.setEligibleRegistry(registry)
router.setTimbPrize(timbPrize)
gameRegistry.setTimbPrize(timbPrize)
gameRegistry.setEntryCosts(timbsCost, ethCost)
prizeEscrow.setTimbPrize(timbPrize)
timbPrize setters: setEligibleRegistry, setGameRegistry, setPrizeEscrow
timbs.setStakingPool(staking)
timbs.setFarmPool(farm)
farm.setLpToken(pair)
staking.setTreasury(treasury)
farm.setTreasury(treasury)
treasury.setTimbStaking(staking)
registry.registerConsumer(router)
registry.registerConsumer(timbPrize)
```

---

## Workflow Orchestration

### 1. Plan Mode Default
- Enter Plan Mode for any non-trivial task (3+ steps or architectural decisions)
- Read SPECS.md before proposing any architectural change
- Break down complex tasks using TodoWrite before starting

### 2. Verification Before Done
- `forge build` must pass before marking any contract task complete
- `forge test` must pass before marking any test task complete
- Never mark complete without verification

### 3. Autonomous Bug Fixing
- Fix compilation errors and test failures directly without waiting for guidance
- Re-verify after every fix

### 4. Self-Improvement Loop
- Record lessons learned after every user correction in this file

---

## Known Patterns From Existing Ecosystem

Carry these forward from MessageBoard / BlockpotDAO / 0xFaucet:

- **ethers CDN:** `cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js`, no `type` attribute
- **Gas:** `getFeeData()` × 1.30 both fee params + 50% gasLimit buffer
- **Nonce:** explicit `getTransactionCount(address, "pending")` on every write
- **Stale wallet:** "no popup, no error" on specific device → check WalletConnect session first
- **Script path:** DebugHub SDK src must be exact — wrong path silently swallows all calls

---

## Core Principles

### Simplicity First
- Minimum code change to achieve the goal
- No over-engineering, no unrequested features

### No Landmines
- Find root causes, never temporary fixes
- No hidden hazards in any state-changing function

### Minimal Impact
- Only change what must be changed
- Do not refactor surrounding code unless explicitly asked

## Language
Always respond in the same language the user is using.
