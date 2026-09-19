// fleet-heartbeat.js — is every scheduled keeper still running?
//
// The most common way this fleet fails is not a bug: GitHub throttles cron
// unpredictably (a 2.4-hour hole was observed live), a run hits its timeout, or
// a keeper fails fast on every tick. Each keeper can report its own errors but
// cannot report its own absence. This witness asks the Actions API, for every
// scheduled workflow, when it last ran successfully or is running now, and
// alerts when that is older than the workflow's cadence allows.
//
// Witness rules (dev-docs/KEEPER_FLEET.md): it reads, it alerts, it never
// re-dispatches or touches a keeper's state. It depends on nothing but the
// repo's own Actions token, so it cannot be taken down by the thing it watches.
//
// Findings:
//   stale     no run in progress and the last successful run started more than
//             max(cadence × slack, grace) minutes ago (or none at all)
//   failing   the most recent completed runs are all failures (cancelled and
//             skipped runs are ignored: the concurrency groups cancel redundant
//             cron backstops by design)
//   runaway   more than FLEET_RUNAWAY_COUNT completed runs started inside one
//             cadence window. A keeper that is far too present: a self-chain
//             gone tight (a zero-minute linger once produced a run every fifteen
//             seconds), a cron misfire, or a dispatch loop. Cancelled and
//             skipped runs do not count, so queued backstops that the
//             concurrency group drops are not mistaken for a loop.
//   unknown   the API could not be read for that workflow
//
// State: scripts/fleet-heartbeat-state.json — one last-alerted stamp per
// workflow, so a keeper that stays down produces one message per re-alert
// interval, and one "recovered" message when it comes back.
//
// Env:
//   GITHUB_TOKEN           Actions-provided token with actions:read
//   GITHUB_REPOSITORY      owner/repo (Actions-provided)
//   FLEET_SLACK            cadences a keeper may miss before it is stale (default 3)
//   FLEET_GRACE_MIN        minimum stale threshold in minutes (default 30)
//   FLEET_FAIL_STREAK      consecutive failures that count as failing (default 3)
//   FLEET_RUNAWAY_COUNT    completed runs inside one cadence that count as runaway (default 4)
//   FLEET_REALERT_MIN      minutes between repeat alerts for one workflow (default 360)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_OPS_MODE   optional alerts
//
// Flags: --self-test  --dry-run (no Telegram, no state write)  --report (summary even when healthy)

const fs   = require("fs");
const path = require("path");
const { loadState, saveState } = require("./lib/state");
const { makeTelegram, shouldRealert } = require("./lib/telegram");

const SELF_TEST = process.argv.includes("--self-test");
const DRY_RUN   = process.argv.includes("--dry-run");
const REPORT    = process.argv.includes("--report");

const STATE_PATH = path.join(__dirname, "fleet-heartbeat-state.json");

// The scheduled fleet and each job's cron cadence. Manual-only workflows
// (admin grants, deploys, CI) are not here: their absence is normal.
// `slack` overrides the global miss allowance for slow jobs so a six-hour
// monitor is not eighteen hours late before anyone hears.
const FLEET = [
  { file: "settler.yml",           cadenceMin: 10,  label: "settler" },
  { file: "faucet.yml",            cadenceMin: 10,  label: "faucet keeper" },
  { file: "match-notifier.yml",    cadenceMin: 15,  label: "match notifier" },
  { file: "points-scorer.yml",     cadenceMin: 60,  label: "points scorer" },
  { file: "reclaim-reminder.yml",  cadenceMin: 60,  label: "reclaim reminder" },
  { file: "epoch.yml",             cadenceMin: 120, label: "epoch keeper" },
  { file: "faucet-invariants.yml", cadenceMin: 360, label: "faucet invariants", slack: 2 },
  { file: "settler-liveness.yml",  cadenceMin: 15,  label: "settler liveness" },
  { file: "epoch-recon.yml",       cadenceMin: 120, label: "epoch reconciliation" },
  { file: "faucet-recon.yml",      cadenceMin: 60,  label: "faucet reconciliation" },
  { file: "points-recon.yml",      cadenceMin: 60,  label: "points reconciliation" },
  { file: "dead-man.yml",          cadenceMin: 30,  label: "dead-man switch" },
];

const OPTS = {
  slack:      Number(process.env.FLEET_SLACK || 3),
  graceMin:   Number(process.env.FLEET_GRACE_MIN || 30),
  failStreak: Number(process.env.FLEET_FAIL_STREAK || 3),
  runawayCount: Number(process.env.FLEET_RUNAWAY_COUNT || 4),
  realertMin: Number(process.env.FLEET_REALERT_MIN || 360),
};

// ─── Pure assessment (exported for --self-test) ─────────────────────────────
//
// runsByFile: { [file]: [ { status, conclusion, run_started_at, created_at }, … ]
//              newest first, or null when the API read failed }

const IGNORED = new Set(["cancelled", "skipped"]);
const startMs = (r) => Date.parse(r.run_started_at || r.created_at);

function assessOne(entry, runs, nowMs, opts) {
  const threshold = Math.max(entry.cadenceMin * (entry.slack ?? opts.slack), opts.graceMin);
  const row = { file: entry.file, label: entry.label, thresholdMin: threshold, status: "ok", ageMin: null, streak: 0, detail: "" };

  if (!runs) { row.status = "unknown"; row.detail = "API read failed"; return row; }

  const live = runs.find((r) => r.status === "in_progress" || r.status === "queued");
  const completed = runs.filter((r) => r.status === "completed" && !IGNORED.has(r.conclusion));
  const lastOk = completed.find((r) => r.conclusion === "success");

  let streak = 0;
  for (const r of completed) { if (r.conclusion === "success") break; streak++; }
  row.streak = streak;

  if (live) {
    row.ageMin = Math.round((nowMs - startMs(live)) / 60_000);
    row.detail = `running for ${row.ageMin} min`;
  } else if (!lastOk) {
    row.status = "stale";
    row.detail = `no successful run among the last ${runs.length}`;
  } else {
    row.ageMin = Math.round((nowMs - startMs(lastOk)) / 60_000);
    if (row.ageMin > threshold) {
      row.status = "stale";
      row.detail = `last success ${row.ageMin} min ago (allowed ${threshold})`;
    } else {
      row.detail = `last success ${row.ageMin} min ago`;
    }
  }

  // A failing streak outranks staleness: the keeper is running and dying, which
  // is a different fix from a keeper that is not being scheduled.
  if (streak >= opts.failStreak && !live) {
    row.status = "failing";
    row.detail = `${streak} consecutive failures; ${row.detail}`;
  }

  // Runaway outranks everything: too many completed runs inside one cadence
  // window means the keeper is being scheduled far too often, and that is true
  // whether the runs are green or not. The API page is fifteen runs, so a
  // tight loop saturates the window within minutes.
  const windowMs = entry.cadenceMin * 60_000;
  const recent = completed.filter((r) => nowMs - startMs(r) <= windowMs).length;
  row.recent = recent;
  if (recent >= opts.runawayCount) {
    row.status = "runaway";
    row.detail = `${recent} completed runs in the last ${entry.cadenceMin} min (expected about 1); ${row.detail}`;
  }
  return row;
}

function assess(fleet, runsByFile, nowMs, opts = OPTS) {
  const rows = fleet.map((e) => assessOne(e, runsByFile[e.file] ?? null, nowMs, opts));
  return { rows, findings: rows.filter((r) => r.status !== "ok") };
}

/**
 * Decide what to send this run. Mutates state.alerted. Returns { alerts, recoveries }.
 * A finding is re-sent only after realertMin; a workflow that was alerted and is
 * now ok produces one recovery message.
 */
function plan(state, rows, nowSec, opts = OPTS) {
  state.alerted ??= {};
  const alerts = [], recoveries = [];
  for (const r of rows) {
    const last = state.alerted[r.file];
    if (r.status === "ok") {
      if (last) { recoveries.push(r); delete state.alerted[r.file]; }
      continue;
    }
    if (shouldRealert(last, nowSec, opts.realertMin * 60)) {
      alerts.push(r);
      state.alerted[r.file] = nowSec;
    }
  }
  return { alerts, recoveries };
}

module.exports = { FLEET, OPTS, assess, assessOne, plan, fetchRuns, main };

// ─── Self-test ──────────────────────────────────────────────────────────────

function selfTest() {
  const now = Date.parse("2026-09-18T12:00:00Z");
  const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString();
  const ok  = (minAgo) => ({ status: "completed", conclusion: "success", run_started_at: iso(minAgo) });
  const bad = (minAgo) => ({ status: "completed", conclusion: "failure", run_started_at: iso(minAgo) });
  const can = (minAgo) => ({ status: "completed", conclusion: "cancelled", run_started_at: iso(minAgo) });
  const run = (minAgo) => ({ status: "in_progress", run_started_at: iso(minAgo) });
  const opts = { slack: 3, graceMin: 30, failStreak: 3, runawayCount: 4, realertMin: 360 };
  const e10  = { file: "a.yml", cadenceMin: 10 };
  const e360 = { file: "b.yml", cadenceMin: 360, slack: 2 };

  let pass = 0, fail = 0;
  const eq = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) pass++;
    else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  };
  const st = (entry, runs) => { const r = assessOne(entry, runs, now, opts); return [r.status, r.streak]; };

  eq("fresh success is ok",                 st(e10, [ok(5)]),                       ["ok", 0]);
  eq("within grace is ok",                  st(e10, [ok(29)]),                      ["ok", 0]);
  eq("past grace is stale",                 st(e10, [ok(31)]),                      ["stale", 0]);
  eq("threshold is max(cadence*slack, grace)", assessOne(e10, [ok(0)], now, opts).thresholdMin, 30);
  eq("per-entry slack applies",             assessOne(e360, [ok(0)], now, opts).thresholdMin, 720);
  eq("slow job inside its window",          st(e360, [ok(700)]),                    ["ok", 0]);
  eq("slow job past its window",            st(e360, [ok(721)]),                    ["stale", 0]);
  eq("in-progress run is alive at any age", st(e10, [run(300), ok(400)]),           ["ok", 0]);
  eq("queued counts as alive",              st(e10, [{ status: "queued", created_at: iso(1) }, ok(400)]), ["ok", 0]);
  eq("cancelled backstops are ignored",     st(e10, [can(1), can(2), ok(20)]),      ["ok", 0]);
  eq("only cancelled runs is stale",        st(e10, [can(1), can(2)]),              ["stale", 0]);
  eq("no runs at all is stale",             st(e10, []),                            ["stale", 0]);
  eq("null runs is unknown",                st(e10, null),                          ["unknown", 0]);
  eq("two failures then success is ok",     st(e10, [bad(2), bad(12), ok(20)]),     ["ok", 2]);
  eq("three failures is failing",           st(e10, [bad(2), bad(12), bad(22), ok(40)]), ["failing", 3]);
  eq("failing outranks stale",              st(e10, [bad(40), bad(50), bad(60), ok(200)]), ["failing", 3]);
  eq("cancelled does not break a streak",   st(e10, [bad(2), can(5), bad(12), bad(22), ok(40)]), ["failing", 3]);
  eq("running after failures is ok",        st(e10, [run(1), bad(12), bad(22), bad(32)]), ["ok", 3]);

  // Runaway: too many completions inside one cadence window.
  eq("three completions in a cadence is ok",   st(e10, [ok(1), ok(4), ok(7)]),                    ["ok", 0]);
  eq("four completions in a cadence is runaway", st(e10, [ok(1), ok(3), ok(5), ok(7)]),          ["runaway", 0]);
  eq("cancelled backstops never count",        st(e10, [can(1), can(2), can(3), can(4), ok(5)]), ["ok", 0]);
  eq("old completions are outside the window", st(e10, [ok(1), ok(12), ok(24), ok(36)]),         ["ok", 0]);
  eq("runaway outranks a green streak",        assessOne(e10, [ok(1), ok(2), ok(3), ok(4), ok(5)], now, opts).recent, 5);
  eq("failing loop is still runaway",          st(e10, [bad(1), bad(2), bad(3), bad(4), ok(20)]), ["runaway", 4]);
  eq("running run does not count as completed", st(e10, [run(0), ok(2), ok(4), ok(6)]),          ["ok", 0]);
  eq("slow job with a normal history is ok",   st(e360, [ok(10), ok(370), ok(730)]),              ["ok", 0]);

  // Fleet-level: one stale, one ok.
  const fleet = [e10, { file: "c.yml", cadenceMin: 10 }];
  const a = assess(fleet, { "a.yml": [ok(100)], "c.yml": [ok(1)] }, now, opts);
  eq("assess collects findings", a.findings.map((f) => f.file), ["a.yml"]);

  // Alert planning: first alert, throttle, re-alert after interval, recovery once.
  const nowSec = Math.floor(now / 1000);
  const state = { alerted: {} };
  const stale = a.rows;
  let p = plan(state, stale, nowSec, opts);
  eq("first alert sent",                    p.alerts.map((r) => r.file), ["a.yml"]);
  p = plan(state, stale, nowSec + 60, opts);
  eq("repeat inside interval throttled",    p.alerts.length, 0);
  p = plan(state, stale, nowSec + 360 * 60 + 1, opts);
  eq("re-alert after interval",             p.alerts.map((r) => r.file), ["a.yml"]);
  const healthy = assess(fleet, { "a.yml": [ok(1)], "c.yml": [ok(1)] }, now, opts).rows;
  p = plan(state, healthy, nowSec + 400 * 60, opts);
  eq("recovery sent once",                  p.recoveries.map((r) => r.file), ["a.yml"]);
  p = plan(state, healthy, nowSec + 401 * 60, opts);
  eq("no second recovery",                  p.recoveries.length, 0);

  console.log(`self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (SELF_TEST && require.main === module) selfTest();

// ─── Live run ───────────────────────────────────────────────────────────────

async function fetchRuns(repo, token, file, perPage = 15) {
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(file)}/runs?per_page=${perPage}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "timbswap-fleet-heartbeat",
    },
  });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return (body.workflow_runs || []).map((r) => ({
    status: r.status, conclusion: r.conclusion, run_started_at: r.run_started_at, created_at: r.created_at, event: r.event,
  }));
}

async function main() {
  const repo  = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");

  const tg = makeTelegram({
    token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID,
    mode: process.env.TELEGRAM_OPS_MODE, tag: "heartbeat",
  });

  const runsByFile = {};
  for (const e of FLEET) {
    try { runsByFile[e.file] = await fetchRuns(repo, token, e.file); }
    catch (err) { console.error(`read failed: ${err.message}`); runsByFile[e.file] = null; }
  }

  const nowMs = Date.now();
  const { rows, findings } = assess(FLEET, runsByFile, nowMs);
  // Step outputs for the workflow: `assessed` gates the self-chain (a crash
  // before this point must not re-dispatch), `findings` marks the run red
  // after the linger and the dispatch have happened.
  const out = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
  out("assessed", "true");

  console.log(`fleet heartbeat @ ${new Date(nowMs).toISOString()}  slack=${OPTS.slack} grace=${OPTS.graceMin}m`);
  for (const r of rows) {
    const mark = r.status === "ok" ? "✓" : "✗";
    console.log(`  ${mark} ${r.label.padEnd(18)} ${r.status.padEnd(8)} ${r.detail}`);
  }

  const state = loadState(STATE_PATH, () => ({ alerted: {} }), { label: "heartbeat state" });
  const { alerts, recoveries } = plan(state, rows, Math.floor(nowMs / 1000));

  if (DRY_RUN) {
    console.log(`\n(dry run) would alert: ${alerts.map((r) => r.file).join(", ") || "none"}; recoveries: ${recoveries.map((r) => r.file).join(", ") || "none"}`);
  } else {
    saveState(STATE_PATH, state);
    if (alerts.length) {
      await tg.notify(`🚨 Keeper fleet: ${alerts.length} problem${alerts.length > 1 ? "s" : ""}\n` +
        alerts.map((r) => `[${r.status}] ${r.label} — ${r.detail}`).join("\n"));
    }
    if (recoveries.length) {
      await tg.notify(`✅ Keeper fleet recovered: ${recoveries.map((r) => r.label).join(", ")}`);
    }
    if (!findings.length && REPORT) {
      await tg.send(`✅ Keeper fleet healthy: ${rows.length}/${rows.length} on schedule\n` +
        rows.map((r) => `${r.label}: ${r.detail}`).join("\n"));
    }
  }

  out("findings", String(findings.length));
  if (findings.length) {
    console.error(`\n${findings.length} finding(s): ${findings.map((r) => `${r.file} ${r.status}`).join(", ")}`);
    process.exit(1);
  }
  console.log("\nfleet OK");
}

// Only run the live path when executed directly, so the assessment can be
// required by a test or a replay without touching the API.
if (!SELF_TEST && require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(2); });
