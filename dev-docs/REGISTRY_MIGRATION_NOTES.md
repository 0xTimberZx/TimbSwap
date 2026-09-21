# Registry migration notes

Hard-won operational notes on swapping GameRegistry out mid-life. Both problems
below were found the expensive way on Arb Sepolia and cost a manual id-by-id
cleanup in Remix. Read this before pointing TimbPrize or TimbYieldVault at a new
registry.

---

## 1. Ticket ids are not namespaced across registry versions

`GameRegistry.sol`:

```solidity
uint256 public nextTicketId = 1;
```

That is an **initialiser, not a constructor argument** — every fresh deployment
restarts the id space at 1. `TimbYieldVault` keys weight by the raw id:

```solidity
mapping(uint256 => uint256) public weightOf;
```

So v(N) ticket #3 and v(N+1) ticket #3 are the same storage slot. Two distinct
failures follow, and the second is the nastier one.

### 1a. Old weight is stranded

`remove()` is `onlyGameRegistry`. Once the pointer moves to the new registry,
the old one can never clear the weight it registered — and its round clock is
frozen anyway, so nothing will ever try. That weight is permanent until an
owner clears it by hand.

This is not cosmetic. `_accrue()` is:

```solidity
uint256 pending = (totalWeight * ratePerSecond1e18 / 1e18) * elapsed;
```

paid out of the vault's own ETH balance. Phantom weight drains the subsidy
reserve strictly faster than real participation justifies. At one point the
vault carried 11 weight units against 5 live tickets — burning reserve at
~2.2× the honest rate.

### 1b. New tickets landing on occupied slots are silently dropped

`register()` opens with:

```solidity
if (weightOf[ticketId] != 0) return; // already registered
```

A new ticket whose id collides with a stranded old one is a **no-op**. It does
not overwrite, it does not revert, no event fires, `totalWeight` does not move.
The ticket pays into the game and earns zero vault yield, and nothing anywhere
reports a problem.

The asymmetry is the root cause: `register()` guards against double-registration,
`remove()` does not check *whose* weight it is deleting. Fine while one registry
owns the whole id space; broken the moment a second one restarts at 1.

**On the next cutover:** seed the new registry's `nextTicketId` from the
outgoing registry's value so the id spaces never overlap, or drain the vault's
weight to zero before repointing. A namespaced key
(`keccak256(registry, ticketId)`) closes it permanently but needs a vault
redeploy.

---

## 2. Everything fails silently, because the registry swallows it

`GameRegistry.sol`:

```solidity
try ITimbYieldVaultRegistry(yieldVault).register(ticketId, token, amount) {} catch {}
try ITimbYieldVaultRegistry(yieldVault).remove(ticketId) {} catch {}
```

The `try/catch` is correct — it stops a vault problem from bricking settlement.
But it means **no vault misconfiguration is ever visible from the game side.**
Settlement reports success whether or not weight was actually recorded.

This matters most during a manual drain. Clearing stranded weight requires
temporarily pointing `gameRegistry` at an owner EOA (see below). While it is
parked there, `onlyGameRegistry` reverts for the real registry, the catch eats
it, and every ticket minted in that window registers **nothing** while every
expiring ticket keeps its weight forever — manufacturing exactly the phantoms
the drain was meant to remove.

**Never leave the pointer on an EOA across a round rollover.** Do the drain
between rounds and restore it immediately.

---

## 3. Draining stranded weight

Use `scripts/vault-weight.js` rather than clicking `weightOf` in Remix.

```bash
node scripts/vault-weight.js                      # audit only, sends nothing
node scripts/vault-weight.js --drain              # remove stranded ids
node scripts/vault-weight.js --drain --ids 3,7,9  # explicit list
```

It scans the id space bounded by the live registry's `nextTicketId` (raise
`SCAN_MAX` if a retired registry issued more), sums the weight it finds, and
warns when the sum does not reconcile with `totalWeight()` — which is the signal
that ids exist above the ceiling.

It cross-references each id against the live registry and errs toward **LEAVE**:
where a stranded old id collides with a live new one, it skips. That leaves some
phantom weight (a slow subsidy leak) rather than deleting a real ticket's weight
(robbing a player of yield). Take the leak.

Sequence:

1. `vault.setGameRegistry(<owner EOA>)`
2. `node scripts/vault-weight.js --drain`
3. `vault.setGameRegistry(<real registry>)` — **same maintenance window**

`remove()` is idempotent, so re-running after an RPC hiccup is always safe. A
`BAD_DATA` / `invalid hash (value=null)` error out of ethers is the node
misbehaving, not a revert — check `weightOf(id)` to see whether it landed.

---

## 4. Reconciling

`totalWeight` should equal `VAULT_WEIGHT_UNIT` (1e14) × active entries. The
analytics page surfaces both — "Active Entries · N tickets · X ETH-eq" — so a
mismatch between the ticket count and the ETH-eq figure is the cheapest
early warning that weight has drifted. Check it after every cutover.
