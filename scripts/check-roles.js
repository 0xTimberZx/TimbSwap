#!/usr/bin/env node
/**
 * Ownership + role audit for the SwapTables contract set.
 *
 * A key rotation is easy to do 90% of. `transferOwnership` is the obvious part;
 * what gets missed is everything that is NOT ownership — the reserve's guardian,
 * the board's guardian, the seed funder, the token owner, and the previous
 * generation's contracts, which stay live because their ledger keeps paying
 * withdrawals forever. This reads every one of those in a single pass and tells
 * you which wallet holds it.
 *
 * Usage:
 *   node scripts/check-roles.js                      # just report
 *   node scripts/check-roles.js 0xYourNewWallet      # report + flag anything
 *                                                    # NOT held by that address
 * Needs ARB_SEPOLIA_RPC in the environment. Read-only — signs nothing.
 */

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = process.env.ARB_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc";
const EXPECT = (process.argv[2] || "").toLowerCase();

// Addresses come from config.js so this can never drift from what the apps use.
const cfg = fs.readFileSync(path.resolve(__dirname, "..", "config.js"), "utf8");
const A = {};
for (const [, name, addr] of cfg.matchAll(/^\s{2}(\w+):\s*"(0x[a-fA-F0-9]{40})"/gm)) A[name] = addr;

/**
 * Retired generations are deliberately included. Their boards are dead but the
 * ledgers still hold player credit and still pay it out, so a burned key with
 * owner on one of those is a live exposure, not history.
 */
const RETIRED = {
  "gen-8 SegmentBoard":       "0x89eE2553AD7c72700A7BfD7A095440cc8BE55227",
  "gen-8 PoolLedger":         "0x9195803ecA9A0F4F813502A110b32C842330fD0D",
  "gen-8 UnderwriteReserve":  "0x69C9E840aEc4368016038bF54e603E345ede1063",
  "gen-8 VRFEntropy":         "0xD982C7218cBD3c395a0A1461732ADEc99A3A87c0",
  "gen-7 SegmentBoard":       "0xf3FF34488D472b89497Cf31631c77bE85524A65a",
  "gen-7 PoolLedger":         "0xAA4f4303b747bEa63F9818Bc9C38dAe5aebDe218",
  "gen-7 CommitRevealEntropy":"0x57A1F889A30178b62Bc39844D73B68d0f8a274d6",
  "gen-6 SegmentBoard":       "0x1de9889da2083F5f1693DfCf589A453E9b39EEA7",
  "gen-6 PoolLedger":         "0x819B5074312E4ADD9D72D722D9C6a38320796Bd8",
  "gen-6 UnderwriteReserve":  "0xa0f88d8504D340702889C48288D8FB9329D88184",
};

const OWNABLE  = "function owner() view returns (address)";
const GUARDIAN = "function guardian() view returns (address)";
const FUNDER   = "function seedFunder() view returns (address)";

const TARGETS = [
  ["SegmentBoard (live)",      A.SegmentBoard,      [OWNABLE, GUARDIAN, FUNDER]],
  ["PoolLedger (live)",        A.PoolLedger,        [OWNABLE]],
  ["UnderwriteReserve (live)", A.UnderwriteReserve, [OWNABLE, GUARDIAN]],
  ["DDJackpot",                A.DDJackpot,         [OWNABLE, GUARDIAN]],
  ["SeedRegistry",             A.SeedRegistry,      [OWNABLE]],
  ["TIMBSToken",               A.TIMBSToken,        [OWNABLE]],
  ["TimbTreasury",             A.TimbTreasury,      [OWNABLE]],
  ...Object.entries(RETIRED).map(([k, v]) => [k, v, [OWNABLE, GUARDIAN]]),
];

(async () => {
  const p = new ethers.JsonRpcProvider(RPC, 42161, { staticNetwork: true });
  console.log(`RPC ${RPC}`);
  if (EXPECT) console.log(`expecting every role to be held by ${EXPECT}\n`);
  else console.log("(pass an address as argv[1] to flag anything it does not hold)\n");

  // A missing function and a dead RPC both throw. Conflating them would let a
  // network failure read as a clean audit, which is the one thing this script
  // must never do — so only a genuine "no such function" is swallowed.
  const isMissingFn = e =>
    e?.code === "BAD_DATA" || e?.code === "CALL_EXCEPTION" ||
    /could not decode|execution reverted/i.test(e?.message || "");

  let flagged = 0, unread = 0, netErrors = 0;
  for (const [label, addr, frags] of TARGETS) {
    if (!addr) { console.log(`${label.padEnd(26)} — not in config.js`); continue; }
    const c = new ethers.Contract(addr, frags, p);
    const roles = [];
    for (const frag of frags) {
      const fn = frag.match(/function (\w+)\(/)[1];
      try {
        const who = await c[fn]();
        // guardian(0) is a real, meaningful state: the role was retired on
        // purpose and nobody can halt or drain. Say so rather than flag it.
        const note = who === ethers.ZeroAddress ? "(retired / unset)" : "";
        const bad = EXPECT && who !== ethers.ZeroAddress && who.toLowerCase() !== EXPECT;
        if (bad) flagged++;
        roles.push(`${fn}=${who}${note ? " " + note : ""}${bad ? "   <-- NOT the new wallet" : ""}`);
      } catch (e) {
        if (!isMissingFn(e)) {
          netErrors++;
          roles.push(`${fn}=UNREADABLE (${e.shortMessage || e.message})`);
        }
        // else: this contract legitimately does not expose that role.
      }
    }
    if (!roles.length) { unread++; console.log(`${label.padEnd(26)} ${addr}  (no readable roles)`); continue; }
    console.log(`${label}\n  ${addr}`);
    for (const r of roles) console.log(`    ${r}`);
  }

  console.log("");
  if (netErrors) {
    console.error(`${netErrors} role(s) could not be read — the chain was not reachable.`);
    console.error("This is NOT a clean audit. Fix the RPC and re-run.");
    process.exit(2);
  }
  if (EXPECT && flagged) {
    console.log(`${flagged} role(s) still held by another wallet — see the arrows above.`);
    process.exit(1);
  }
  if (EXPECT) console.log("every readable role is held by the expected wallet.");
  if (unread) console.log(`${unread} contract(s) exposed none of owner/guardian/seedFunder.`);
})().catch(e => { console.error("failed:", e.message); process.exit(1); });
