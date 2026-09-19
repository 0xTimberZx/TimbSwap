// lib/state.js — a keeper's own cursor file.
//
// Keepers run on GitHub Actions with no disk between runs, so each one commits
// a small JSON state back to main: a block cursor, a last-settled round, a
// per-wallet tally, a last-alerted stamp. Rules that keep the fleet loosely
// coupled (dev-docs/KEEPER_FLEET.md):
//
//   • every job owns exactly one state file and nobody else reads it;
//   • the file carries the identity it was built against (chain id, contract
//     address) and is thrown away when that identity changes — a redeploy must
//     never be read through the previous deployment's cursor;
//   • a run that dies before its first save leaves the file untouched, so the
//     next run resumes from where the last GOOD run ended.

const fs = require("fs");

/**
 * Load `file` if it exists and `matches(state)` holds (or no matcher is given);
 * otherwise return `fresh()`. Logs when an existing file is discarded so the
 * reset is visible in the run log rather than silent.
 */
function loadState(file, fresh, { matches, label = "state" } = {}) {
  if (fs.existsSync(file)) {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!matches || matches(s)) return s;
    console.log(`${label}: existing file does not match this deployment — starting fresh`);
  }
  return fresh();
}

/** Write `state` as pretty JSON with a trailing newline (diff-friendly). */
function saveState(file, state) {
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}

module.exports = { loadState, saveState };
