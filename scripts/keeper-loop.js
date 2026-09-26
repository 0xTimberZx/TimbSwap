#!/usr/bin/env node
// keeper-loop.js — long-running supervisor for one keeper, for hosts that give
// us a real process (Railway, Render, Fly, a VPS) instead of GitHub Actions.
//
// The keepers were written as single runs: do the work, linger to the next
// boundary, exit, and let the workflow dispatch the next run. This wrapper
// replaces the "dispatch the next run" half. It runs the chosen script, waits
// the keeper's pause, and runs it again, forever. Nothing inside the keepers
// changes — the same scripts, the same env, the same behaviour.
//
//   KEEPER                which keeper to run (see KEEPERS below). Required.
//   KEEPER_PAUSE_MINUTES  override the pause between successful runs.
//   KEEPER_ARGS           extra args for the script, space-separated (e.g. --dry-run).
//
// Exit handling: a clean exit pauses the configured minutes then reruns. A
// crash (non-zero exit) backs off 1, 2, 4 … up to 15 minutes, then resets on
// the next clean run — the keepers already tolerate being re-run early, they
// just find nothing to do. SIGTERM (a redeploy) forwards to the child so an
// in-flight settle finishes its tx before the process goes.
//
// One service per keeper. Do not run two settlers.

"use strict";

const { spawn } = require("child_process");
const path = require("path");

// pause = minutes between runs after a clean exit. The lingering keepers
// (settler, faucet, notifier, reminder) pace themselves and only exit at a
// boundary, so their pause is short. The others are one-shot and need the
// workflow's old cadence reproduced here.
const KEEPERS = {
  "settler":          { script: "settler.js",          pause: 1  },
  "faucet":           { script: "faucet-worker.js",    pause: 1  },
  "match-notifier":   { script: "match-notifier.js",   pause: 1  },
  "reclaim-reminder": { script: "reclaim-reminder.js", pause: 1  },
  "points-scorer":    { script: "points-scorer.js",    pause: 60 },
  // The one witness that still has something to watch here: it reads the
  // prize contract's clock, not GitHub, and alerts Telegram when a segment
  // sits past its grid mark. It exits 1 when it has findings — that is a
  // report, not a crash, so exit 1 is a clean run for backoff purposes. Its
  // alert-throttle state lives in the container and survives between runs
  // until a redeploy, which at worst repeats one alert.
  "settler-liveness": { script: "settler-liveness.js", pause: 15, okExit: [0, 1] },
  // State-file keepers. They persist to scripts/*-state.json, which the
  // workflow committed back to git. On an ephemeral host that file is lost on
  // redeploy, so mount a volume before enabling these (see scripts/RAILWAY.md).
  "epoch":            { script: "epoch.js",            pause: 120 },
  "bounty-post":      { script: "bounty-poster.js",    pause: 60  },
};

const name = process.env.KEEPER;
const spec = KEEPERS[name];
if (!spec) {
  console.error(`[loop] KEEPER must be one of: ${Object.keys(KEEPERS).join(", ")} (got ${JSON.stringify(name)})`);
  process.exit(2);
}

const pauseMin = Number(process.env.KEEPER_PAUSE_MINUTES || spec.pause);
// Exit codes that count as a clean run (default: 0 only). A witness that
// reports findings via exit 1 must not be treated as crashing, or its
// re-check cadence turns into the crash backoff.
const okExit = new Set(spec.okExit || [0]);
const extraArgs = (process.env.KEEPER_ARGS || "").split(/\s+/).filter(Boolean);
const script = path.join(__dirname, spec.script);

let child = null;
let stopping = false;
let crashes = 0;

const ts = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function runOnce() {
  return new Promise(resolve => {
    console.log(`[loop] ${ts()} starting ${spec.script} ${extraArgs.join(" ")}`.trim());
    child = spawn(process.execPath, [script, ...extraArgs], { stdio: "inherit", env: process.env });
    child.on("exit", (code, signal) => {
      child = null;
      console.log(`[loop] ${ts()} ${spec.script} exited code=${code} signal=${signal || "-"}`);
      resolve(code === 0 ? 0 : (code ?? 1));
    });
  });
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    stopping = true;
    console.log(`[loop] ${ts()} ${sig} received; forwarding to child and stopping after it exits`);
    if (child) child.kill(sig);
    else process.exit(0);
  });
}

(async () => {
  console.log(`[loop] keeper=${name} pause=${pauseMin}m`);
  while (!stopping) {
    const code = await runOnce();
    if (stopping) break;
    let waitMin;
    if (okExit.has(code)) {
      crashes = 0;
      waitMin = pauseMin;
    } else {
      crashes += 1;
      waitMin = Math.min(15, 2 ** (crashes - 1));
      console.log(`[loop] crash #${crashes}; backing off ${waitMin}m`);
    }
    await sleep(waitMin * 60 * 1000);
  }
  console.log(`[loop] ${ts()} stopped`);
  process.exit(0);
})();
