// ─── Old-Treasury sweep ───────────────────────────────────────────────────────
// One-off recovery: withdraw every non-zero token balance (and the ETH) from an
// old TimbTreasury deploy to a recipient, using the contract's owner-only exits
// (withdrawToken / withdrawOperational). Written for the v3 → v4 cutover, but
// works against any TimbTreasury the caller owns.
//
// Usage:
//   node scripts/sweep-treasury.js                # DRY RUN — lists balances, no txs
//   node scripts/sweep-treasury.js --execute      # actually withdraws
//
// Env:
//   SWEEP_PRIVATE_KEY  owner key (falls back to EPOCH_PRIVATE_KEY). Required for --execute.
//   OLD_TREASURY       treasury to drain (default: v3 0x05D47…A33)
//   SWEEP_TO           recipient (default: the owner wallet's own address)
//   ARB_SEPOLIA_RPC    tx endpoint (falls back to the canonical RPC in config.js)
//
// Reads all token/factory addresses from config.js — single source of truth.

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

const EXECUTE = process.argv.includes("--execute");
const PRIVATE_KEY = process.env.SWEEP_PRIVATE_KEY || process.env.EPOCH_PRIVATE_KEY;
const OLD_TREASURY = ethers.getAddress(
  process.env.OLD_TREASURY || "0x05D47F639F8E76BD12Cfc9647F6CcaCe21C10A33"
);

function cfg(src, key, { optional = false } = {}) {
  const m = src.match(new RegExp("\\b" + key + '\\s*:\\s*"(0x[0-9a-fA-F]{40})"'));
  if (!m) { if (optional) return null; throw new Error(`Address "${key}" not in config.js`); }
  return ethers.getAddress(m[1]);
}
function rpcFromConfig(src) {
  const m = src.match(/\bRPC_URL\s*=\s*"(https?:\/\/[^"]+)"/);
  if (!m) throw new Error("RPC_URL not found in config.js");
  return m[1];
}

const TREASURY_ABI = [
  "function withdrawToken(address token, address to, uint256 amount) external",
  "function withdrawOperational(address to, uint256 amount) external",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];
const FACTORY_ABI = [
  "function getPairAddress(address a, address b) view returns (address)",
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
];

async function main() {
  const src = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  const RPC = process.env.ARB_SEPOLIA_RPC || rpcFromConfig(src);
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, provider) : null;

  const TIMBS   = cfg(src, "TIMBSToken");
  const FACTORY = cfg(src, "TimbSwapFactory");
  // Plain ERC20s the treasury may hold as fee revenue.
  const quoteKeys = ["WETH", "USDC", "LINK", "USDT", "DAPP"];
  const quotes = quoteKeys.map((k) => cfg(src, k, { optional: true })).filter(Boolean);

  // LP tokens: enumerate EVERY pair the factory ever created and check each,
  // so no LP is missed regardless of which tokens it pairs. Falls back to the
  // curated TIMBS/<quote> derivation if enumeration isn't available.
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
  const pairs = [];
  try {
    const n = Number(await factory.allPairsLength());
    for (let i = 0; i < n; i++) {
      try { pairs.push(await factory.allPairs(i)); } catch {}
    }
  } catch {
    for (const q of quotes) {
      try {
        const p = await factory.getPairAddress(TIMBS, q);
        if (p && p !== ethers.ZeroAddress) pairs.push(p);
      } catch {}
    }
  }

  // Belt-and-suspenders: any token address the dropdown shows that the
  // curated list + factory derivation might miss can be force-added here.
  const extra = (process.env.EXTRA_TOKENS || "")
    .split(",").map((s) => s.trim()).filter(Boolean).map((a) => ethers.getAddress(a));

  // Full candidate set (dedup), each checked for a non-zero treasury balance.
  const candidates = [...new Set([TIMBS, ...quotes, ...pairs, ...extra].map((a) => a.toLowerCase()))]
    .map((a) => ethers.getAddress(a));

  const recipient = process.env.SWEEP_TO
    ? ethers.getAddress(process.env.SWEEP_TO)
    : (wallet ? wallet.address : null);
  if (!recipient) throw new Error("No SWEEP_TO and no key to derive the owner address");

  console.log(`Old Treasury : ${OLD_TREASURY}`);
  console.log(`Recipient    : ${recipient}`);
  console.log(`Mode         : ${EXECUTE ? "EXECUTE (sending txs)" : "DRY RUN (read-only)"}`);
  console.log("");

  const treasury = wallet
    ? new ethers.Contract(OLD_TREASURY, TREASURY_ABI, wallet)
    : new ethers.Contract(OLD_TREASURY, TREASURY_ABI, provider);

  let moved = 0;

  // ── ERC20 / LP balances ──────────────────────────────────────────────────
  for (const token of candidates) {
    const erc = new ethers.Contract(token, ERC20_ABI, provider);
    let bal, sym = "?", dec = 18;
    try { bal = await erc.balanceOf(OLD_TREASURY); } catch { continue; }
    if (bal === 0n) continue;
    try { sym = await erc.symbol(); } catch {}
    try { dec = Number(await erc.decimals()); } catch {}
    console.log(`  ${sym.padEnd(12)} ${ethers.formatUnits(bal, dec).padEnd(24)} ${token}`);
    if (EXECUTE) {
      if (!wallet) throw new Error("--execute needs SWEEP_PRIVATE_KEY / EPOCH_PRIVATE_KEY");
      const tx = await treasury.withdrawToken(token, recipient, bal);
      await tx.wait();
      console.log(`    ✓ withdrawn  ${tx.hash}`);
    }
    moved++;
  }

  // ── Native ETH ───────────────────────────────────────────────────────────
  const ethBal = await provider.getBalance(OLD_TREASURY);
  if (ethBal > 0n) {
    console.log(`  ${"ETH".padEnd(12)} ${ethers.formatEther(ethBal).padEnd(24)} (native)`);
    if (EXECUTE) {
      const tx = await treasury.withdrawOperational(recipient, ethBal);
      await tx.wait();
      console.log(`    ✓ withdrawn  ${tx.hash}`);
    }
    moved++;
  }

  console.log("");
  console.log(moved === 0
    ? "Nothing to sweep — treasury is empty."
    : EXECUTE ? `Done — swept ${moved} asset(s).` : `${moved} asset(s) to sweep. Re-run with --execute to withdraw.`);
}

main().catch((e) => { console.error("SWEEP FAILED:", e.message || e); process.exit(1); });
