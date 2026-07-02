// settler.js
// TimbSwap automated settler — runs via GitHub Actions every 10 minutes.
// Checks timeRemainingInSegment() on TimbPrize and calls settleSegment()
// when the interaction window has elapsed.

const { ethers } = require("ethers");

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC_URL       = process.env.ARB_SEPOLIA_RPC;
const PRIVATE_KEY   = process.env.SETTLER_PRIVATE_KEY;
const TG_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const TIMBPRIZE_ADDR = "0xB42fC21808Eb2b6ff0A9B50654185e496EC6cDa4";

// ─── ABI (minimal) ───────────────────────────────────────────────────────────

const TIMBPRIZE_ABI = [
  "function timeRemainingInSegment() external view returns (uint256)",
  "function currentRound() external view returns (uint256)",
  "function currentSegment() external view returns (uint256)",
  "function settleSegment() external",
  "function gameStarted() external view returns (bool)"
];

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function notify(msg) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.log("[notify] No Telegram config:", msg);
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const res  = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text:    `🔄 *TimbSwap Settler*\n${msg}`,
        parse_mode: "Markdown"
      })
    });
    if (!res.ok) console.error("[notify] Telegram error:", await res.text());
  } catch (e) {
    console.error("[notify] Failed to send Telegram message:", e.message);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!RPC_URL)      throw new Error("Missing ARB_SEPOLIA_RPC");
  if (!PRIVATE_KEY)  throw new Error("Missing SETTLER_PRIVATE_KEY");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const prize    = new ethers.Contract(TIMBPRIZE_ADDR, TIMBPRIZE_ABI, wallet);

  // ── Sanity checks ────────────────────────────────────────────────────────

  const started = await prize.gameStarted();
  if (!started) {
    console.log("[settler] Game not started yet — exiting.");
    return;
  }

  const round    = await prize.currentRound();
  const segment  = await prize.currentSegment();
  const remaining = await prize.timeRemainingInSegment();

  console.log(`[settler] Round #${round} | Segment ${segment}/6 | ${remaining}s remaining`);

  if (remaining > 0n) {
    console.log(`[settler] Segment not ready — ${remaining}s left. Exiting.`);
    return;
  }

  // ── Segment ready — settle ────────────────────────────────────────────────

  console.log(`[settler] Segment ready. Calling settleSegment()...`);

  try {
    // Gas config — 130% buffer on fee params (ecosystem pattern)
    const feeData = await provider.getFeeData();
    const maxFeePerGas         = feeData.maxFeePerGas         * 130n / 100n;
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas * 130n / 100n;

    // Estimate gas with 50% buffer
    const gasEstimate = await prize.settleSegment.estimateGas();
    const gasLimit    = gasEstimate * 150n / 100n;

    // Explicit nonce — prevents NONCE_EXPIRED on rapid calls
    const nonce = await provider.getTransactionCount(wallet.address, "pending");

    const tx = await prize.settleSegment({
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasLimit,
      nonce
    });

    console.log(`[settler] Submitted: ${tx.hash}`);
    await notify(`✅ Segment ${segment}/6 settled\nRound #${round}\nTx: \`${tx.hash}\``);

    const receipt = await tx.wait();
    console.log(`[settler] Confirmed in block ${receipt.blockNumber}`);

  } catch (err) {
    const msg = err?.shortMessage || err?.message || String(err);
    console.error(`[settler] settleSegment() failed: ${msg}`);
    await notify(`❌ settleSegment() FAILED\nRound #${round} | Segment ${segment}/6\nError: ${msg}`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error("[settler] Fatal error:", err.message);
  await notify(`💥 Settler fatal error\n${err.message}`);
  process.exit(1);
});
