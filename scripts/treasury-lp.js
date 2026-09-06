// ─── Treasury protocol-owned liquidity: TIMBS/ETH ─────────────────────────────
// Deploys the v4 Treasury's held TIMBS + ETH as liquidity into the TIMBS/ETH
// pool via TimbTreasury.provideLiquidityETH. LP tokens mint back to the
// Treasury (protocol-owned). Reads the live pool ratio so the add is balanced
// (the router refunds any dust it can't pair).
//
// PREREQUISITE: fund the Treasury with ETH first. The buyback spends treasury
// ETH, so it's typically ~0 — send ETH to the Treasury address, then run this.
//
// Usage:
//   node scripts/treasury-lp.js               # DRY RUN — shows the planned add
//   node scripts/treasury-lp.js --execute     # sends the provideLiquidityETH tx
//
// Env:
//   LP_PRIVATE_KEY   owner key (falls back to EPOCH_PRIVATE_KEY). Required for --execute.
//   TREASURY         treasury address (default: v4 0xd3F4…0D5c)
//   LP_ETH           ETH to deploy (default: the Treasury's full ETH balance)
//   LP_SLIPPAGE_BPS  min-out tolerance on the add (default 200 = 2%)
//   ARB_SEPOLIA_RPC  tx endpoint (falls back to the canonical RPC in config.js)

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

const EXECUTE = process.argv.includes("--execute");
const PRIVATE_KEY = process.env.LP_PRIVATE_KEY || process.env.EPOCH_PRIVATE_KEY;
const SLIP_BPS = BigInt(process.env.LP_SLIPPAGE_BPS || "200"); // 2%

function cfg(src, key) {
  const m = src.match(new RegExp("\\b" + key + '\\s*:\\s*"(0x[0-9a-fA-F]{40})"'));
  if (!m) throw new Error(`Address "${key}" not in config.js`);
  return ethers.getAddress(m[1]);
}
function rpcFromConfig(src) {
  const m = src.match(/\bRPC_URL\s*=\s*"(https?:\/\/[^"]+)"/);
  if (!m) throw new Error("RPC_URL not found in config.js");
  return m[1];
}

const TREASURY_ABI = [
  "function provideLiquidityETH(address token, uint256 amountTokenDesired, uint256 ethAmount, uint256 amountTokenMin, uint256 amountETHMin) external",
  "function ethBalance() view returns (uint256)",
  "function router() view returns (address)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
const PAIR_ABI  = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
];

const fmt = (wei, dp = 6) => Number(ethers.formatEther(wei)).toFixed(dp);

async function main() {
  const src = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  const RPC = process.env.ARB_SEPOLIA_RPC || rpcFromConfig(src);
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, provider) : null;

  const TREASURY = ethers.getAddress(process.env.TREASURY || "0xd3F40042aFA8074EA68C9f61dE6aDADD539F0D5c");
  const TIMBS    = cfg(src, "TIMBSToken");
  const PAIR     = cfg(src, "TimbsEthPair");

  const treasury = new ethers.Contract(TREASURY, TREASURY_ABI, wallet ?? provider);
  const timbs    = new ethers.Contract(TIMBS, ERC20_ABI, provider);
  const pair     = new ethers.Contract(PAIR, PAIR_ABI, provider);

  // Sanity: router must be wired for provideLiquidityETH to work.
  const router = await treasury.router();
  if (router === ethers.ZeroAddress) throw new Error("Treasury.router() is unset — call setRouter first");

  const ethBal   = await treasury.ethBalance();
  const timbsBal = await timbs.balanceOf(TREASURY);

  let ethToUse = process.env.LP_ETH ? ethers.parseEther(process.env.LP_ETH) : ethBal;
  if (ethToUse > ethBal) ethToUse = ethBal;

  console.log(`Treasury : ${TREASURY}`);
  console.log(`  ETH balance   : ${fmt(ethBal)} ETH`);
  console.log(`  TIMBS balance : ${fmt(timbsBal)} TIMBS`);
  console.log(`Mode     : ${EXECUTE ? "EXECUTE" : "DRY RUN"}`);

  if (ethToUse === 0n) {
    console.log("\nNo ETH to deploy — fund the Treasury with ETH first, then re-run.");
    return;
  }

  // Balance the add to the live pool ratio: TIMBS = ethToUse × reserveTIMBS/reserveWETH.
  const [r0, r1] = await pair.getReserves();
  const t0 = await pair.token0();
  const timbsIsT0  = t0.toLowerCase() === TIMBS.toLowerCase();
  const reserveTIMBS = timbsIsT0 ? BigInt(r0) : BigInt(r1);
  const reserveWETH  = timbsIsT0 ? BigInt(r1) : BigInt(r0);
  if (reserveTIMBS === 0n || reserveWETH === 0n) {
    throw new Error("TIMBS/ETH pool has no reserves — this script assumes an existing pool; seed the initial ratio manually.");
  }

  let amountTimbs = (ethToUse * reserveTIMBS) / reserveWETH;
  // Cap to the Treasury's TIMBS balance; if short, scale the ETH down to match.
  if (amountTimbs > timbsBal) {
    ethToUse    = (timbsBal * reserveWETH) / reserveTIMBS;
    amountTimbs = (ethToUse * reserveTIMBS) / reserveWETH;
  }

  const timbsMin = (amountTimbs * (10_000n - SLIP_BPS)) / 10_000n;
  const ethMin   = (ethToUse   * (10_000n - SLIP_BPS)) / 10_000n;

  console.log(`\nPlanned add (pool ratio 1 ETH ≈ ${fmt(reserveTIMBS * 10n**18n / reserveWETH, 0)} TIMBS):`);
  console.log(`  deposit ETH   : ${fmt(ethToUse)} ETH   (min ${fmt(ethMin)})`);
  console.log(`  deposit TIMBS : ${fmt(amountTimbs)} TIMBS (min ${fmt(timbsMin)})`);
  console.log(`  slippage      : ${Number(SLIP_BPS) / 100}%`);
  console.log(`  LP tokens     : minted back to the Treasury`);

  if (!EXECUTE) {
    console.log("\nDRY RUN — re-run with --execute to send. Ensure LP_PRIVATE_KEY is the Treasury owner.");
    return;
  }
  if (!wallet) throw new Error("--execute needs LP_PRIVATE_KEY / EPOCH_PRIVATE_KEY (the Treasury owner)");

  const tx = await treasury.provideLiquidityETH(TIMBS, amountTimbs, ethToUse, timbsMin, ethMin);
  console.log(`\n  sent ${tx.hash} …`);
  await tx.wait();
  console.log("  ✓ liquidity provided — LP tokens now held by the Treasury");
}

main().catch((e) => { console.error("TREASURY-LP FAILED:", e.message || e); process.exit(1); });
