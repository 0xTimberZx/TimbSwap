// settler-liveness.js — is the prize game where its clock says it should be?
//
// The settler is the one keeper whose absence stops the game: while a segment
// sits past its window, nudges revert and the meter reads frozen. The settler's
// own self-chain covers scheduling gaps, but only after a run that succeeded,
// and the fleet heartbeat sees a run that happened, not what it did. This
// witness asks the chain instead: it reads TimbPrize's current segment and its
// start time, and if the segment is past its grid mark by more than a few
// minutes it says so, and says why, from the VRF module's state for that
// segment. It holds no key and never calls settleSegment or rearmSegment: a
// witness alerts, a writer acts (dev-docs/KEEPER_FLEET.md rule 1).
//
// Findings (all from chain state, none from the settler's logs or state):
//   stuck    the current segment is more than SETTLER_OVERDUE_MIN past its 60:00
//            grid mark. `cause` says what the next settle needs:
//              unarmed       no VRF draw requested — nothing has called
//                            settleSegment since the window closed
//              awaiting-vrf  armed, callback not landed, re-request not yet allowed
//              vrf-stalled   armed, callback overdue, rearmSegment allowed and not
//                            yet called — the settler should have re-requested
//              lockable      the word is in and nothing has locked the segment —
//                            the settler is present but not landing the lock
//   paused   settlement is paused by the owner; the settler cannot act
//   locks    lock state disagrees with the segment counter: an earlier segment
//            unlocked, or the current or a later one locked
//   result   the previous round's winning string has an empty character: a round
//            settled with fewer than six locked segments
//   unknown  the chain could not be read
//
// A segment inside its interaction window, or past it by less than the
// threshold, is ok whatever the VRF state: arm → callback → lock takes seconds
// to a minute and is the settler's business until the threshold.
//
// State: scripts/settler-liveness-state.json — last-alerted stamp per finding
// kind, keyed to chain id + prize address and discarded on a redeploy.
//
// Env:
//   LIVENESS_RPC             optional; default = config.js public RPC (reads only)
//   TIMBPRIZE_ADDRESS        optional override; default = config.js ADDRESSES.TimbPrize
//   SETTLER_OVERDUE_MIN      minutes past the grid mark before `stuck` (default 5)
//   SETTLER_REALERT_MIN      minutes between repeat alerts per finding (default 120)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_OPS_MODE   optional alerts
//
// Flags: --self-test  --dry-run (no Telegram, no state write)  --report (summary even when healthy)

const fs   = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { addrFromConfig, rpcFromConfig } = require("./lib/config");
const { loadState, saveState } = require("./lib/state");
const { makeTelegram, shouldRealert } = require("./lib/telegram");

const SELF_TEST = process.argv.includes("--self-test");
const DRY_RUN   = process.argv.includes("--dry-run");
const REPORT    = process.argv.includes("--report");

const STATE_PATH = path.join(__dirname, "settler-liveness-state.json");

const OPTS = {
  overdueMin: Number(process.env.SETTLER_OVERDUE_MIN || 5),
  realertMin: Number(process.env.SETTLER_REALERT_MIN || 120),
};

// ─── Pure assessment (exported for --self-test) ─────────────────────────────
//
// snapshot = {
//   gameStarted, settlementPaused, round, segment, segmentStart,
//   interactionSec, segmentSec, segmentsPerRound,
//   vrf: null | { requested, ready, replaceable },
//   locked: bool[segmentsPerRound]        (index 0 = segment 1)
//   prevWinning: null | "0x…" (bytes6)    (round − 1's winning string)
// }
// nowSec is the chain clock (latest block timestamp), never the wall clock.

function assess(snap, nowSec, opts = OPTS) {
  const findings = [];
  const row = { status: "ok", detail: "", elapsedSec: null, lateSec: null, cause: null };

  if (!snap.gameStarted) {
    row.detail = "game not started";
    return { row, findings };
  }

  const elapsed = Math.max(0, nowSec - snap.segmentStart);
  const late    = elapsed - snap.segmentSec;             // seconds past the 60:00 grid mark
  row.elapsedSec = elapsed;
  row.lateSec    = late;

  const segIdx = snap.segment - 1;
  const lockedCount = snap.locked.filter(Boolean).length;
  const where = `round ${snap.round} seg ${snap.segment}/${snap.segmentsPerRound}`;

  // Lock state must agree with the segment counter: every earlier segment
  // locked, the current one and every later one not. The contract cannot
  // produce anything else by itself, which is exactly why a witness checks it.
  const wrong = [];
  snap.locked.forEach((isLocked, i) => {
    if (i < segIdx && !isLocked) wrong.push(`seg ${i + 1} unlocked`);
    if (i >= segIdx && isLocked) wrong.push(`seg ${i + 1} locked`);
  });
  if (wrong.length) findings.push({ kind: "locks", detail: `${where}: ${wrong.join(", ")}` });

  // The previous round must have settled with all six characters.
  if (snap.round > 1 && snap.prevWinning) {
    const hex = snap.prevWinning.slice(2);
    const empty = [];
    for (let i = 0; i < hex.length; i += 2) if (hex.slice(i, i + 2) === "00") empty.push(i / 2 + 1);
    if (empty.length) findings.push({ kind: "result", detail: `round ${snap.round - 1} winning string has empty char${empty.length > 1 ? "s" : ""} at seg ${empty.join(", ")}` });
  }

  if (snap.settlementPaused) findings.push({ kind: "paused", detail: `${where}: settlement is paused by the owner` });

  if (late > opts.overdueMin * 60) {
    let cause, need;
    if (!snap.vrf)                 { cause = "unarmed";      need = "no VRF module wired; nothing can settle"; }
    else if (!snap.vrf.requested)  { cause = "unarmed";      need = "no draw requested — nothing has called settleSegment"; }
    else if (snap.vrf.ready)       { cause = "lockable";     need = "VRF word is in — a settleSegment call would lock it"; }
    else if (snap.vrf.replaceable) { cause = "vrf-stalled";  need = "VRF callback overdue and rearmSegment not called"; }
    else                           { cause = "awaiting-vrf"; need = "armed, VRF callback not landed, re-request not yet allowed"; }
    row.cause = cause;
    const slipped = elapsed >= 2 * snap.segmentSec ? "; grid slipped — the next settle re-anchors to wall clock" : "";
    if (!snap.settlementPaused) {
      findings.push({ kind: "stuck", cause, detail: `${where} is ${fmtMin(late)} past its grid mark: ${need}${slipped}` });
    }
  }

  // Detail for the ok line and the report.
  if (late > 0) {
    const v = snap.vrf ? (snap.vrf.ready ? "word ready" : snap.vrf.requested ? "armed, awaiting VRF" : "unarmed") : "no VRF";
    row.detail = `${where} · ${fmtMin(late)} past grid mark · ${v} · locks ${lockedCount}/${snap.segmentsPerRound}`;
  } else if (elapsed >= snap.interactionSec) {
    row.detail = `${where} · in settlement window · locks ${lockedCount}/${snap.segmentsPerRound}`;
  } else {
    row.detail = `${where} · ${fmtMin(snap.interactionSec - elapsed)} left · locks ${lockedCount}/${snap.segmentsPerRound}`;
  }

  if (findings.length) row.status = findings[0].kind;
  return { row, findings };
}

function fmtMin(sec) {
  const s = Math.max(0, Math.round(sec));
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/**
 * Decide what to send this run. Mutates state.alerted. Returns { alerts, recoveries }.
 * One stamp per finding kind; a kind that was alerted and is now absent
 * produces one recovery.
 */
function plan(state, findings, nowSec, opts = OPTS) {
  state.alerted ??= {};
  const alerts = [], recoveries = [];
  const present = new Set(findings.map((f) => f.kind));
  for (const kind of Object.keys(state.alerted)) {
    if (!present.has(kind)) { recoveries.push(kind); delete state.alerted[kind]; }
  }
  for (const f of findings) {
    if (shouldRealert(state.alerted[f.kind], nowSec, opts.realertMin * 60)) {
      alerts.push(f);
      state.alerted[f.kind] = nowSec;
    }
  }
  return { alerts, recoveries };
}

module.exports = { assess, plan, main };

// ─── Self-test ──────────────────────────────────────────────────────────────

function selfTest() {
  const T0 = 1_800_000_000;
  const INT = 59 * 60 + 45, SEG = 60 * 60;
  const opts = { overdueMin: 5, realertMin: 120 };
  const base = (over = {}) => ({
    gameStarted: true, settlementPaused: false, round: 3, segment: 3, segmentStart: T0,
    interactionSec: INT, segmentSec: SEG, segmentsPerRound: 6,
    vrf: { requested: false, ready: false, replaceable: false },
    locked: [true, true, false, false, false, false],
    prevWinning: "0x4b3758573251",
    ...over,
  });
  const at = (snap, sec) => assess(snap, T0 + sec, opts);
  const kinds = (r) => r.findings.map((f) => f.kind);

  let pass = 0, fail = 0;
  const eq = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) pass++;
    else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  };

  eq("game not started is ok",                 kinds(at(base({ gameStarted: false }), 99_999)), []);
  eq("mid-window is ok",                       kinds(at(base(), 1200)), []);
  eq("start in the future (grid anchor) is ok", kinds(at(base(), -20)), []);
  eq("inside settlement window is ok",         kinds(at(base(), INT + 5)), []);
  eq("one minute past grid mark is ok",        kinds(at(base(), SEG + 60)), []);
  eq("exactly at threshold is ok",             kinds(at(base(), SEG + 300)), []);
  eq("past threshold unarmed is stuck",        at(base(), SEG + 301).row.cause, "unarmed");
  eq("stuck is a finding",                     kinds(at(base(), SEG + 301)), ["stuck"]);
  eq("armed awaiting is awaiting-vrf",         at(base({ vrf: { requested: true, ready: false, replaceable: false } }), SEG + 600).row.cause, "awaiting-vrf");
  eq("replaceable is vrf-stalled",             at(base({ vrf: { requested: true, ready: false, replaceable: true } }), SEG + 2000).row.cause, "vrf-stalled");
  eq("word ready and unlocked is lockable",    at(base({ vrf: { requested: true, ready: true, replaceable: false } }), SEG + 600).row.cause, "lockable");
  eq("no vrf module is unarmed",               at(base({ vrf: null }), SEG + 600).row.cause, "unarmed");
  eq("deep stall notes the grid slip",         /grid slipped/.test(at(base(), 2 * SEG + 1).findings[0].detail), true);
  eq("late under two segments does not",       /grid slipped/.test(at(base(), SEG + 600).findings[0].detail), false);
  eq("paused is a finding on its own",         kinds(at(base({ settlementPaused: true }), 1200)), ["paused"]);
  eq("paused and overdue reports paused only", kinds(at(base({ settlementPaused: true }), SEG + 600)), ["paused"]);
  eq("earlier segment unlocked is locks",      kinds(at(base({ locked: [true, false, false, false, false, false] }), 1200)), ["locks"]);
  eq("current segment locked is locks",        kinds(at(base({ locked: [true, true, true, false, false, false] }), 1200)), ["locks"]);
  eq("later segment locked is locks",          kinds(at(base({ locked: [true, true, false, false, true, false] }), 1200)), ["locks"]);
  eq("segment 1 with nothing locked is ok",    kinds(at(base({ segment: 1, locked: [false, false, false, false, false, false] }), 1200)), []);
  eq("segment 6 with five locked is ok",       kinds(at(base({ segment: 6, locked: [true, true, true, true, true, false] }), 1200)), []);
  eq("previous round complete is ok",          kinds(at(base(), 1200)), []);
  eq("previous round with an empty char is result", kinds(at(base({ prevWinning: "0x4b3758570051" }), 1200)), ["result"]);
  eq("round 1 has no previous round",          kinds(at(base({ round: 1, prevWinning: "0x000000000000" }), 1200)), []);
  eq("several findings keep their order",      kinds(at(base({ locked: [false, true, false, false, false, false], prevWinning: "0x000000000000" }), SEG + 600)), ["locks", "result", "stuck"]);
  eq("status is the first finding",            at(base(), SEG + 600).row.status, "stuck");
  eq("ok detail names the segment",            /round 3 seg 3\/6/.test(at(base(), 1200).row.detail), true);

  // Alert planning: first alert, throttle, re-alert, recovery once.
  const state = { alerted: {} };
  const stuck = at(base(), SEG + 600).findings;
  let p = plan(state, stuck, T0, opts);
  eq("first alert sent",                     p.alerts.map((f) => f.kind), ["stuck"]);
  p = plan(state, stuck, T0 + 60, opts);
  eq("repeat inside interval throttled",     p.alerts.length, 0);
  p = plan(state, stuck, T0 + 120 * 60, opts);
  eq("re-alert after interval",              p.alerts.map((f) => f.kind), ["stuck"]);
  p = plan(state, [], T0 + 130 * 60, opts);
  eq("recovery sent once",                   p.recoveries, ["stuck"]);
  p = plan(state, [], T0 + 131 * 60, opts);
  eq("no second recovery",                   p.recoveries.length, 0);
  p = plan(state, at(base({ settlementPaused: true }), SEG + 600).findings, T0 + 140 * 60, opts);
  eq("a different kind alerts independently", p.alerts.map((f) => f.kind), ["paused"]);

  console.log(`self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (SELF_TEST) selfTest();

// ─── Live run ───────────────────────────────────────────────────────────────

const PRIZE_ABI = [
  "function gameStarted() view returns (bool)",
  "function settlementPaused() view returns (bool)",
  "function currentRound() view returns (uint256)",
  "function currentSegment() view returns (uint256)",
  "function segmentStartTime() view returns (uint256)",
  "function INTERACTION_WINDOW() view returns (uint256)",
  "function SEGMENT_DURATION() view returns (uint256)",
  "function SEGMENTS_PER_ROUND() view returns (uint256)",
  "function entropy() view returns (address)",
  "function saltFor(uint256 round, uint256 segment) pure returns (bytes32)",
  "function getRoundState() view returns (uint256 round, uint256 segment, uint256 segmentStart, uint256 counter, bytes6 currentWindow, uint256 pot, uint256 unclaimedPool, bool inSettlement, uint256[6] digitCounters, bool[6] digitLocked)",
  "function getRoundResult(uint256 round) view returns (bytes6 winningString, uint256 potAmount, address[] winners, uint256 perWinner, uint256 remainder)",
];
const ENTROPY_ABI = [
  "function isRequested(bytes32 salt) view returns (bool)",
  "function isReady(bytes32 salt) view returns (bool)",
  "function replaceable(bytes32 salt) view returns (bool)",
];

/** One consistent read of the prize contract at the latest block. */
async function snapshot(provider, prizeAddr) {
  const prize = new ethers.Contract(prizeAddr, PRIZE_ABI, provider);
  const block = await provider.getBlock("latest");
  const tag = { blockTag: block.number };

  const gameStarted = await prize.gameStarted(tag);
  const snap = { gameStarted, blockNumber: block.number, nowSec: block.timestamp };
  if (!gameStarted) return snap;

  const [paused, round, segment, segmentStart, interactionSec, segmentSec, perRound, entropyAddr, rs] = await Promise.all([
    prize.settlementPaused(tag).catch(() => false),   // older deployments have no pause
    prize.currentRound(tag), prize.currentSegment(tag), prize.segmentStartTime(tag),
    prize.INTERACTION_WINDOW(tag), prize.SEGMENT_DURATION(tag), prize.SEGMENTS_PER_ROUND(tag),
    prize.entropy(tag).catch(() => ethers.ZeroAddress),
    prize.getRoundState(tag),
  ]);
  Object.assign(snap, {
    settlementPaused: paused, round: Number(round), segment: Number(segment), segmentStart: Number(segmentStart),
    interactionSec: Number(interactionSec), segmentSec: Number(segmentSec), segmentsPerRound: Number(perRound),
    locked: Array.from(rs.digitLocked, Boolean), vrf: null, prevWinning: null,
  });

  if (entropyAddr !== ethers.ZeroAddress) {
    const entropy = new ethers.Contract(entropyAddr, ENTROPY_ABI, provider);
    const salt = await prize.saltFor(round, segment);
    const [requested, ready, replaceable] = await Promise.all([
      entropy.isRequested(salt, tag), entropy.isReady(salt, tag), entropy.replaceable(salt, tag),
    ]);
    snap.vrf = { requested, ready, replaceable };
  }
  if (snap.round > 1) {
    const res = await prize.getRoundResult(snap.round - 1, tag);
    snap.prevWinning = String(res.winningString ?? res[0]);
  }
  return snap;
}

async function main() {
  const rpc = process.env.LIVENESS_RPC || rpcFromConfig();
  const provider  = new ethers.JsonRpcProvider(rpc);
  const chainId   = Number((await provider.getNetwork()).chainId);
  const prizeAddr = process.env.TIMBPRIZE_ADDRESS ? ethers.getAddress(process.env.TIMBPRIZE_ADDRESS) : addrFromConfig("TimbPrize");

  const tg = makeTelegram({
    token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID,
    mode: process.env.TELEGRAM_OPS_MODE, tag: "settler-liveness",
  });
  const out = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };

  let snap, findings, row;
  try {
    snap = await snapshot(provider, prizeAddr);
    ({ row, findings } = assess(snap, snap.nowSec));
  } catch (e) {
    const inner = e?.error?.message || e?.info?.error?.message;
    row = { status: "unknown", detail: `chain read failed: ${e.shortMessage || e.message}${inner ? ` (${inner})` : ""}` };
    findings = [{ kind: "unknown", detail: row.detail }];
    snap = { nowSec: Math.floor(Date.now() / 1000) };
  }
  // A completed assessment, findings or not, is what the self-chain is gated
  // on; the workflow marks the run red from `findings` after the linger.
  out("assessed", "true");

  console.log(`settler liveness @ block ${snap.blockNumber ?? "?"}  prize ${prizeAddr}  chain ${chainId}  overdue>${OPTS.overdueMin}m`);
  console.log(`  ${findings.length ? "✗" : "✓"} ${row.status.padEnd(8)} ${row.detail}`);
  for (const f of findings) console.log(`    [${f.kind}] ${f.detail}`);

  const state = loadState(STATE_PATH, () => ({ chainId, prize: prizeAddr, alerted: {} }), {
    matches: (s) => s.chainId === chainId && String(s.prize).toLowerCase() === prizeAddr.toLowerCase(),
    label: "liveness state",
  });
  const { alerts, recoveries } = plan(state, findings, snap.nowSec);

  if (DRY_RUN) {
    console.log(`\n(dry run) would alert: ${alerts.map((f) => f.kind).join(", ") || "none"}; recoveries: ${recoveries.join(", ") || "none"}`);
  } else {
    saveState(STATE_PATH, state);
    for (const f of alerts) {
      const glyph = f.kind === "paused" ? "⚠️" : "🚨";
      await tg.notify(`${glyph} Settler liveness [${f.kind}]\n${f.detail}`);
    }
    if (recoveries.length) await tg.notify(`✅ Settler liveness recovered: ${recoveries.join(", ")}\n${row.detail}`);
    if (!findings.length && REPORT) await tg.send(`✅ Settler liveness OK\n${row.detail}`);
  }

  out("findings", String(findings.length));
  if (findings.length) {
    console.error(`\n${findings.length} finding(s): ${findings.map((f) => f.kind).join(", ")}`);
    process.exit(1);
  }
  console.log("\nsettler liveness OK");
}

if (!SELF_TEST && require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(2); });
