// lp-fee-split.js — send the pools' protocol fee half to the prize pot.
//
// Each pool charges 0.30% and routes 0.05% of it to the protocol as LP tokens
// minted to the factory's feeTo (the treasury). TimbTreasury.splitLpFees(pair)
// redeems that fee LP (never the treasury's own liquidity) and sends the WETH
// side, half the value, to the pot through TimbPrize.addToPot. The call is
// permissionless; this keeper just makes sure it happens on a schedule.
//
// A pair is split when its fee LP would return at least MIN_SPLIT_ETH of WETH.
// The fee LP is realised lazily (on the pool's next mint or burn), so most
// runs find nothing to do; that is normal.
//
// Env:
//   ARB_SEPOLIA_RPC           RPC for reads and the transaction
//   LP_SPLIT_PRIVATE_KEY      any funded key (gas only); falls back to
//                             FAUCET_DISPATCHER_PRIVATE_KEY
//   LP_SPLIT_PAIRS            optional comma-separated extra WETH pairs
//   MIN_SPLIT_ETH             default 0.0005
// Args: --dry-run  report, send nothing.
const { ethers } = require("ethers");
const { addrFromConfig } = require("./lib/config");

const MIN_SPLIT = ethers.parseEther(process.env.MIN_SPLIT_ETH || "0.0005");
const DRY_RUN   = process.argv.includes("--dry-run");

const TREASURY_ABI = [
  "function polLp(address) view returns (uint256)",
  "function splitLpFees(address pair)",
];
const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function getReserves() view returns (uint112, uint112, uint32)",
];

/**
 * Pure: the WETH a split would send to the pot. Fee LP is the treasury's LP
 * above its own liquidity; it redeems pro rata against the WETH reserve.
 */
function wethFromFeeLp({ lpBalance, polLp, totalSupply, wethReserve }) {
  const feeLp = lpBalance > polLp ? lpBalance - polLp : 0n;
  if (feeLp === 0n || totalSupply === 0n) return { feeLp, weth: 0n };
  return { feeLp, weth: (feeLp * wethReserve) / totalSupply };
}

async function main() {
  const rpc = process.env.ARB_SEPOLIA_RPC;
  if (!rpc) throw new Error("Missing ARB_SEPOLIA_RPC");
  const provider = new ethers.JsonRpcProvider(rpc);
  const treasuryAddr = addrFromConfig("TimbTreasury");
  const weth = addrFromConfig("WETH").toLowerCase();

  const pairs = new Set([addrFromConfig("TimbsEthPair")]);
  for (const p of (process.env.LP_SPLIT_PAIRS || "").split(",").map(s => s.trim()).filter(Boolean)) pairs.add(ethers.getAddress(p));

  const treasuryRO = new ethers.Contract(treasuryAddr, TREASURY_ABI, provider);
  const due = [];
  for (const pairAddr of pairs) {
    const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
    const [t0, t1, bal, pol, supply, reserves] = await Promise.all([
      pair.token0(), pair.token1(), pair.balanceOf(treasuryAddr), treasuryRO.polLp(pairAddr),
      pair.totalSupply(), pair.getReserves(),
    ]);
    const wethIs0 = t0.toLowerCase() === weth;
    if (!wethIs0 && t1.toLowerCase() !== weth) { console.log(`[lp-split] ${pairAddr}: not a WETH pair, skipped`); continue; }
    const { feeLp, weth: out } = wethFromFeeLp({
      lpBalance: bal, polLp: pol, totalSupply: supply, wethReserve: wethIs0 ? reserves[0] : reserves[1],
    });
    console.log(`[lp-split] ${pairAddr}: fee LP ${feeLp}, ~${ethers.formatEther(out)} ETH to the pot`);
    if (out >= MIN_SPLIT) due.push(pairAddr);
  }

  if (!due.length) { console.log("[lp-split] nothing to split"); return; }
  if (DRY_RUN) { console.log(`[lp-split] dry run: would split ${due.join(", ")}`); return; }

  const key = process.env.LP_SPLIT_PRIVATE_KEY || process.env.FAUCET_DISPATCHER_PRIVATE_KEY;
  if (!key) throw new Error("Missing LP_SPLIT_PRIVATE_KEY (or FAUCET_DISPATCHER_PRIVATE_KEY)");
  const treasury = treasuryRO.connect(new ethers.Wallet(key, provider));
  for (const pairAddr of due) {
    const tx = await treasury.splitLpFees(pairAddr);
    const rc = await tx.wait();
    console.log(`[lp-split] split ${pairAddr} in ${rc.hash}`);
  }
}

if (require.main === module) {
  main().catch(e => { console.error("[lp-split] failed:", e.shortMessage || e.message); process.exit(1); });
}

module.exports = { wethFromFeeLp };
