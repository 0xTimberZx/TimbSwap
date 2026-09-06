#!/usr/bin/env node
/**
 * Frontend gate for the SwapTables pages (tables/).
 *
 * Two checks, both aimed at the two ways these pages have actually broken:
 *
 *   1. SYNTAX — every inline <script> is parsed with `node --check`. The pages
 *      are hand-edited single files with no build step, so a stray brace ships
 *      silently and only surfaces when a player connects a wallet.
 *
 *   2. ADDRESS DRIFT — each page's ADDR block is compared against config.js,
 *      the single source of truth. Every generation deploy has to touch both,
 *      and a page left pointing at a retired board looks completely healthy
 *      while quietly transacting against the wrong generation.
 *
 * No dependencies, no network. Run locally with:  node scripts/check-frontend.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT  = path.resolve(__dirname, "..");
const PAGES = ["tables/index.html", "tables/play.html", "tables/live.html",
               "tables/games.html"];

// ADDR key in the pages  ->  name in config.js ADDRESSES
const KEYMAP = {
  board:   "SegmentBoard",
  ledger:  "PoolLedger",
  jackpot: "DDJackpot",
  timbs:   "TIMBSToken",
  crank:   "SegmentCrank",
  prize:   "TimbPrize",
};

let failures = 0;
const fail = (msg) => { console.error("  FAIL  " + msg); failures++; };
const ok   = (msg) => console.log("  ok    " + msg);

// ── config.js is the source of truth ───────────────────────────────────────
const cfgSrc = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");
const truth  = {};
for (const [, name, addr] of cfgSrc.matchAll(/^\s{2}(\w+):\s*"(0x[a-fA-F0-9]{40})"/gm)) {
  truth[name] = addr.toLowerCase();
}
if (!truth.SegmentBoard) {
  console.error("could not read addresses out of config.js — check the format");
  process.exit(1);
}
console.log(`config.js: ${Object.keys(truth).length} addresses read `
          + `(SegmentBoard ${truth.SegmentBoard})\n`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swaptables-check-"));

for (const rel of PAGES) {
  console.log(rel);
  const html = fs.readFileSync(path.join(ROOT, rel), "utf8");

  // 1. every inline script must parse
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  if (!scripts.length) fail("no inline <script> found — did the page change shape?");
  scripts.forEach((m, i) => {
    const file = path.join(tmp, `${path.basename(rel)}.${i}.mjs`);
    fs.writeFileSync(file, m[1]);
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (r.status !== 0) fail(`inline script #${i} does not parse:\n${r.stderr.trim()}`);
  });
  if (!failures) ok(`${scripts.length} inline script(s) parse`);

  // 2. the ADDR block must agree with config.js
  const block = html.match(/const ADDR\s*=\s*\{([\s\S]*?)\n\};/);
  if (!block) { fail("no ADDR block found"); continue; }
  const entries = [...block[1].matchAll(/(\w+)\s*:\s*"(0x[a-fA-F0-9]{40})"/g)];
  if (!entries.length) fail("ADDR block held no addresses");
  for (const [, key, addr] of entries) {
    const want = KEYMAP[key];
    if (!want) { console.log(`  skip  ADDR.${key} — not mapped to config.js`); continue; }
    if (!truth[want]) { fail(`config.js has no ${want} to compare ADDR.${key} against`); continue; }
    if (addr.toLowerCase() !== truth[want]) {
      fail(`ADDR.${key} is ${addr}\n        config.js ${want} is ${truth[want]}`);
    } else {
      ok(`ADDR.${key} matches config.js ${want}`);
    }
  }
  console.log("");
}

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} problem(s) found.`);
  process.exit(1);
}
console.log("frontend checks passed.");
