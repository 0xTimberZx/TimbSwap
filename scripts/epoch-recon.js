// epoch-recon.js — did the epoch keeper grant what the chain says it should have?
//
// The epoch keeper (epoch.js) settles every six rounds: it sums the buyback
// waterfall slice (z) and the farm and staking claims (y, w) since its cursor,
// runs the waterfall, and grants the farm and the staking pool. Its cursor
// lives in epoch-state.json, and a wrong cursor once made every settlement
// look right to the keeper while the pools ran dry. This witness never reads
// that file (dev-docs/KEEPER_FLEET.md rule 2). It reads the chain: every farm
// grant the keeper landed is a RewardNotified event, the inputs it should have
// used are BuybackExecuted and RewardsClaimed events, and the period the pools
// now hold is periodFinish. It recomputes each settlement from those and says
// where the keeper's number and the chain's number disagree. No key; it never
// calls a contract.
//
// How a settlement is found and bounded. A farm RewardNotified is a
// settlement. The keeper's scan window ends at the block it read on startup,
// before its own buyback of that run lands, so the run's buyback belongs to
// the NEXT epoch; the witness therefore takes a buyback within RUN_WINDOW
// seconds before the grant as the run's start, and measures the window from
// the previous run's start to this one. A staking RewardNotified within
// RUN_WINDOW after the farm grant is the same settlement's staking grant.
//
// Findings:
//   grant      a settlement's farm or staking grant differs from the recomputed
//              waterfall by more than RECON_TOLERANCE_BPS, or the staking grant
//              is missing (the keeper funds the farm first and tolerates a
//              staking failure by design; this is how it gets noticed)
//   duration   a grant's emission period is not EMIT_PERIOD_DAYS
//   orphan     a staking grant with no farm grant in the same run (manual
//              funding, or a keeper that granted out of order)
//   overdue    an epoch boundary passed more than RECON_OVERDUE_MIN ago, the
//              treasury has taken in waterfall budget since the last settlement,
//              and no settlement has landed. A zero-budget epoch leaves no
//              marker, so it is not counted as overdue
//   dead-zone  a pool's periodFinish is in the past: emissions have stopped
//   period     a pool's periodFinish is not what its last seen grant set
//   unknown    the chain could not be read
//
// Limits, by construction. A zero-budget epoch is invisible on chain, so the
// settlement after it is reconciled over a window that spans both, and claims
// made during the silent epoch can show as a shortfall: one alert, gone at the
// next settlement. Manual funding through fund-rewards.js looks like a
// settlement with an unexpected amount; that is a finding on purpose.
//
// State: scripts/epoch-recon-state.json — scan cursor, the last settlement's
// run-start block and round, the last grant seen per pool, and last-alerted
// stamps. Keyed to chain id and the four contract addresses; a redeploy of any
// of them starts the record over.
//
// Env:
//   RECON_RPC               optional; default = config.js public RPC (reads only)
//   RECON_GENESIS_BLOCK     first block on the first run; else EPOCH_GENESIS_BLOCK;
//                           else latest − 3,000,000 (about eight days)
//   RECON_TOLERANCE_BPS     grant mismatch tolerance (default 100 = 1 %)
//   RECON_OVERDUE_MIN       minutes past an epoch boundary before `overdue` (default 240)
//   RECON_RUN_WINDOW_SEC    how close in time two transactions must be to belong
//                           to one keeper run (default 600)
//   RECON_REALERT_MIN       minutes between repeat alerts for a standing finding (default 360)
//   EMIT_PERIOD_DAYS, FARM_BOOTSTRAP_BPS, STAKE_BOOTSTRAP_BPS   the keeper's own knobs, same defaults
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_OPS_MODE   optional alerts
//
// Flags: --self-test  --dry-run (no Telegram, no state write)  --report (summary even when healthy)

const fs   = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { addrFromConfig, rpcFromConfig } = require("./lib/config");
const { scanEvents, sumEvents, blockTimestamps } = require("./lib/logs");
const { loadState, saveState } = require("./lib/state");
const { makeTelegram, shouldRealert } = require("./lib/telegram");

const SELF_TEST = process.argv.includes("--self-test");
const DRY_RUN   = process.argv.includes("--dry-run");
const REPORT    = process.argv.includes("--report");

const STATE_PATH = path.join(__dirname, "epoch-recon-state.json");
const GENESIS_FALLBACK_SPAN = 3_000_000;

// The keeper's waterfall constants (epoch.js). Fixed there, fixed here.
const ROUNDS_PER_EPOCH = 6;
const WATERFALL = {
  farmBps:      8_000n,   // farmGrant  = 0.80 × y
  stakeBoostBps: 12_500n, // stakeWant  = 1.25 × w
  stakeCapBps:  8_000n,   // stakeGrant ≤ 0.80 × leftover
  farmBootBps:  BigInt(process.env.FARM_BOOTSTRAP_BPS  || "3000"),
  stakeBootBps: BigInt(process.env.STAKE_BOOTSTRAP_BPS || "2000"),
};

const OPTS = {
  toleranceBps: Number(process.env.RECON_TOLERANCE_BPS || 100),
  overdueMin:   Number(process.env.RECON_OVERDUE_MIN || 240),
  runWindowSec: Number(process.env.RECON_RUN_WINDOW_SEC || 600),
  realertMin:   Number(process.env.RECON_REALERT_MIN || 360),
  periodSec:    Math.round(Number(process.env.EMIT_PERIOD_DAYS || "90") * 86_400),
  dustWei:      10n ** 18n,   // 1 TIMBS: below this a difference is rounding, not a finding
};

const fmt = (wei) => Number(ethers.formatEther(wei)).toFixed(3);
const epochOf = (round) => Math.floor((round - 1) / ROUNDS_PER_EPOCH);

// ─── Pure logic (exported for --self-test) ──────────────────────────────────

/** The keeper's waterfall, bit for bit: farm → staking → boost, never more than z. */
function waterfall(z, y, w, k = WATERFALL) {
  let B = z;
  let farmWant = (y * k.farmBps) / 10_000n;
  if (farmWant === 0n && z > 0n) farmWant = (z * k.farmBootBps) / 10_000n;
  const farm = farmWant < B ? farmWant : B;
  B -= farm;
  let stakeWant = (w * k.stakeBoostBps) / 10_000n;
  if (stakeWant === 0n && z > 0n) stakeWant = (z * k.stakeBootBps) / 10_000n;
  const stakeCap = (B * k.stakeCapBps) / 10_000n;
  const stake = stakeWant < stakeCap ? stakeWant : stakeCap;
  B -= stake;
  return { farm, stake, boostBudget: B };
}

/** |actual − expected| within max(expected × bps, dust). */
function within(actual, expected, toleranceBps, dustWei) {
  const diff = actual > expected ? actual - expected : expected - actual;
  const allowed = (expected * BigInt(toleranceBps)) / 10_000n;
  return diff <= (allowed > dustWei ? allowed : dustWei);
}

/**
 * Pair the events of one scan into keeper runs.
 *   farmGrants, stakeGrants: [{ block, ts, amount, duration, notifier }] in chain order
 *   buybacks:                [{ block, ts, waterfall }] in chain order
 * Returns { settlements: [{ farm, stake|null, runStartBlock }], orphans: [stakeGrant] }.
 */
function groupRuns(farmGrants, stakeGrants, buybacks, runWindowSec) {
  const usedStake = new Set();
  const settlements = farmGrants.map((farm, i) => {
    const nextFarmTs = farmGrants[i + 1]?.ts ?? Infinity;
    const stake = stakeGrants.find((s, j) => !usedStake.has(j) && s.ts >= farm.ts && s.ts <= farm.ts + runWindowSec && s.ts < nextFarmTs) ?? null;
    if (stake) usedStake.add(stakeGrants.indexOf(stake));
    const sameRun = buybacks.filter((b) => b.ts >= farm.ts - runWindowSec && b.ts <= farm.ts);
    const runStartBlock = sameRun.length ? Math.min(...sameRun.map((b) => b.block)) : farm.block;
    return { farm, stake, runStartBlock };
  });
  const orphans = stakeGrants.filter((_s, j) => !usedStake.has(j));
  return { settlements, orphans };
}

/** Compare one settlement to the recomputed waterfall. Returns findings. */
function reconcile(s, inputs, opts = OPTS, k = WATERFALL) {
  const exp = waterfall(inputs.z, inputs.y, inputs.w, k);
  const findings = [];
  const tag = `settlement @ block ${s.farm.block}`;
  if (!within(s.farm.amount, exp.farm, opts.toleranceBps, opts.dustWei)) {
    findings.push({ kind: "grant", detail: `${tag}: farm granted ${fmt(s.farm.amount)} but z=${fmt(inputs.z)} y=${fmt(inputs.y)} w=${fmt(inputs.w)} gives ${fmt(exp.farm)}` });
  }
  const stakeActual = s.stake ? s.stake.amount : 0n;
  if (!within(stakeActual, exp.stake, opts.toleranceBps, opts.dustWei)) {
    findings.push({ kind: "grant", detail: s.stake
      ? `${tag}: staking granted ${fmt(stakeActual)} but the waterfall gives ${fmt(exp.stake)}`
      : `${tag}: no staking grant in the run; the waterfall gives ${fmt(exp.stake)}` });
  }
  for (const [name, g] of [["farm", s.farm], ["staking", s.stake]]) {
    if (g && g.duration !== opts.periodSec) {
      findings.push({ kind: "duration", detail: `${tag}: ${name} grant period ${Math.round(g.duration / 86_400)} d, expected ${Math.round(opts.periodSec / 86_400)} d` });
    }
  }
  return { findings, expected: exp };
}

/**
 * Standing checks against live contract state.
 * live = { nowSec, round, segment, segmentStart, segmentSec, roundSec,
 *          farmPeriodFinish, stakePeriodFinish, zSince,
 *          lastSettlement: { round, ts } | null, lastGrant: { farm, stake } (each { ts, duration } | null),
 *          sinceSec }   (sinceSec: when the record began, for the never-settled case)
 */
function assessLive(live, opts = OPTS) {
  const findings = [];
  for (const [name, pf] of [["farm", live.farmPeriodFinish], ["staking", live.stakePeriodFinish]]) {
    if (pf <= live.nowSec) findings.push({ kind: "dead-zone", detail: `${name} periodFinish passed ${fmtMin(live.nowSec - pf)} ago — emissions stopped` });
  }
  for (const [name, pf, g] of [["farm", live.farmPeriodFinish, live.lastGrant.farm], ["staking", live.stakePeriodFinish, live.lastGrant.stake]]) {
    if (g && pf !== g.ts + g.duration) {
      findings.push({ kind: "period", detail: `${name} periodFinish is ${pf}, but the last grant seen sets ${g.ts + g.duration} — a grant this record did not see` });
    }
  }

  // An epoch boundary with budget behind it and no settlement after it.
  const curEpoch = epochOf(live.round);
  const roundStart = live.segmentStart - (live.segment - 1) * live.segmentSec;
  const boundaryRound = curEpoch * ROUNDS_PER_EPOCH + 1;
  const boundaryTs = roundStart - (live.round - boundaryRound) * live.roundSec;
  if (live.zSince > 0n) {
    if (live.lastSettlement && live.lastSettlement.round != null) {
      if (live.round < live.lastSettlement.round) {
        // rounds went backwards: a game reset the keeper settles on sight
      } else if (curEpoch > epochOf(live.lastSettlement.round) && live.nowSec - boundaryTs > opts.overdueMin * 60) {
        findings.push({ kind: "overdue", detail: `epoch ${curEpoch} began at round ${boundaryRound}, ${fmtMin(live.nowSec - boundaryTs)} ago; last settlement was round ${live.lastSettlement.round} and ${fmt(live.zSince)} of budget has accrued since` });
      }
    } else if (!live.lastSettlement && live.nowSec - live.sinceSec > ROUNDS_PER_EPOCH * live.roundSec + opts.overdueMin * 60) {
      findings.push({ kind: "overdue", detail: `no settlement seen in ${fmtMin(live.nowSec - live.sinceSec)} of record with ${fmt(live.zSince)} of budget accrued` });
    }
  }
  return findings;
}

function fmtMin(sec) {
  const s = Math.max(0, Math.round(sec));
  return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
}

// Findings about a specific settlement are one-offs: they are reported when
// the settlement is first seen and never again. Standing findings describe
// the current state and are throttled with a recovery when they clear.
const STANDING = new Set(["overdue", "dead-zone", "period", "unknown"]);

/**
 * Decide what to send. Returns { alerts: [{ kind, items }], recoveries }.
 * One message per kind, never one per finding: a first-run backfill once sent
 * twenty-three messages for what was one story. One-off kinds send every run
 * they occur; standing kinds are throttled per kind and announce a recovery.
 */
function plan(state, findings, nowSec, opts = OPTS) {
  state.alerted ??= {};
  const alerts = [], recoveries = [];
  const present = new Set(findings.filter((f) => STANDING.has(f.kind)).map((f) => f.kind));
  for (const kind of Object.keys(state.alerted)) {
    if (!present.has(kind)) { recoveries.push(kind); delete state.alerted[kind]; }
  }
  const byKind = new Map();
  for (const f of findings) (byKind.get(f.kind) ?? byKind.set(f.kind, []).get(f.kind)).push(f);
  for (const [kind, items] of byKind) {
    if (!STANDING.has(kind)) { alerts.push({ kind, items }); continue; }
    if (shouldRealert(state.alerted[kind], nowSec, opts.realertMin * 60)) {
      alerts.push({ kind, items });
      state.alerted[kind] = nowSec;
    }
  }
  return { alerts, recoveries };
}

module.exports = { WATERFALL, epochOf, waterfall, within, groupRuns, reconcile, assessLive, plan, main };

// ─── Self-test ──────────────────────────────────────────────────────────────

function selfTest() {
  const E = (n) => BigInt(n) * 10n ** 18n;
  const opts = { ...OPTS, toleranceBps: 100, overdueMin: 240, runWindowSec: 600, realertMin: 360, periodSec: 90 * 86_400 };
  let pass = 0, fail = 0;
  const eq = (name, got, want) => {
    const g = JSON.stringify(got, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const w = JSON.stringify(want, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    if (g === w) pass++; else { fail++; console.error(`FAIL ${name}: got ${g} want ${w}`); }
  };

  // Waterfall: the keeper's arithmetic.
  eq("farm takes 0.8y",                 waterfall(E(1000), E(500), E(100)).farm, E(400));
  eq("stake takes 1.25w under cap",     waterfall(E(1000), E(500), E(100)).stake, E(125));
  eq("boost gets the rest",             waterfall(E(1000), E(500), E(100)).boostBudget, E(475));
  eq("farm capped at z",                waterfall(E(100), E(500), E(100)), { farm: E(100), stake: 0n, boostBudget: 0n });
  eq("stake capped at 0.8 leftover",    waterfall(E(1000), E(500), E(1000)).stake, E(480));
  eq("farm bootstrap when no claims",   waterfall(E(1000), 0n, E(100)).farm, E(300));
  eq("stake bootstrap when no claims",  waterfall(E(1000), E(500), 0n).stake, E(200));
  eq("zero z is all zero",              waterfall(0n, E(500), E(100)), { farm: 0n, stake: 0n, boostBudget: 0n });

  // Tolerance.
  eq("within 1%",                       within(E(1000), E(1005), 100, E(1)), true);
  eq("outside 1%",                      within(E(1000), E(1011), 100, E(1)), false);
  eq("dust floor on tiny expected",     within(E(1), 10n ** 17n, 100, E(1)), true);
  eq("zero vs zero",                    within(0n, 0n, 100, E(1)), true);
  eq("zero vs two TIMBS",               within(0n, E(2), 100, E(1)), false);

  // Run grouping.
  const g = (block, ts, amount, duration = 90 * 86_400) => ({ block, ts, amount, duration, notifier: "0xk" });
  const b = (block, ts, wf) => ({ block, ts, waterfall: wf });
  {
    const r = groupRuns([g(1000, 5000, E(400))], [g(1010, 5030, E(125))], [b(990, 4980, E(50)), b(500, 1000, E(50))], 600);
    eq("stake within run is paired",       r.settlements[0].stake.amount, E(125));
    eq("same-run buyback sets run start",  r.settlements[0].runStartBlock, 990);
    eq("earlier buyback is not the run",   r.settlements[0].runStartBlock !== 500, true);
    eq("no orphans",                       r.orphans.length, 0);
  }
  {
    const r = groupRuns([g(1000, 5000, E(400))], [g(1010, 5030, E(125)), g(3000, 9000, E(7))], [], 600);
    eq("no buyback: run starts at grant",  r.settlements[0].runStartBlock, 1000);
    eq("late staking grant is an orphan",  r.orphans.map((o) => o.amount), [E(7)]);
  }
  {
    const r = groupRuns([g(1000, 5000, E(400)), g(1100, 5100, E(10))], [g(1150, 5150, E(3))], [], 600);
    eq("staking pairs with the nearest preceding farm grant", [r.settlements[0].stake, r.settlements[1].stake?.amount], [null, E(3)]);
  }

  // Reconcile.
  const st = (farmAmt, stakeAmt, dur = 90 * 86_400) => ({ farm: g(1000, 5000, farmAmt, dur), stake: stakeAmt == null ? null : g(1010, 5030, stakeAmt, dur), runStartBlock: 990 });
  const inp = { z: E(1000), y: E(500), w: E(100) };
  eq("exact grants reconcile",           reconcile(st(E(400), E(125)), inp, opts).findings, []);
  eq("within tolerance reconciles",      reconcile(st(E(402), E(124)), inp, opts).findings, []);
  eq("farm off is a grant finding",      reconcile(st(E(300), E(125)), inp, opts).findings.map((f) => f.kind), ["grant"]);
  eq("missing staking is a grant finding", /no staking grant/.test(reconcile(st(E(400), null), inp, opts).findings[0].detail), true);
  eq("missing staking when none due is fine", reconcile(st(E(100), null), { z: E(100), y: E(500), w: E(100) }, opts).findings, []);
  eq("wrong duration is a duration finding", reconcile(st(E(400), E(125), 30 * 86_400), inp, opts).findings.map((f) => f.kind), ["duration", "duration"]);

  // Live checks.
  const T = 2_000_000_000;
  const live = (over = {}) => ({
    nowSec: T, round: 55, segment: 2, segmentStart: T - 600, segmentSec: 3600, roundSec: 21_600,
    farmPeriodFinish: T + 80 * 86_400, stakePeriodFinish: T + 80 * 86_400, zSince: E(50),
    lastSettlement: { round: 55, ts: T - 4000 }, lastGrant: { farm: null, stake: null }, sinceSec: T - 30 * 86_400,
    ...over,
  });
  const kinds = (f) => f.map((x) => x.kind);
  eq("healthy is clean",                 kinds(assessLive(live(), opts)), []);
  eq("farm period passed is dead-zone",  kinds(assessLive(live({ farmPeriodFinish: T - 1 }), opts)), ["dead-zone"]);
  eq("period matches last grant",        kinds(assessLive(live({ lastGrant: { farm: { ts: T - 10 * 86_400, duration: 90 * 86_400 }, stake: null } }), opts)), []);
  eq("period unlike last grant",         kinds(assessLive(live({ lastGrant: { farm: { ts: T - 20 * 86_400, duration: 90 * 86_400 }, stake: null } }), opts)), ["period"]);
  // round 55 is epoch 9 (rounds 55–60); last settlement at round 49 (epoch 8): boundary is round 55's start.
  eq("same epoch as last settlement is ok", kinds(assessLive(live({ lastSettlement: { round: 55 } }), opts)), []);
  eq("new epoch, boundary just passed, ok",  kinds(assessLive(live({ lastSettlement: { round: 49 }, segment: 1, segmentStart: T - 600 }), opts)), []);
  eq("new epoch, boundary 5 h ago, overdue", kinds(assessLive(live({ lastSettlement: { round: 49 }, segment: 1, segmentStart: T - 5 * 3600 }), opts)), ["overdue"]);
  eq("overdue needs budget since",           kinds(assessLive(live({ lastSettlement: { round: 49 }, segment: 1, segmentStart: T - 5 * 3600, zSince: 0n }), opts)), []);
  eq("boundary time counts back rounds",     kinds(assessLive(live({ round: 57, lastSettlement: { round: 49 }, segment: 1, segmentStart: T - 600 }), opts)), ["overdue"]);
  eq("rounds went backwards is not overdue", kinds(assessLive(live({ round: 3, lastSettlement: { round: 49 } }), opts)), []);
  eq("never settled, young record, ok",      kinds(assessLive(live({ lastSettlement: null, sinceSec: T - 86_400 }), opts)), []);
  eq("never settled, old record, overdue",   kinds(assessLive(live({ lastSettlement: null, sinceSec: T - 3 * 86_400 }), opts)), ["overdue"]);

  // Alert planning: one message per kind; one-offs every run, standing
  // throttled with recovery.
  const state = { alerted: {} };
  let p = plan(state, [{ kind: "grant", detail: "a" }, { kind: "grant", detail: "a2" }, { kind: "overdue", detail: "b" }], T, opts);
  eq("first run alerts both kinds once",  p.alerts.map((a) => `${a.kind}×${a.items.length}`), ["grant×2", "overdue×1"]);
  p = plan(state, [{ kind: "grant", detail: "c" }, { kind: "overdue", detail: "b" }], T + 60, opts);
  eq("one-off repeats, standing throttled", p.alerts.map((a) => a.kind), ["grant"]);
  p = plan(state, [{ kind: "overdue", detail: "b" }], T + 361 * 60, opts);
  eq("standing re-alerts after interval", p.alerts.map((a) => a.kind), ["overdue"]);
  p = plan(state, [], T + 400 * 60, opts);
  eq("standing recovery once",           p.recoveries, ["overdue"]);
  p = plan(state, [], T + 401 * 60, opts);
  eq("no second recovery",               p.recoveries.length, 0);
  p = plan(state, [{ kind: "dead-zone", detail: "f" }, { kind: "dead-zone", detail: "s" }], T + 500 * 60, opts);
  eq("two of one standing kind alert once", [p.alerts.length, p.alerts[0].items.length], [1, 2]);
  p = plan(state, Array.from({ length: 23 }, (_, i) => ({ kind: i % 2 ? "grant" : "duration", detail: String(i) })), T + 600 * 60, opts);
  eq("twenty-three one-offs are two messages", p.alerts.map((a) => `${a.kind}×${a.items.length}`), ["duration×12", "grant×11"]);

  console.log(`self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (SELF_TEST) selfTest();

// ─── Live run ───────────────────────────────────────────────────────────────

const POOL_ABI = [
  "event RewardNotified(address indexed notifier, uint256 amount, uint256 duration)",
  "event RewardsClaimed(address indexed user, uint256 amount)",
  "function periodFinish() view returns (uint256)",
];
const TREASURY_ABI = [
  "event BuybackExecuted(uint256 ethSpent, uint256 timbsBought, uint256 timbsBurned, uint256 timbsToWaterfall, uint256 timbsReserved)",
];
const PRIZE_ABI = [
  "event RoundStarted(uint256 indexed round, uint256 timestamp)",
  "function currentRound() view returns (uint256)",
  "function currentSegment() view returns (uint256)",
  "function segmentStartTime() view returns (uint256)",
  "function SEGMENT_DURATION() view returns (uint256)",
  "function ROUND_DURATION() view returns (uint256)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RECON_RPC || rpcFromConfig());
  const chainId  = Number((await provider.getNetwork()).chainId);
  const addr = {
    farm: addrFromConfig("TimbFarm"), staking: addrFromConfig("TimbStaking"),
    treasury: addrFromConfig("TimbTreasury"), prize: addrFromConfig("TimbPrize"),
  };
  const poolIface = new ethers.Interface(POOL_ABI), treasuryIface = new ethers.Interface(TREASURY_ABI), prizeIface = new ethers.Interface(PRIZE_ABI);
  const farm = new ethers.Contract(addr.farm, POOL_ABI, provider);
  const staking = new ethers.Contract(addr.staking, POOL_ABI, provider);
  const prize = new ethers.Contract(addr.prize, PRIZE_ABI, provider);

  const tg = makeTelegram({ token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID, mode: process.env.TELEGRAM_OPS_MODE, tag: "epoch-recon" });
  const out = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };

  const latest = await provider.getBlock("latest");
  const nowSec = latest.timestamp;
  const sameDeployment = (s) => s.chainId === chainId && ["farm", "staking", "treasury", "prize"].every((k) => String(s[k]).toLowerCase() === addr[k].toLowerCase());
  const state = loadState(STATE_PATH, () => {
    const g = process.env.RECON_GENESIS_BLOCK || process.env.EPOCH_GENESIS_BLOCK;
    const cursorBlock = g ? Number(g) - 1 : Math.max(0, latest.number - GENESIS_FALLBACK_SPAN);
    if (!g) console.warn(`no genesis block set — record starts at ${cursorBlock + 1} (latest − ${GENESIS_FALLBACK_SPAN})`);
    // `backfill`: the first run reads everything since genesis. Settlements
    // from before this record existed are reconciled and logged as history,
    // not alerted: they include manual fundings and earlier eras of the keeper
    // that were never this witness's to judge. Standing checks still apply.
    return { chainId, ...addr, cursorBlock, sinceSec: nowSec, lastSettlement: null, lastGrant: { farm: null, stake: null }, zAccrued: "0", backfill: true, alerted: {} };
  }, { matches: sameDeployment, label: "recon state" });
  const backfill = state.backfill === true;

  const from = state.cursorBlock + 1, to = latest.number;
  console.log(`epoch recon @ block ${to}  chain ${chainId}  scan ${from} → ${to}  tolerance ${OPTS.toleranceBps} bps${backfill ? "  (first run: history is logged, not alerted)" : ""}`);

  let findings = [];
  const history = [];
  let summary = "";
  try {
    // 1. New grants and the buybacks around them.
    const decode = (evs, pick) => evs.map(({ args, log }) => ({ block: log.blockNumber, ...pick(args) }));
    const [farmEv, stakeEv] = await Promise.all([
      scanEvents(provider, poolIface, "RewardNotified", addr.farm, from, to),
      scanEvents(provider, poolIface, "RewardNotified", addr.staking, from, to),
    ]);
    const farmGrants  = decode(farmEv,  (a) => ({ amount: BigInt(a.amount), duration: Number(a.duration), notifier: a.notifier }));
    const stakeGrants = decode(stakeEv, (a) => ({ amount: BigInt(a.amount), duration: Number(a.duration), notifier: a.notifier }));

    // Buybacks since the last settlement's run start: both for run-start
    // detection and for "has budget accrued since" (overdue needs it).
    const sinceBlock = state.lastSettlement ? state.lastSettlement.runStartBlock : state.cursorBlock + 1;
    const buybackEv = await scanEvents(provider, treasuryIface, "BuybackExecuted", addr.treasury, sinceBlock, to);
    const buybacks = decode(buybackEv, (a) => ({ waterfall: BigInt(a.timbsToWaterfall) }));

    const tsOf = await blockTimestamps(provider, [...farmGrants, ...stakeGrants, ...buybacks].map((e) => e.block));
    for (const e of [...farmGrants, ...stakeGrants, ...buybacks]) e.ts = tsOf[e.block];

    const { settlements, orphans } = groupRuns(farmGrants, stakeGrants, buybacks, OPTS.runWindowSec);
    console.log(`  new grants: farm ${farmGrants.length}, staking ${stakeGrants.length}; buybacks since last run start: ${buybacks.length}`);

    // 2. Reconcile each new settlement over the window since the previous one.
    for (const s of settlements) {
      const prev = state.lastSettlement;
      let round = null;
      const rsFrom = prev ? prev.runStartBlock : state.cursorBlock + 1;
      const rounds = await scanEvents(provider, prizeIface, "RoundStarted", addr.prize, rsFrom, s.farm.block);
      if (rounds.length) round = Number(rounds[rounds.length - 1].args.round);
      else if (prev?.round != null) round = prev.round;

      if (!prev) {
        console.log(`  baseline settlement @ ${s.farm.block}: farm ${fmt(s.farm.amount)} staking ${s.stake ? fmt(s.stake.amount) : "—"} (round ${round ?? "?"}) — no earlier settlement to measure from`);
      } else {
        const wFrom = prev.runStartBlock, wTo = s.runStartBlock - 1;
        const [z, y, w] = await Promise.all([
          sumEvents(provider, treasuryIface, "BuybackExecuted", addr.treasury, wFrom, wTo, (a) => BigInt(a.timbsToWaterfall)),
          sumEvents(provider, poolIface, "RewardsClaimed", addr.farm, wFrom, wTo, (a) => BigInt(a.amount)),
          sumEvents(provider, poolIface, "RewardsClaimed", addr.staking, wFrom, wTo, (a) => BigInt(a.amount)),
        ]);
        const r = reconcile(s, { z, y, w });
        console.log(`  settlement @ ${s.farm.block} (round ${round ?? "?"}, window ${wFrom}–${wTo}): z=${fmt(z)} y=${fmt(y)} w=${fmt(w)} → farm ${fmt(s.farm.amount)} vs ${fmt(r.expected.farm)}, staking ${s.stake ? fmt(s.stake.amount) : "—"} vs ${fmt(r.expected.stake)} ${r.findings.length ? "✗" : "✓"}`);
        (backfill ? history : findings).push(...r.findings);
      }
      state.lastSettlement = { block: s.farm.block, runStartBlock: s.runStartBlock, ts: s.farm.ts, round, farm: s.farm.amount.toString(), stake: s.stake ? s.stake.amount.toString() : null };
    }
    for (const o of orphans) (backfill ? history : findings).push({ kind: "orphan", detail: `staking grant of ${fmt(o.amount)} @ block ${o.block} by ${o.notifier} with no farm grant in the same run` });
    if (farmGrants.length)  state.lastGrant.farm  = { ts: farmGrants.at(-1).ts,  duration: farmGrants.at(-1).duration };
    if (stakeGrants.length) state.lastGrant.stake = { ts: stakeGrants.at(-1).ts, duration: stakeGrants.at(-1).duration };

    // 3. Standing checks.
    const tag = { blockTag: to };
    const [fpf, spf, round, segment, segmentStart, segmentSec, roundSec] = await Promise.all([
      farm.periodFinish(tag), staking.periodFinish(tag),
      prize.currentRound(tag), prize.currentSegment(tag), prize.segmentStartTime(tag), prize.SEGMENT_DURATION(tag), prize.ROUND_DURATION(tag),
    ]);
    // Budget accrued since the last settlement's run start: scanned from there
    // when one is known; before any settlement, carried across runs in state.
    let zSince;
    if (state.lastSettlement) {
      zSince = buybacks.filter((b) => b.block >= state.lastSettlement.runStartBlock).reduce((a, b) => a + b.waterfall, 0n);
      state.zAccrued = "0";
    } else {
      zSince = BigInt(state.zAccrued || "0") + buybacks.reduce((a, b) => a + b.waterfall, 0n);
      state.zAccrued = zSince.toString();
    }
    const live = {
      nowSec, round: Number(round), segment: Number(segment), segmentStart: Number(segmentStart), segmentSec: Number(segmentSec), roundSec: Number(roundSec),
      farmPeriodFinish: Number(fpf), stakePeriodFinish: Number(spf), zSince,
      lastSettlement: state.lastSettlement, lastGrant: state.lastGrant, sinceSec: state.sinceSec,
    };
    findings.push(...assessLive(live));
    summary = `round ${live.round} (epoch ${epochOf(live.round)}) · last settlement ${state.lastSettlement ? `round ${state.lastSettlement.round ?? "?"} @ ${state.lastSettlement.block}` : "none seen"} · budget since ${fmt(zSince)} · farm period ends in ${fmtMin(live.farmPeriodFinish - nowSec)} · staking in ${fmtMin(live.stakePeriodFinish - nowSec)}`;
    state.cursorBlock = to;
    state.backfill = false;   // history is read once; from here every settlement is judged
  } catch (e) {
    const inner = e?.error?.message || e?.info?.error?.message;
    findings.push({ kind: "unknown", detail: `chain read failed: ${e.shortMessage || e.message}${inner ? ` (${inner})` : ""}` });
  }
  out("assessed", "true");

  if (history.length) {
    console.log(`  history before this record (${history.length}, logged only):`);
    for (const f of history) console.log(`    [${f.kind}] ${f.detail}`);
  }
  console.log(`  ${findings.length ? "✗" : "✓"} ${summary}`);
  for (const f of findings) console.log(`    [${f.kind}] ${f.detail}`);

  const { alerts, recoveries } = plan(state, findings, nowSec);
  const message = (a) => `🚨 Epoch reconciliation [${a.kind}] × ${a.items.length}\n` +
    a.items.slice(0, 5).map((f) => f.detail).join("\n") + (a.items.length > 5 ? `\n…and ${a.items.length - 5} more` : "");
  if (DRY_RUN) {
    console.log(`\n(dry run) would alert: ${alerts.map((a) => `${a.kind}×${a.items.length}`).join(", ") || "none"}; recoveries: ${recoveries.join(", ") || "none"}`);
  } else {
    // The cursor advances only with a clean read; an `unknown` run leaves it.
    saveState(STATE_PATH, state);
    for (const a of alerts) await tg.notify(message(a));
    if (recoveries.length) await tg.notify(`✅ Epoch reconciliation recovered: ${recoveries.join(", ")}\n${summary}`);
    if (!findings.length && REPORT) await tg.send(`✅ Epoch reconciliation OK\n${summary}${history.length ? `\n(${history.length} historical finding(s) logged from before this record)` : ""}`);
  }

  out("findings", String(findings.length));
  if (findings.length) {
    console.error(`\n${findings.length} finding(s): ${findings.map((f) => f.kind).join(", ")}`);
    process.exit(1);
  }
  console.log("\nepoch reconciliation OK");
}

if (!SELF_TEST && require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(2); });
