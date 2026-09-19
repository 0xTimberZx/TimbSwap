// dead-man.js — the ping an outside service expects, sent only while the
// heartbeat is alive.
//
// The fleet heartbeat watches every keeper but has two things it cannot see:
// its own absence, and GitHub Actions stopping altogether. Both look, from
// inside Actions, like nothing. This job closes both from outside. It reads
// the Actions API for the heartbeat's own runs, judges them with the
// heartbeat's own assessment, and if the heartbeat is alive it pings an
// external dead-man's-switch URL (a Healthchecks.io check, a Cronitor or
// Uptime Kuma push URL, anything that alerts when an expected call stops).
// The outside service then alerts when:
//   • Actions has stopped: this job does not run, no ping arrives;
//   • this job's chain has died: same, and the heartbeat also reports it stale;
//   • the heartbeat has died: this job runs but withholds the ping (and hits
//     the optional fail URL), so the silence is deliberate.
// The heartbeat watches this job in turn. Neither dispatches the other, and
// neither needs the other to have run (KEEPER_FLEET.md rule 1).
//
// Findings:
//   heartbeat  the heartbeat is stale, failing, runaway or unreadable by its
//              own rules; the ping is withheld
//   ping       the external service could not be reached; the switch may fire
//              for the wrong reason
//   unset      no DEADMAN_PING_URL: the switch is not wired, reported once per
//              re-alert interval so an unwired switch is not mistaken for a
//              working one
//
// State: scripts/dead-man-state.json — last-alerted stamps per finding kind.
//
// Env:
//   GITHUB_TOKEN, GITHUB_REPOSITORY   Actions-provided
//   DEADMAN_PING_URL       the URL to call while the heartbeat is alive (secret)
//   DEADMAN_FAIL_URL       optional URL to call when it is not (Healthchecks: ping URL + /fail)
//   DEADMAN_SLACK, DEADMAN_GRACE_MIN, DEADMAN_FAIL_STREAK, DEADMAN_RUNAWAY_COUNT
//                          the heartbeat's thresholds, applied to the heartbeat itself
//                          (defaults: slack 3 of a 30-min cadence, grace 30, streak 3, runaway 4)
//   DEADMAN_REALERT_MIN    minutes between repeat alerts per finding (default 360)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_OPS_MODE   optional alerts
//
// Flags: --self-test  --dry-run (no ping, no Telegram, no state write)  --report

const fs   = require("fs");
const path = require("path");
const { assessOne, fetchRuns } = require("./fleet-heartbeat");
const { loadState, saveState } = require("./lib/state");
const { makeTelegram, shouldRealert } = require("./lib/telegram");

const SELF_TEST = process.argv.includes("--self-test");
const DRY_RUN   = process.argv.includes("--dry-run");
const REPORT    = process.argv.includes("--report");

const STATE_PATH = path.join(__dirname, "dead-man-state.json");
const HEARTBEAT  = { file: "fleet-heartbeat.yml", cadenceMin: 30, label: "fleet heartbeat" };

const OPTS = {
  slack:        Number(process.env.DEADMAN_SLACK || 3),
  graceMin:     Number(process.env.DEADMAN_GRACE_MIN || 30),
  failStreak:   Number(process.env.DEADMAN_FAIL_STREAK || 3),
  runawayCount: Number(process.env.DEADMAN_RUNAWAY_COUNT || 4),
  realertMin:   Number(process.env.DEADMAN_REALERT_MIN || 360),
};

// ─── Pure decision (exported for --self-test) ───────────────────────────────

/**
 * Given the heartbeat's assessment row (or null when unreadable) and whether a
 * ping URL is configured, decide what to do. Returns { ping, fail, findings }.
 * A missing URL is a finding of its own, and nothing is pinged; an unreadable
 * API is treated as a dead heartbeat, because the ping must never be sent on
 * a guess.
 */
function decide(row, hasUrl) {
  const findings = [];
  const alive = Boolean(row && row.status === "ok");
  if (!alive) findings.push({ kind: "heartbeat", detail: row ? `heartbeat ${row.status}: ${row.detail}` : "heartbeat runs could not be read" });
  if (!hasUrl) findings.push({ kind: "unset", detail: "DEADMAN_PING_URL is not set — the switch is not wired" });
  return { ping: alive && hasUrl, fail: !alive && hasUrl, findings };
}

const STANDING = new Set(["heartbeat", "ping", "unset"]);

function plan(state, findings, nowSec, opts = OPTS) {
  state.alerted ??= {};
  const alerts = [], recoveries = [];
  const present = new Set(findings.map((f) => f.kind));
  for (const kind of Object.keys(state.alerted)) if (!present.has(kind)) { recoveries.push(kind); delete state.alerted[kind]; }
  for (const f of findings) {
    if (shouldRealert(state.alerted[f.kind], nowSec, opts.realertMin * 60)) { alerts.push(f); state.alerted[f.kind] = nowSec; }
  }
  return { alerts, recoveries };
}

module.exports = { HEARTBEAT, decide, plan, main };

// ─── Self-test ──────────────────────────────────────────────────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) pass++;
    else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  };
  const ok = { status: "ok", detail: "last success 3 min ago" };
  const stale = { status: "stale", detail: "last success 95 min ago (allowed 90)" };
  const k = (d) => d.findings.map((f) => f.kind);

  eq("alive with url pings",            [decide(ok, true).ping, decide(ok, true).fail, k(decide(ok, true))], [true, false, []]);
  eq("stale withholds and fails",       [decide(stale, true).ping, decide(stale, true).fail, k(decide(stale, true))], [false, true, ["heartbeat"]]);
  eq("failing is not alive",            decide({ status: "failing", detail: "" }, true).ping, false);
  eq("runaway is not alive",            decide({ status: "runaway", detail: "" }, true).ping, false);
  eq("unreadable is not alive",         [decide(null, true).ping, k(decide(null, true))], [false, ["heartbeat"]]);
  eq("no url never pings",              [decide(ok, false).ping, decide(ok, false).fail, k(decide(ok, false))], [false, false, ["unset"]]);
  eq("stale and no url: both findings", k(decide(stale, false)), ["heartbeat", "unset"]);

  // The heartbeat's own assessment applied to the heartbeat: 30-min cadence, slack 3.
  const now = Date.parse("2026-09-18T12:00:00Z");
  const iso = (m) => new Date(now - m * 60_000).toISOString();
  const run = (m, c = "success") => ({ status: "completed", conclusion: c, run_started_at: iso(m) });
  const o = { slack: 3, graceMin: 30, failStreak: 3, runawayCount: 4 };
  eq("heartbeat 60 min old is alive",   assessOne(HEARTBEAT, [run(60)], now, o).status, "ok");
  eq("heartbeat 91 min old is stale",   assessOne(HEARTBEAT, [run(91)], now, o).status, "stale");
  eq("heartbeat lingering is alive",    assessOne(HEARTBEAT, [{ status: "in_progress", run_started_at: iso(25) }, run(60)], now, o).status, "ok");
  eq("heartbeat with findings still counts", assessOne(HEARTBEAT, [run(5, "failure"), run(35, "failure"), run(65)], now, o).status, "ok");
  eq("heartbeat failing streak is not alive", assessOne(HEARTBEAT, [run(5, "failure"), run(35, "failure"), run(65, "failure"), run(95)], now, o).status, "failing");

  const T = 1_800_000_000, st = { alerted: {} }, opts = { realertMin: 360 };
  let p = plan(st, [{ kind: "unset" }], T, opts);
  eq("first alert",                     p.alerts.map((f) => f.kind), ["unset"]);
  p = plan(st, [{ kind: "unset" }], T + 60, opts);
  eq("throttled",                       p.alerts.length, 0);
  p = plan(st, [], T + 120, opts);
  eq("recovery once",                   p.recoveries, ["unset"]);

  console.log(`self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (SELF_TEST && require.main === module) selfTest();

// ─── Live run ───────────────────────────────────────────────────────────────

async function hit(url, label) {
  const res = await fetch(url, { method: "POST", headers: { "User-Agent": "timbswap-dead-man" }, body: label });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
  const pingUrl = process.env.DEADMAN_PING_URL || "", failUrl = process.env.DEADMAN_FAIL_URL || "";
  const tg = makeTelegram({ token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID, mode: process.env.TELEGRAM_OPS_MODE, tag: "dead-man" });
  const out = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
  const nowMs = Date.now(), nowSec = Math.floor(nowMs / 1000);

  let row = null;
  try { row = assessOne(HEARTBEAT, await fetchRuns(repo, token, HEARTBEAT.file), nowMs, OPTS); }
  catch (e) { console.error(`heartbeat runs unreadable: ${e.message}`); }
  const d = decide(row, Boolean(pingUrl));
  const findings = [...d.findings];
  out("assessed", "true");

  console.log(`dead-man @ ${new Date(nowMs).toISOString()}  heartbeat ${row ? `${row.status} — ${row.detail}` : "unreadable"}  switch ${pingUrl ? "wired" : "NOT wired"}`);

  if (DRY_RUN) {
    console.log(`(dry run) would ${d.ping ? "ping" : d.fail ? "signal failure" : "do nothing"}`);
  } else if (d.ping) {
    try { await hit(pingUrl, `heartbeat ok: ${row.detail}`); console.log("  pinged the switch"); }
    catch (e) { findings.push({ kind: "ping", detail: `switch unreachable: ${e.message}` }); }
  } else if (d.fail && failUrl) {
    try { await hit(failUrl, `heartbeat ${row ? row.status : "unreadable"}`); console.log("  signalled failure to the switch"); }
    catch (e) { console.error(`  fail URL unreachable: ${e.message}`); }
  } else if (d.fail) {
    console.log("  ping withheld — the switch will fire on its own timer");
  }

  for (const f of findings) console.log(`    [${f.kind}] ${f.detail}`);

  const state = loadState(STATE_PATH, () => ({ alerted: {} }), { label: "dead-man state" });
  const { alerts, recoveries } = plan(state, findings, nowSec);
  if (DRY_RUN) {
    console.log(`(dry run) would alert: ${alerts.map((f) => f.kind).join(", ") || "none"}; recoveries: ${recoveries.join(", ") || "none"}`);
  } else {
    saveState(STATE_PATH, state);
    for (const f of alerts) await tg.notify(`${f.kind === "unset" ? "⚠️" : "🚨"} Dead-man switch [${f.kind}]\n${f.detail}`);
    if (recoveries.length) await tg.notify(`✅ Dead-man switch recovered: ${recoveries.join(", ")}`);
    if (!findings.length && REPORT) await tg.send(`✅ Dead-man switch OK: heartbeat ${row.detail}; pinged`);
  }

  out("findings", String(findings.length));
  if (findings.length) { console.error(`\n${findings.length} finding(s): ${findings.map((f) => f.kind).join(", ")}`); process.exit(1); }
  console.log("\ndead-man OK");
}

if (!SELF_TEST && require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(2); });
