# TimbSwap — Tokenomics, Lottery Capital Flow & Game Theory

**Protocol:** TimbSwap  
**Token:** TIMBS  
**Last updated:** June 2026

---

## 1. TIMBS Tokenomics

### 1.1 Supply Model

| Parameter | Value |
|-----------|-------|
| Token name | TimbSwap Token |
| Symbol | TIMBS |
| Decimals | 18 |
| Hard cap | 1,000,000,000 TIMBS (1B) |
| Initial mint | 100% to treasury at deploy |
| Emissions | Inflationary — minted on-demand for staking/farm rewards |
| Deflationary pressure | Buyback/burn (future), out-of-circulation prize sinks |

The initial supply is fully controlled by the treasury. No team allocation,
no vesting cliffs, no pre-sale tranches at launch. Owner distributes from
treasury based on protocol needs.

### 1.2 Supply Flow Diagram

```
Deploy
  └── initialSupply → Treasury wallet (100%)
         │
         ├── Seed staking pool rewards
         ├── Seed farm pool rewards
         ├── Seed prize game operations
         └── Reserve for governance / airdrop

Ongoing emissions (minted to pools by owner-set APR):
  TimbStaking.sol  ← mintEmissions() ← TIMBSToken
  TimbFarm.sol     ← mintEmissions() ← TIMBSToken
  (Hard cap enforced on every mint — 1B ceiling total)

Out-of-circulation sinks (TIMBS removed from active supply):
  └── Entry replacement: old additional-round fees kept by protocol
  └── Additional round fees: non-refundable, retained by protocol
  └── Future: buyback-and-burn from protocol revenue (owner-toggle)
```

### 1.3 Emission Mechanics

- **Fixed APR model** — owner sets APR per pool, not per-block rate
- **Two emissions pools:**
  - TIMBS single-asset staking pool
  - TIMBS/ETH LP farm pool
- **Reward source:** treasury + competition fees + swap fees (0.05% protocol share)
- **Free staking:** add/reduce/withdraw anytime, no lock, no penalty
- **No unique stake IDs** — single accumulated balance per address
- **APR changeable by owner** — governance proposal path available in later phases

### 1.4 Governance Parameter — entryCostTIMBS

Single governance-controlled variable that cascades to all prize entry cost derivatives:

```
entryCostTIMBS (e.g. 100 TIMBS)
  ├── ETH entry cost = entryCostTIMBS × TIMBS/ETH price (rounded up)
  ├── Additional round cost = entryCostTIMBS × N extra rounds (non-refundable TIMBS)
  └── Protocol entry sink = previous additional-round fees kept out of circulation
```

One governance vote changes all three. No patching multiple parameters.

### 1.5 Value Accrual to TIMBS

| Source | Mechanism |
|--------|-----------|
| Swap fees | 0.05% protocol fee → split to treasury + TIMBS staking pool |
| Prize entry sinks | Additional-round TIMBS fees stay out of circulation |
| Staking demand | Holders stake TIMBS to earn emissions — reduces liquid supply |
| Governance utility | TIMBS balance = voting weight in governance contract |
| Prize entry demand | TIMBS required for additional rounds — drives holding |
| LP incentive | TIMBS/ETH LP earns both TIMBS emissions + 0.25% swap fees |

---

## 2. Prize Game Capital Flow

### 2.1 The Three Buckets

All protocol money is separated into three ringfenced buckets. They never mingle.

```
┌─────────────────────────────────────────────────────────────┐
│  BUCKET 1: Entry Escrow (GameRegistry.sol)                  │
│  ─────────────────────────────────────────────────────────  │
│  What: Player entry deposits (ETH or TIMBS)                 │
│  Rule: NEVER touches protocol revenue or prize pool         │
│  Flow: Deposited on entry → held during round →             │
│        returned to player (refund) OR transferred to new    │
│        string (replacement) OR released on entry expiry     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  BUCKET 2: Prize Pool (PrizeEscrow.sol)                     │
│  ─────────────────────────────────────────────────────────  │
│  What: Accumulated ETH available for winners                │
│  Inflows: Protocol swap fees, seeding by owner,             │
│           snowball remainder (r), expired unclaimed         │
│           winnings dividend, optional TIMBS conversions     │
│  Outflows: Winner payouts, snowball (r) to next round       │
│  Sub-accounts:                                              │
│    currentAccumulatedRewards — live building pot            │
│    gameUnclaimed_winningsPool — documented, pending claim   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  BUCKET 3: Treasury (TimbTreasury.sol)                      │
│  ─────────────────────────────────────────────────────────  │
│  What: Protocol revenue wallet                              │
│  Inflows: Owner-set % of protocol fee split,                │
│           expired unclaimed winnings (if no eligible        │
│           claimants and owner-toggle to treasury)           │
│  Outflows: Operational costs, staking rewards top-up,       │
│            future buyback-and-burn                          │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Prize Pool Inflow Sources

| Source | Type | Notes |
|--------|------|-------|
| Protocol swap fees | Primary | 0.05% of all swaps routed to prize pool (owner-set %) |
| Owner seeding | Manual | Owner deposits ETH directly into PrizeEscrow |
| Snowball (r) | Automatic | Remainder after equal winner split rolls to next round |
| Expired unclaimed winnings | Dividend | Winners who miss claim window → back into pool or treasury |
| Optional TIMBS deposits | Converted | Protocol converts TIMBS to ETH equivalent over next rounds |

### 2.3 Round Capital Flow

```
Round Start
  currentAccumulatedRewards = fees_collected + r_from_last_round

  ┌── Segment 1–6 (59:45 each) ──────────────────────────────┐
  │   Swap fees accumulate into prize pool                    │
  │   Swap influence nudges positionCounter                   │
  │   Entries set (play next round, not current)              │
  └───────────────────────────────────────────────────────────┘

  0:15 Settlement Window
  │
  ├── freezePosition() called by settler
  │     entropy = keccak256(blockhash(block.number-1)
  │               + positionCounter + roundNumber)
  │     winningString = 6-char window at frozen position
  │
  ├── Dual-layer verification of entries:
  │     Layer 1: entry existed at round start
  │     Layer 2: entry still valid at settlement (not withdrawn,
  │               multi-round extension still active)
  │
  ├── winners[] = entries matching winningString exactly
  │
  ├── potAmount x = currentAccumulatedRewards
  │     x_distributable = floor(x / n) × n  (divisible by winners)
  │     perWinner = x_distributable / n
  │     r = x - x_distributable
  │
  ├── gameUnclaimed_winningsPool += x_distributable
  │     (each winner's share documented, awaiting claim)
  │
  ├── r → currentAccumulatedRewards of next round (snowball)
  │
  └── RoundSettled event emitted:
        roundNumber, winningString, potAmount, numWinners,
        remainderR, totalEntries, timestamp

Round Close → Next Round Auto-Queues
```

### 2.4 Winner Claim Flow

```
Winner calls claimWinnings(uint256 roundNumber)
  │
  ├── Contract looks up entry via msg.sender + roundNumber
  │     (no string needed — auto-lookup)
  │
  ├── Dual-layer check:
  │     ✓ Wallet had valid entry at round start
  │     ✓ Entry still valid at settlement (not mid-replacement)
  │
  ├── Eligibility window check:
  │     Claim open: while player has active entry in any round
  │     Claim expires: 2 rounds after lastEligibleRound ends
  │
  ├── PrizeEscrow.pay(winner, perWinner) executed
  │
  └── Entry status updated in GameRegistry:
        if entry fully expired → Inactive
        if still multi-round active → remains Active

Unclaimed after eligibility expires:
  └── r (or treasury dividend) — absorbed at next round start
      if no eligible claimants remain for that round's pool
```

### 2.5 Entry Capital Flow

```
Player sets entry (round N, plays round N+1):

  Initial entry (first time or replacement):
    Option A: Pay entryCostTIMBS in TIMBS
      └── TIMBS held in GameRegistry escrow (ringfenced)
    Option B: Pay ETH equivalent (lowers barrier)
      └── ETH held in GameRegistry escrow (ringfenced)
      └── Additional rounds still require TIMBS

  Additional rounds (optional, non-refundable):
    Cost = entryCostTIMBS × extraRounds (in TIMBS)
    └── TIMBS transferred to protocol (out of circulation)
    └── NOT held in escrow — immediate protocol sink

  Entry replacement (update string):
    All-in-one transaction:
    1. Pre-flight: verify contract can pull new fees
    2. Old initial deposit → transfers to represent new string
    3. Old additional-round TIMBS → kept by protocol (sink)
    4. New string set on-chain
    5. New additional-round fees pulled if round count changed

  Entry expiry:
    lastEligibleRound passed + claim window closed:
    └── Entry status → Inactive
    └── Initial deposit → claimable as refund by player
        (principal always returnable, no forfeiture)
```

---

## 3. Game Theory

### 3.1 The Scroll Mechanic

The winning string is not pre-determined. It emerges from the interaction of
three forces: the base scroll, swap influence, and a random freeze point.

```
positionCounter (on-chain uint256)
  │
  ├── Increments +1 on every eligible swap (TIMBS, ETH, DAPP, + owner list)
  │     → ScrollShifted(uint256 newPosition) emitted
  │
  ├── 6-char display window = alphabet[(counter+i) % 36] for i 0–5
  │     alphabet = A–Z + 0–9 (36 chars), fixed sequence
  │     (shuffleEnabled toggle available for future testing)
  │
  └── At settlement freeze:
        entropy = keccak256(blockhash(block.number-1) + counter + roundNumber)
        freeze offset = entropy % 3 seconds within 0:15 window
        winningString = window at frozen counter value
```

**Key property:** No single actor can deterministically set the winning string.
Swap influence nudges the counter, but the freeze point within the 0:15 window
is unpredictable even to the settler. The settler cannot manipulate the freeze —
they can only call `freezePosition()`, not choose the outcome.

### 3.2 Player Incentive Structure

| Player Type | Strategy | Rational Behavior |
|-------------|----------|-------------------|
| Entry-only | Set string, wait | Pick uncommon string to avoid split pot |
| Swap influencer | Trade eligible tokens to nudge counter | Nudge when holding a string near the current window |
| Multi-rounder | Pay TIMBS for extended participation | Reduces re-entry friction, commits capital signal |
| String collision player | Set same string as others | Rational if pot is large enough to split worth it |
| Passive LP | Provide liquidity | Earns 0.25% swap fees + contributes to pot via protocol fees |

### 3.3 String Collision Dynamics

When multiple players hold the same winning string, the pot splits equally.
The UI shows identical entry count after string is set — this creates a
**real-time information asymmetry game:**

```
String collisions → smaller per-winner share
  → rational players seek unique strings
  → but unique strings have lower "coverage" of the scroll window
  → optimal play: balance uniqueness vs window coverage

Identical count shown live (after string is set, before round starts)
  → late entrants can see collision risk and change string
  → but changing costs a new transaction (friction)
  → creates a last-mover advantage window before round locks
```

### 3.4 Swap Influence Game Theory

Swap influence is opt-in per swap. This creates a secondary meta-game:

```
Rational influencer calculates:
  Expected value of nudge = (pot / winners) × P(win after nudge)
                          - (extra gas cost of nudgeScroll call)

When to influence:
  ✓ Your string is close to the current window (high P(win delta))
  ✓ Pot is large enough to justify gas
  ✓ Segment is early (more time for further nudges)

When NOT to influence:
  ✗ Your string is far from window (nudge helps competitors more)
  ✗ Settlement window approaching (wasted gas if counter freezes)
  ✗ Gas spike — protocol blocks influence during 0:15 settlement
```

This creates a natural **trading volume flywheel:**
- Higher pot → more incentive to influence → more swaps → more protocol fees → higher pot

### 3.5 The Snowball (r) Effect

Remainder `r` (from pot not perfectly divisible by winner count) rolls into
the next round automatically. This creates compounding dynamics:

```
Round with no winners:
  Entire pot → r → next round pot
  → larger pot → more player incentive → more entries + swaps

Round with 1 winner:
  r = pot mod 1 = 0 (always 0, winner takes all)

Round with 3 winners:
  pot = 0.84 ETH → floor(0.84/3)×3 = 0.84 → r = 0.00 ETH
  pot = 0.85 ETH → floor(0.85/3)×3 = 0.84 → r = 0.01 ETH → next round

Implication: larger winner counts generate more consistent snowball.
Owner-configurable winner count is a protocol tuning lever.
```

### 3.6 Capital Risk Profile for Players

```
Entry cost (ETH or TIMBS)    → ALWAYS refundable (principal escrow)
Additional round fees (TIMBS) → NON-REFUNDABLE (protocol sink)
Prize winnings               → Claimable 2 rounds post-lastEligibleRound

Net risk for basic player:
  = additional round fees (if any) + gas costs
  Entry principal is never at risk.

Net risk for swap influencer:
  = extra gas per nudgeScroll call
  No token risk — influence is opt-in on an existing swap.
```

**This is the core UX differentiator:** entry is zero-capital-risk. Players
risk only gas and optional multi-round TIMBS fees. The pot is funded entirely
by protocol revenue — players are competing for prize money they didn't contribute.

### 3.7 Protocol Health Indicators

The prize pool acts as a real-time signal of protocol health:

| Metric | Healthy Signal | Warning Signal |
|--------|---------------|----------------|
| `currentAccumulatedRewards` | Growing each round | Flat or shrinking |
| `gameUnclaimed_winningsPool` | Low (claims being made) | High (winners not claiming) |
| Snowball (r) trend | Small (winners found) | Growing (no winners for multiple rounds) |
| Entry count per round | Growing | Declining |
| Swap influence events per segment | Active | Zero |
| positionCounter delta per round | High (active trading) | Low |

### 3.8 Protocol Revenue Flywheel

```
More swaps
  → more protocol fees (0.05%)
  → larger prize pot
  → more players enter
  → more swap influence opt-ins
  → even more swaps
  → larger TIMBS staking rewards
  → more TIMBS staked (reduced liquid supply)
  → upward pressure on TIMBS price
  → ETH entry cost rises (derived from TIMBS price)
  → larger effective prize pot value
  → more players enter
  [cycle repeats]
```

### 3.9 Unclaimed Winnings as Protocol Stabilizer

When winners fail to claim within 2 rounds of their `lastEligibleRound`:

```
Unclaimed amount checked at next round start:
  IF eligible claimants still exist → gameUnclaimed_winningsPool remains
  IF no eligible claimants → amount moves to:
    Option A (default): r → next round's currentAccumulatedRewards
    Option B (owner-toggle): treasury dividend → protocol revenue

This means:
  → Abandoned winnings refuel the pot (keeps the game self-sustaining)
  → No ETH ever sits idle in the protocol permanently
  → Creates slight urgency for winners to claim (cultural, not enforced)
```

### 3.10 Segment Structure Game Theory

Six 59:45 segments per round create a natural **attention arc:**

```
Segment 1–2: Low activity (round just started, pot small)
Segment 3–4: Mid-game peak (pot building, active influencers)
Segment 5–6: End-game tension (pot at max, final nudges)
0:15 settle: Complete blackout — no user input accepted

Rational entry timing:
  → Entries set during current round play NEXT round
  → No advantage to setting entry early vs late in current round
  → Removes mid-round entry manipulation
  → All round N+1 entrants are on equal footing regardless of when in round N they entered
```

---

## 4. Summary — What Makes This Different

| Feature | TimbSwap | Generic Lottery | Generic DEX |
|---------|----------|-----------------|-------------|
| Prize funded by | Protocol revenue | Player buy-ins | N/A |
| Entry capital risk | Zero (refundable) | Total loss | N/A |
| Prize influenceable | Yes (swap influence) | No | N/A |
| Winning mechanic | Scroll + random freeze | Pure random | N/A |
| Trading incentive | Prize influence flywheel | None | Standard fees |
| Token utility | Staking + entry + governance + sink | N/A | Governance only |
| Cross-feature synergy | Swap → Prize → Staking | None | None |

The core thesis: **a DEX where trading has a game-theory layer on top of it.**
Every swap on an eligible token is simultaneously a trade, a potential prize
influence action, and a protocol fee contribution that grows the pot.
Players aren't choosing between trading and gaming — the same transaction does both.
