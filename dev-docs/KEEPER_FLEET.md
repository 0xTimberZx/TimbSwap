# Keeper fleet — checks and balances without coupling

The automation runs as GitHub Actions cron jobs: no server, no daemon, each
job a fresh checkout that reads `config.js`, does one thing, and exits. This
document is the operating model for that fleet: what each job is, how they
watch each other, and the rules that let them cross-check without any of them
depending on another to succeed.

## 1. The fleet

| Job | Workflow | Cadence | Kind | Holds a key | Own state |
|---|---|---|---|---|---|
| Settler | `settler.yml` | 10 min, lingers across segments; noon health | writer | settler key | none (chain is the state) |
| Epoch keeper | `epoch.yml` | lingers 2 h, self-chains; 2 h cron backstop | writer | epoch key | `epoch-state.json` |
| Faucet keeper | `faucet.yml` | 10 min | writer | faucet dispatcher key | Supabase `faucet_claims` |
| Fund rewards, boost window | `admin-*.yml` | manual | writer | epoch key | none |
| Match notifier | `match-notifier.yml` | lingers 55 min, self-chains; 15 min cron backstop | notifier | none | Supabase |
| Reclaim reminder | `reclaim-reminder.yml` | lingers 55 min on the round clock, self-chains; hourly cron backstop | notifier | none | Supabase |
| Points scorer | `points-scorer.yml` | lingers 1 h, self-chains; hourly cron backstop | notifier | none | Supabase cursors |
| Faucet invariants | `faucet-invariants.yml` | every 6 h | witness | none | `faucet-invariants-state.json` |
| Fleet heartbeat | `fleet-heartbeat.yml` | lingers 30 min, self-chains; `:09`/`:39` cron backstop | witness | none | `fleet-heartbeat-state.json` |
| Settler liveness | `settler-liveness.yml` | lingers 15 min, self-chains; `:04`/`:34` cron backstop | witness | none | `settler-liveness-state.json` |
| Epoch reconciliation | `epoch-recon.yml` | lingers 2 h, self-chains; `:47` every 2 h cron backstop | witness | none | `epoch-recon-state.json` |
| Faucet reconciliation | `faucet-recon.yml` | lingers 1 h, self-chains; `:37` hourly cron backstop | witness | none | `faucet-recon-state.json` |
| Points reconciliation | `points-recon.yml` | lingers 1 h, self-chains; `:52` hourly cron backstop | witness | none | `points-recon-state.json` |
| Dead-man switch | `dead-man.yml` | lingers 30 min, self-chains; `:19`/`:49` cron backstop | witness | none | `dead-man-state.json` |

Three kinds:

- **Writers** hold a key and change chain state. They are the only jobs that
  can do damage, so they are the only jobs that get isolation guarantees.
- **Notifiers** read the chain and write to Supabase or Telegram. A wrong
  notifier annoys; it cannot lose funds.
- **Witnesses** read the chain, the database, or the Actions API, recompute
  what should be true, and alert on disagreement. They never act.

## 2. The rules

1. **Writers act. Witnesses alert.** A witness never calls a contract, never
   dispatches another job, never edits another job's state. The one trigger a
   job may fire is its own next run, one cadence later, after a run that got
   as far as doing its work; that is the self-chain, and it exists because
   this repo's cron delivers roughly one tick in four to six (measured
   2026-09-18 across every cron-only job). Cron is the backstop, never the
   clock.
2. **Every job owns exactly one state file, and nobody else reads it.** The
   epoch keeper's cursor is the epoch keeper's. A witness that wants to check
   the epoch recomputes from chain events; it does not read
   `epoch-state.json` to decide what to expect, because a wrong cursor would
   then look right to the thing meant to catch it.
3. **The only shared input is `config.js`.** It is the frontend's source of
   truth for addresses, so a keeper and the site cannot disagree about which
   contract is live. Every reader tolerates the file's previous shape and falls
   back to a known default rather than refusing to start.
4. **State carries its deployment identity** (chain id, contract address) and
   is discarded when that identity changes. A redeploy must never be read
   through the old deployment's cursor.
5. **A run that dies before its first save leaves its state untouched**, so the
   next run resumes from the last good run. Commit-back steps run `if:
   always()` and skip cleanly when there is nothing to commit.
6. **Reads go through the canonical public RPC; only transactions may use a
   keyed endpoint.** Metered endpoints cap `eth_getLogs` to a handful of blocks
   and every backfill is tens of thousands wide.
7. **Witnesses run a few minutes after the writer they watch**, plus one
   confirmation window, so they see the writer's result instead of racing it.
   Cron minutes are staggered on purpose: writers on `:00`-style ticks, the
   heartbeat at `:09` and `:39`, the invariants monitor at `:23`.
8. **Alerts are throttled per key, and a recovery is announced once.** A keeper
   that stays down produces one message per re-alert interval, not one per run.
9. **A Telegram failure never fails a job.** Sends are best-effort, Markdown
   retries as plain text, and the ops-mode switch (`all` / `errors` / `off`)
   never touches the community stream.

The point of the rules is symbiosis without dependence: two jobs can
observe the same chain and disagree, and the disagreement is the signal.
Neither needs the other to have run.

## 3. The heartbeat

`scripts/fleet-heartbeat.js` is the witness for absence. A keeper can report
its own errors but not that it was never scheduled, which is the fleet's most
common failure: GitHub throttles cron unpredictably (a 2.4-hour hole was
observed), a lingering run hits its timeout, or a keeper fails fast on every
tick.

For each scheduled workflow it reads the last fifteen runs from the Actions
API and classifies:

| Finding | Meaning |
|---|---|
| `stale` | nothing running and the last success started more than `max(cadence × slack, grace)` minutes ago, or there is no success at all |
| `failing` | the most recent completed runs are all failures (cancelled and skipped runs are ignored; concurrency groups cancel redundant backstops by design) |
| `runaway` | more than a handful of completed runs started inside one cadence window: a self-chain gone tight, a cron misfire, or a dispatch loop. Green runs count; cancelled backstops do not. Outranks every other finding |
| `unknown` | the API could not be read for that workflow |

Defaults: slack 3 cadences, grace 30 minutes, three failures make a streak,
four completions in one cadence are a runaway, re-alert every 6 hours. The
runaway finding exists because of an incident: a zero-minute linger once
chained the notifier and the reminder into a run every fifteen seconds, every
run green, and nothing in the fleet could have said so. Absence and failure
were watched; excess was not. The invariants monitor carries a per-entry slack of 2
so a six-hour job is not eighteen hours late before anyone hears. A run that
is in progress counts as alive at any age: the settler lingers across
segments by design and its own timeout bounds it.

It exits non-zero on any finding, so the heartbeat run itself shows red in
Actions. It needs no private key and no npm install: only the repo's own
token with `actions: read`.

The heartbeat self-chains like the writers: check, commit state, sleep the
linger (`FLEET_LINGER_MINUTES`, default 30), dispatch the next run. The chain
continues after a run with findings, because a red fleet is when the watch
matters most, but not after a crash before the assessment, so a missing token
cannot loop. Its own two cron ticks were the first thing it failed to see:
on the day it shipped, neither fired.

**Blind spot, by construction.** If GitHub Actions stops entirely, the
heartbeat stops with everything else, and it cannot see its own absence
either. The dead-man switch (§8) covers both from outside.

## 4. The settler liveness witness

`scripts/settler-liveness.js` is the witness for the one keeper whose absence
stops the game. The heartbeat can say a settler run happened; it cannot say
the run did anything, and the settler's own self-chain only continues after a
run that succeeded. So this witness ignores the settler entirely and asks the
chain: is the current segment where the clock says it should be?

It reads `TimbPrize` at one block (round, segment, segment start, the segment
constants, the lock flags, the previous round's winning string) and the VRF
module's state for the current segment's salt, and judges against the block's
own timestamp, never the wall clock:

| Finding | Meaning |
|---|---|
| `stuck` | the segment is more than `SETTLER_OVERDUE_MIN` (default 5) past its 60:00 grid mark. `cause` says what the next settle needs: `unarmed` (no draw requested: nothing has called `settleSegment`), `awaiting-vrf` (armed, callback pending, re-request not yet allowed), `vrf-stalled` (callback overdue and `rearmSegment` not called), `lockable` (the word is in and nobody is locking it) |
| `paused` | settlement is paused by the owner; reported on its own, and `stuck` is suppressed while it holds |
| `locks` | an earlier segment is unlocked, or the current or a later one is locked; the contract cannot produce this by itself, which is why a witness checks it |
| `result` | the previous round's winning string has an empty character: a round settled with fewer than six locked segments |
| `unknown` | the chain could not be read |

The threshold is measured from the grid mark, not from the 59:45 close of the
interaction window, because that is what the settler's own delay alert
measures and because arm, callback and lock legitimately take up to a minute.
A segment inside the window, or a few minutes past it in any VRF state, is
the settler's business. Alerts are one per finding kind per
`SETTLER_REALERT_MIN` (default 120), with one recovery when a kind clears.

It self-chains at fifteen minutes with the `:04`/`:34` cron as backstop, on
the same `assessed`/`findings` outputs as the heartbeat. The heartbeat watches
it in turn. It cannot block the settler, and a match-notifier bug cannot hide
a stuck settler, because it shares code with neither.

## 5. The epoch reconciliation witness

`scripts/epoch-recon.js` is the witness for the keeper that holds the biggest
key. The epoch keeper's cursor is `epoch-state.json`, and the stale-cursor
incident showed the failure class: a cursor that is wrong makes every
settlement look right to the keeper while the pools run dry. Rule 2 says a
witness never reads that file, so this one reconstructs the keeper's work
from the chain alone.

A farm `RewardNotified` is a settlement. The keeper reads its scan-end block
before its own buyback of that run lands, so that buyback belongs to the next
epoch; the witness takes a `BuybackExecuted` within `RECON_RUN_WINDOW_SEC`
(default 600) before the grant as the run's start, and measures the window
from the previous run's start to this one. Over that window it sums the
buyback waterfall slice, the farm claims and the staking claims, replays the
waterfall bit for bit (including the post-blackout bootstrap), and compares
the farm grant and the same-run staking grant to the result:

| Finding | Meaning |
|---|---|
| `grant` | a settlement's farm or staking grant is more than `RECON_TOLERANCE_BPS` (default 100) from the recomputed waterfall, or the staking grant is missing; the keeper funds the farm first and tolerates a staking failure by design, and this is how that gets noticed |
| `duration` | a grant's emission period is not `EMIT_PERIOD_DAYS` |
| `orphan` | a staking grant with no farm grant in the same run: manual funding, or a keeper granting out of order |
| `overdue` | an epoch boundary passed more than `RECON_OVERDUE_MIN` (default 240) ago, budget has accrued since the last settlement, and nothing settled. Requires budget: a zero-budget epoch leaves no marker and is not overdue |
| `dead-zone` | a pool's `periodFinish` is in the past; emissions have stopped |
| `period` | a pool's `periodFinish` is not what its last seen grant set: a grant this record did not see |
| `unknown` | the chain could not be read |

Settlement findings are one-offs, reported when the settlement is first seen.
Standing findings are throttled per kind and announce one recovery. Every
alert is one message per kind, never one per finding. The first run reads
everything since genesis and treats the settlements it finds there as history:
reconciled and logged, never alerted, because they include manual fundings
and earlier eras of the keeper that were never this witness's to judge. Its
first live run alerted on twenty-three of them, one message each, which is
why both of these rules exist.

Two limits, by construction. A zero-budget epoch is invisible on chain, so
the settlement after it is reconciled over a window spanning both, and claims
made during the silent epoch show as a shortfall: one alert, gone at the next
settlement. And a keeper that is dead does no buybacks, so budget does not
accrue and `overdue` stays quiet; absence is the heartbeat's finding, and this
witness catches the keeper that runs and grants wrong, or runs and does not
settle.

The first settlement it sees is a baseline with nothing to measure from. It
self-chains at two hours with the `:47` every-2-h cron as backstop, on the
heartbeat's `assessed`/`findings` outputs, and the heartbeat watches it. Its
genesis block is `RECON_GENESIS_BLOCK`, else the keeper's
`EPOCH_GENESIS_BLOCK`, else eight days back.

## 6. The faucet reconciliation witness

`scripts/faucet-recon.js` is the three-way check the invariants monitor
leaves open. A claim leaves three marks: a `faucet_claims` row the worker
resolves to `sent` with the transaction hash, a `Dispensed` event in that
transaction, and the contract's `lastClaimAt` for the wallet. The invariants
monitor reconciles the events against the contract's tally; this witness adds
the database leg and pairs the three, so a disagreement names the leg that
lied instead of only saying that one did.

Rows and events pair by transaction hash. They arrive seconds apart but not
always in the same run, so unmatched items are carried in state and become
findings only once older than `RECON_LAG_MIN` (default 20). The contract clock
is read only for the items that failed to pair:

| Finding | Meaning |
|---|---|
| `db-only` | a `sent` row whose transaction has no Dispensed event. `lastClaimAt` at or after the reservation means the chain saw a claim and the event scan missed it; earlier means the chain never saw it and the row is wrong |
| `chain-only` | a Dispensed event that is no `sent` row's hash. A `failed` row for the same wallet within the lag means the worker paid and then failed to record it, so the wallet's day is not burned in the database and it can reserve again; no row at all means the dispatcher key was used outside the worker |
| `mismatch` | a `sent` row whose transaction paid a different wallet |
| `stale` | a `reserved` row older than the lag: the worker's fifteen-minute housekeeping is not running |
| `unknown` | the chain or the database could not be read |

The row cursor advances only past resolved rows, because a row read while
`reserved` must be read again once resolved or its `sent` would look like an
event with no row. It reads `faucet_claims` with the service key like the
worker, the notifier and the scorer, because the table has no anon policy;
it never writes. Genesis is `FAUCET_GENESIS_BLOCK`, else the invariants
monitor's per-chain default; rows older than that block are outside the
record. It self-chains hourly with the `:37` cron as backstop, on the
heartbeat's `assessed`/`findings` outputs, and the heartbeat watches it.

## 7. The points reconciliation witness

`scripts/points-recon.js` is the spot check grown into a shadow. The scorer
folds on-chain activity into the board behind a settlement lag and keeps its
cursors in the `seasons` row; a cursor that skips a window under-scores every
wallet, one that replays a window over-scores every wallet, and the board
looks plausible either way. The cost of a witness here is the event scan,
not the number of wallets compared, so this one keeps a full shadow ledger:
it folds the same events by its own path, with its own block and round
cursors, and compares every wallet's counters and display score to the board
each run. It reads the season's configuration (start block and round, lag,
minimum rounds, weights) and the board; it never reads the scorer's cursors
and never writes to Supabase.

Each counter is recomputed exactly as the scorer defines it: rounds from
`getRoundEntrants` for every settled round inside the lag; nudge-swaps, plain
swaps and panel nudges from `Swap` and `ScrollNudged` grouped by transaction
and attributed to `tx.from`; ticket activations whose owner entered the
round; farm and staking claims of at least 25 TIMBS; wins; faucet drips from
the `faucet_claims` table up to the lag block's time. The window ends at the
block where round (current − lag + 1) started, found from `RoundStarted` the
way the scorer finds it. `display_tp` is checked against the row's own
counters and the season's weights.

| Finding | Meaning |
|---|---|
| `over` | the board's counter exceeds the shadow's: the scorer counted something the chain does not show, a replayed window or a cursor that moved backwards. Immediate |
| `under` | the board's counter is below the shadow's and has been for `POINTS_GRACE_MIN` (default 180): a skipped window. The grace covers the scorer not having run since the lag block moved |
| `tp` | `display_tp` is not what the row's counters and the weights give: the SQL recompute disagrees with the weights |
| `unknown` | the chain or the database could not be read |

Discrepancies are alerted once per kind per re-alert interval, because a
skipped window is one problem across many wallets, not one per wallet. The
ledger is keyed to chain, contracts, season id and start block, so a new
season or a redeploy starts it over. It self-chains hourly with the `:52`
cron as backstop, on the heartbeat's `assessed`/`findings` outputs, and the
heartbeat watches it.

## 8. The dead-man switch

`scripts/dead-man.js` is the one call that leaves Actions. An outside
service (a Healthchecks.io check, a Cronitor or Uptime Kuma push URL, any
service that alerts when an expected call stops) is told to expect a ping
every thirty minutes. This job reads the heartbeat's runs from the Actions
API, judges them with the heartbeat's own assessment applied to the
heartbeat itself (a 30-minute cadence, the same slack, grace, streak and
runaway rules), and pings only while the heartbeat is alive. So the outside
service alerts when Actions has stopped (nothing runs, no ping), when this
job's own chain has died (no ping, and the heartbeat also reports it stale),
and when the heartbeat has died (this job runs and withholds the ping, and
hits the optional fail URL so the silence is marked deliberate). The
heartbeat watches this job back. Neither dispatches the other, and neither
needs the other to have run.

| Finding | Meaning |
|---|---|
| `heartbeat` | the heartbeat is stale, failing, runaway or unreadable by its own rules; the ping is withheld |
| `ping` | the outside service could not be reached; the switch may fire for the wrong reason |
| `unset` | `DEADMAN_PING_URL` is not set: the switch is not wired. Reported every re-alert interval so an unwired switch is never mistaken for a working one |

An unreadable API counts as a dead heartbeat, because the ping must never be
sent on a guess. The switch is only complete once the outside check exists,
with a period of thirty minutes and a grace of thirty, and its ping URL is in
the `DEADMAN_PING_URL` secret; the job runs and reports `unset` until then.

## 9. The library

`scripts/lib/` is the plumbing every job shares, extracted so a new witness
is a page of logic rather than a page of logic plus a page of boilerplate:

| Module | Provides |
|---|---|
| `config.js` | `addrFromConfig(key)` (refuses the zero address), `rpcFromConfig()` (literal → `PUBLIC_RPCS[0]` → canonical) |
| `logs.js` | `scanLogs` / `scanEvents` / `sumEvents` in bounded chunks, `blockTimestamps` batched per distinct block; provider errors surfaced with the RPC's own message |
| `state.js` | `loadState(file, fresh, { matches })` that discards a file from another deployment, `saveState` |
| `telegram.js` | `makeTelegram({ token, chatId, mode })` with `send` / `notify`, and `shouldRealert` |

Every job that reads config.js, scans events, keeps a state file or posts to Telegram is its consumer: the heartbeat, the four reconciliation witnesses, the dead-man switch, the settler, the epoch keeper and the invariants monitor.
