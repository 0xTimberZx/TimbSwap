#!/usr/bin/env node
// fill-beta-config.js — copy the six DeployBeta addresses into config.mainnet.js.
//
// After `forge script scripts/DeployBeta.s.sol --broadcast`, Foundry writes the
// receipts to broadcast/DeployBeta.s.sol/42161/run-latest.json. This reads the
// CREATE transactions in that file, matches each contract to its `// beta` slot
// in config.mainnet.js and prints what would change. With --write it rewrites
// the file; `NET=mainnet sh scripts/build-site.sh` refuses until every slot is
// filled, so this is the step between the broadcast and the site build.
//
// It refuses to overwrite a slot that is already non-zero (a second run against
// a stale receipt must not silently repoint the live site); pass --force only
// when you mean to replace a previous beta deploy.
//
// Usage:
//   node scripts/fill-beta-config.js                 # dry run, default receipt
//   node scripts/fill-beta-config.js --write         # rewrite config.mainnet.js
//   node scripts/fill-beta-config.js path/to/run-latest.json --write
//   --config <file>   config to fill (default config.mainnet.js)
//
// No dependencies, no network.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_RECEIPT = path.join(ROOT, "broadcast", "DeployBeta.s.sol", "42161", "run-latest.json");

// contractName in the receipt  ->  key in config.mainnet.js addresses
const SLOTS = {
  GameRegistry:   "GameRegistry",
  TimbPrize:      "TimbPrize",
  VRFEntropy:     "PrizeVRFEntropy",
  TimbTreasury:   "TimbTreasury",
  GasFaucet:      "GasFaucet",
  TimbSwapRouter: "TimbSwapRouter",
};
const ZERO = "0x" + "0".repeat(40);

function main(argv) {
  let receiptPath = DEFAULT_RECEIPT, configPath = path.join(ROOT, "config.mainnet.js");
  let write = false, force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") write = true;
    else if (a === "--force") force = true;
    else if (a === "--config") configPath = path.resolve(argv[++i]);
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else receiptPath = path.resolve(a);
  }

  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  if (receipt.chain !== undefined && Number(receipt.chain) !== 42161)
    throw new Error(`receipt is for chain ${receipt.chain}, not Arbitrum One (42161)`);

  const found = {};
  for (const tx of receipt.transactions || []) {
    if (tx.transactionType !== "CREATE") continue;
    const key = SLOTS[tx.contractName];
    if (!key) continue;
    if (found[key]) throw new Error(`${tx.contractName} was created twice in the receipt; refusing to guess`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(tx.contractAddress || ""))
      throw new Error(`${tx.contractName} has no contractAddress in the receipt`);
    found[key] = tx.contractAddress.toLowerCase();
  }
  const missing = Object.values(SLOTS).filter(k => !found[k]);
  if (missing.length) throw new Error(`receipt is missing CREATE entries for: ${missing.join(", ")}`);

  let config = fs.readFileSync(configPath, "utf8");
  const changes = [];
  for (const key of Object.values(SLOTS)) {
    // e.g.   GameRegistry:         "0x0000…0000", // beta
    const re = new RegExp(`^(\\s*${key}:\\s*)"(0x[0-9a-fA-F]{40})"(,?\\s*// beta\\b)`, "m");
    const m = config.match(re);
    if (!m) throw new Error(`no "// beta" slot for ${key} in ${path.relative(ROOT, configPath)}`);
    const current = m[2].toLowerCase();
    if (current !== ZERO && current !== found[key] && !force)
      throw new Error(`${key} is already ${current}; pass --force to replace it with ${found[key]}`);
    if (current === found[key]) { changes.push(`${key.padEnd(16)} ${found[key]}  (unchanged)`); continue; }
    config = config.replace(re, `$1"${found[key]}"$3`);
    changes.push(`${key.padEnd(16)} ${current === ZERO ? "(zero)" : current} -> ${found[key]}`);
  }

  console.log(`${write ? "writing" : "dry run:"} ${path.relative(ROOT, configPath)} from ${path.relative(ROOT, receiptPath)}`);
  for (const c of changes) console.log("  " + c);
  if (write) {
    fs.writeFileSync(configPath, config);
    console.log("written. Next: MAINNET_ADDRESSES.md rows below, then NET=mainnet sh scripts/build-site.sh");
  } else {
    console.log("(dry run; add --write to apply)");
  }
  console.log("\nMAINNET_ADDRESSES.md (beta table):");
  for (const key of Object.values(SLOTS)) console.log(`| ${key} | \`${found[key]}\` |`);
  return 0;
}

try { process.exit(main(process.argv.slice(2))); }
catch (e) { console.error("fill-beta-config: " + e.message); process.exit(1); }
