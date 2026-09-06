// set-boost-window.js — one-off admin: stretch TimbBoostFarm's emission
// window. The farm aims its FREE reserve (reserve − owed) over emissionWindow
// seconds; setEmissionWindow() retargets the rate inline, so the new pace
// takes effect in the same transaction (no waiting for the next claim/top-up).
//
// Usage (GitHub Actions admin workflow, or locally):
//   WINDOW_SECONDS=302400 node scripts/set-boost-window.js [--dry-run]
//
// Defaults to 302400s = 14 rounds × 21600s (6h). The original deploy aimed
// ~6.5 rounds — stretching the window slows the drip so a given boost budget
// lasts longer between epoch refills.
//
// Key requirement: EPOCH_PRIVATE_KEY must be the TimbBoostFarm OWNER
// (setEmissionWindow is onlyOwner) — the same deployer key the epoch keeper
// already uses for treasury draws.

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

const TX_RPC_URL     = process.env.ARB_SEPOLIA_RPC;
const PRIVATE_KEY    = process.env.EPOCH_PRIVATE_KEY;
const WINDOW_SECONDS = Number(process.env.WINDOW_SECONDS || 302_400); // 14 rounds
const DRY_RUN        = process.argv.includes("--dry-run");

const ROUND_SECONDS = 21_600; // TimbPrize.ROUND_DURATION (6h) — labeling only

function addrFromConfig(key) {
  const src = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  const m = src.match(new RegExp("\\b" + key + '\\s*:\\s*"(0x[0-9a-fA-F]{40})"'));
  if (!m) throw new Error(`Address "${key}" not found in config.js`);
  return ethers.getAddress(m[1]);
}

function rpcFromConfig() {
  const src = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  const m = src.match(/RPC_URL\s*=\s*"(https?:[^"]+)"/);
  if (!m) throw new Error("RPC_URL not found in config.js");
  return m[1];
}

const FARM_ABI = [
  "function emissionWindow() view returns (uint256)",
  "function owner() view returns (address)",
  "function rewardRatePerSecond() view returns (uint256)",
  "function setEmissionWindow(uint256 windowSeconds)",
];

const asRounds = (s) => (Number(s) / ROUND_SECONDS).toFixed(2);

(async () => {
  if (!Number.isInteger(WINDOW_SECONDS) || WINDOW_SECONDS <= 0) {
    throw new Error(`Bad WINDOW_SECONDS: ${process.env.WINDOW_SECONDS}`);
  }

  const farmAddr = addrFromConfig("TimbBoostFarm");
  const readProv = new ethers.JsonRpcProvider(rpcFromConfig());
  const farm     = new ethers.Contract(farmAddr, FARM_ABI, readProv);

  const [oldWindow, owner, oldRate] = await Promise.all([
    farm.emissionWindow(), farm.owner(), farm.rewardRatePerSecond(),
  ]);
  console.log(`TimbBoostFarm ${farmAddr}`);
  console.log(`  owner:          ${owner}`);
  console.log(`  window (old):   ${oldWindow}s (~${asRounds(oldWindow)} rounds)`);
  console.log(`  rate (old):     ${oldRate} wei/s`);
  console.log(`  window (new):   ${WINDOW_SECONDS}s (~${asRounds(WINDOW_SECONDS)} rounds)`);

  if (BigInt(WINDOW_SECONDS) === oldWindow) {
    console.log("Window already at target — nothing to do.");
    return;
  }
  if (DRY_RUN) { console.log("--dry-run: not sending."); return; }

  if (!TX_RPC_URL || !PRIVATE_KEY) {
    throw new Error("ARB_SEPOLIA_RPC and EPOCH_PRIVATE_KEY are required to send");
  }
  const signer = new ethers.Wallet(PRIVATE_KEY, new ethers.JsonRpcProvider(TX_RPC_URL));
  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not the farm owner ${owner}`);
  }

  const tx = await farm.connect(signer).setEmissionWindow(WINDOW_SECONDS);
  console.log(`sent: ${tx.hash}`);
  await tx.wait();

  const [newWindow, newRate] = await Promise.all([
    farm.emissionWindow(), farm.rewardRatePerSecond(),
  ]);
  console.log(`  window (now):   ${newWindow}s (~${asRounds(newWindow)} rounds)`);
  console.log(`  rate (now):     ${newRate} wei/s (retargeted inline)`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
