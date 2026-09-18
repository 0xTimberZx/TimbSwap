// fund-rewards.js — one-off admin: grant TIMBS rewards to TimbFarm and/or
// TimbStaking outside the epoch waterfall.
//
// The waterfall (epoch.js) only pours what buybacks put into the Treasury
// (z). On a quiet testnet with no fee ETH, z = 0 and the grants are zero even
// though the emission windows have lapsed — the Farm page then shows "ended …
// needs refunding". This script is the owner's manual grant for that case:
// withdraw TIMBS from the Treasury (or spend the signer's own), approve the
// pool, and notifyRewardAmount(amount, duration). Synthetix-style: if a
// period is still running, its leftover rolls into the new window.
//
// Usage (GitHub Actions "Admin — Fund Rewards" workflow, or locally):
//   FARM_TIMBS=10000 STAKE_TIMBS=10000 DAYS=90 SOURCE=treasury \
//     node scripts/fund-rewards.js [--dry-run]
//
//   FARM_TIMBS / STAKE_TIMBS  whole TIMBS (decimal string); 0 skips that pool
//   DAYS                      emission period in days (decimal ok). Default 90,
//                             matching the keeper's EMIT_PERIOD_DAYS — every
//                             notify re-anchors periodFinish to now + this.
//   SOURCE                    treasury (default) — Treasury.withdrawToken first
//                             wallet   — spend the signer's own TIMBS
//
// Key requirement: EPOCH_PRIVATE_KEY (the epoch keeper's key). It must be an
// authorised rewardNotifier or the owner of each pool it funds, and the
// Treasury owner when SOURCE=treasury (withdrawToken is onlyOwner). The
// script checks all of that on-chain before sending anything.

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

const TX_RPC_URL  = process.env.ARB_SEPOLIA_RPC;
const PRIVATE_KEY = process.env.EPOCH_PRIVATE_KEY;
const FARM_TIMBS  = (process.env.FARM_TIMBS  ?? "10000").trim();
const STAKE_TIMBS = (process.env.STAKE_TIMBS ?? "10000").trim();
const DAYS        = (process.env.DAYS        ?? "90").trim();  // match the keeper's fixed period
const SOURCE      = (process.env.SOURCE      ?? "treasury").trim().toLowerCase();
const DRY_RUN     = process.argv.includes("--dry-run");
const RPC_OVERRIDE = process.env.READ_RPC_URL; // tests only

// ─── config.js readers (same fallbacks as epoch.js) ─────────────────────────

const CANONICAL_RPC = "https://sepolia-rollup.arbitrum.io/rpc";

function configSrc() {
  return fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
}

function addrFromConfig(key) {
  const m = configSrc().match(new RegExp("\\b" + key + '\\s*:\\s*"(0x[0-9a-fA-F]{40})"'));
  if (!m) throw new Error(`Address "${key}" not found in config.js`);
  return ethers.getAddress(m[1]);
}

function rpcFromConfig() {
  if (RPC_OVERRIDE) return RPC_OVERRIDE;
  let src = "";
  try { src = configSrc(); } catch (_e) { return CANONICAL_RPC; }
  const lit = src.match(/\bRPC_URL\s*=\s*"(https?:\/\/[^"]+)"/);
  if (lit) return lit[1];
  const arr = src.match(/\bPUBLIC_RPCS\s*=\s*\[([\s\S]*?)\]/);
  if (arr) {
    const first = arr[1].match(/"(https?:\/\/[^"]+)"/);
    if (first) return first[1];
  }
  return CANONICAL_RPC;
}

// ─── ABIs ───────────────────────────────────────────────────────────────────

const POOL_ABI = [
  "function owner() view returns (address)",
  "function rewardNotifiers(address) view returns (bool)",
  "function periodFinish() view returns (uint256)",
  "function rewardRatePerSecond() view returns (uint256)",
  "function totalStaked() view returns (uint256)",
  "function notifyRewardAmount(uint256 amount, uint256 duration)",
];
const TREASURY_ABI = [
  "function owner() view returns (address)",
  "function withdrawToken(address token, address to, uint256 amount)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const fmt = (wei) => Number(ethers.formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 2 });
const fmtDur = (s) => {
  s = Number(s);
  if (s <= 0) return "0";
  const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3_600);
  return d ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3_600) / 60)}m`;
};

function parseTimbs(label, s) {
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Bad ${label}: "${s}" (whole TIMBS, e.g. 10000 or 2500.5)`);
  return ethers.parseEther(s);
}

async function poolStatus(name, pool, addr, signerAddr, now) {
  const [owner, notifier, finish, rate, staked] = await Promise.all([
    pool.owner(), pool.rewardNotifiers(signerAddr), pool.periodFinish(),
    pool.rewardRatePerSecond(), pool.totalStaked().catch(() => null),
  ]);
  const live = Number(finish) > now;
  const leftover = live ? (BigInt(finish) - BigInt(now)) * rate : 0n;
  console.log(`${name} ${addr}`);
  console.log(`  owner: ${owner}  signer authorised: ${notifier || owner.toLowerCase() === signerAddr.toLowerCase() ? "yes" : "NO"}`);
  console.log(`  period: ${live ? `live, ends in ${fmtDur(Number(finish) - now)}` : Number(finish) === 0 ? "never started" : `ended ${fmtDur(now - Number(finish))} ago`}`);
  console.log(`  rate: ${fmt(rate * 86_400n)} TIMBS/day${live ? `  (leftover ${fmt(leftover)} TIMBS rolls into the new window)` : ""}`);
  if (staked !== null) console.log(`  total staked: ${fmt(staked)}`);
  return { authorised: notifier || owner.toLowerCase() === signerAddr.toLowerCase(), leftover };
}

(async () => {
  const farmAmt  = parseTimbs("FARM_TIMBS", FARM_TIMBS);
  const stakeAmt = parseTimbs("STAKE_TIMBS", STAKE_TIMBS);
  if (!/^\d+(\.\d+)?$/.test(DAYS) || Number(DAYS) <= 0) throw new Error(`Bad DAYS: "${DAYS}"`);
  const duration = Math.round(Number(DAYS) * 86_400);
  if (!["treasury", "wallet"].includes(SOURCE)) throw new Error(`Bad SOURCE: "${SOURCE}" (treasury | wallet)`);
  const total = farmAmt + stakeAmt;
  if (total === 0n) throw new Error("Nothing to do: FARM_TIMBS and STAKE_TIMBS are both 0");

  const readProv = new ethers.JsonRpcProvider(rpcFromConfig());
  const timbsAddr    = addrFromConfig("TIMBSToken");
  const farmAddr     = addrFromConfig("TimbFarm");
  const stakingAddr  = addrFromConfig("TimbStaking");
  const treasuryAddr = addrFromConfig("TimbTreasury");

  // The signer is needed to know WHO must be authorised, even on a dry run.
  if (!PRIVATE_KEY) throw new Error("EPOCH_PRIVATE_KEY not set");
  const txProv = new ethers.JsonRpcProvider(TX_RPC_URL || rpcFromConfig());
  const signer = new ethers.Wallet(PRIVATE_KEY, txProv);

  const timbs    = new ethers.Contract(timbsAddr, ERC20_ABI, signer);
  const farm     = new ethers.Contract(farmAddr, POOL_ABI, signer);
  const staking  = new ethers.Contract(stakingAddr, POOL_ABI, signer);
  const treasury = new ethers.Contract(treasuryAddr, TREASURY_ABI, signer);
  const rTimbs    = timbs.connect(readProv);
  const rTreasury = treasury.connect(readProv);

  const now = Math.floor(Date.now() / 1000);
  console.log(`signer ${signer.address}  source=${SOURCE}  window=${DAYS}d (${duration}s)`);
  console.log(`grant: farm ${fmt(farmAmt)} TIMBS · staking ${fmt(stakeAmt)} TIMBS · total ${fmt(total)} TIMBS`);
  console.log(`  ≈ farm ${fmt(farmAmt / BigInt(Math.max(1, Math.round(duration / 86_400))))}/day · staking ${fmt(stakeAmt / BigInt(Math.max(1, Math.round(duration / 86_400))))}/day before rollover\n`);

  // ── Preflight: authority + balances, all read from chain ──────────────────
  const problems = [];
  const plan = [];
  if (farmAmt > 0n) {
    const s = await poolStatus("TimbFarm", farm.connect(readProv), farmAddr, signer.address, now);
    if (!s.authorised) problems.push("signer is neither owner nor rewardNotifier on TimbFarm");
    plan.push({ name: "TimbFarm", pool: farm, addr: farmAddr, amount: farmAmt });
  }
  if (stakeAmt > 0n) {
    const s = await poolStatus("TimbStaking", staking.connect(readProv), stakingAddr, signer.address, now);
    if (!s.authorised) problems.push("signer is neither owner nor rewardNotifier on TimbStaking");
    plan.push({ name: "TimbStaking", pool: staking, addr: stakingAddr, amount: stakeAmt });
  }

  const [signerBal, treasuryBal, treasuryOwner] = await Promise.all([
    rTimbs.balanceOf(signer.address), rTimbs.balanceOf(treasuryAddr), rTreasury.owner(),
  ]);
  console.log(`\nTIMBS balances: signer ${fmt(signerBal)} · treasury ${fmt(treasuryBal)}`);
  if (SOURCE === "treasury") {
    if (treasuryOwner.toLowerCase() !== signer.address.toLowerCase()) {
      problems.push(`SOURCE=treasury but signer is not the Treasury owner (${treasuryOwner})`);
    }
    if (treasuryBal < total) {
      problems.push(`Treasury holds ${fmt(treasuryBal)} TIMBS < ${fmt(total)} requested — top it up or lower the grant`);
    }
  } else if (signerBal < total) {
    problems.push(`signer holds ${fmt(signerBal)} TIMBS < ${fmt(total)} requested`);
  }

  if (problems.length) {
    console.error("\nPreflight failed:");
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log("\nPreflight OK.");
  if (DRY_RUN) { console.log("--dry-run: not sending."); return; }
  if (!TX_RPC_URL) console.warn("ARB_SEPOLIA_RPC not set — sending through the public RPC");

  // ── Send: per pool, (withdraw) → approve → notify ─────────────────────────
  for (const g of plan) {
    console.log(`\n${g.name}: granting ${fmt(g.amount)} TIMBS over ${fmtDur(duration)}`);
    if (SOURCE === "treasury") {
      const tx = await treasury.withdrawToken(timbsAddr, signer.address, g.amount);
      console.log(`  withdrawToken sent: ${tx.hash}`); await tx.wait();
    }
    const allowance = await timbs.allowance(signer.address, g.addr);
    if (allowance < g.amount) {
      const tx = await timbs.approve(g.addr, g.amount);
      console.log(`  approve sent: ${tx.hash}`); await tx.wait();
    }
    const tx = await g.pool.notifyRewardAmount(g.amount, duration);
    console.log(`  notifyRewardAmount sent: ${tx.hash}`); await tx.wait();
    const [finish, rate] = await Promise.all([g.pool.periodFinish(), g.pool.rewardRatePerSecond()]);
    console.log(`  ✓ live — ${fmt(rate * 86_400n)} TIMBS/day, ends ${new Date(Number(finish) * 1000).toISOString()} (in ${fmtDur(Number(finish) - Math.floor(Date.now() / 1000))})`);
  }
  console.log("\nDone. The Farm page shows the new windows on its next refresh.");
})().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
