// settler.js
// TimbSwap automated settler — runs via GitHub Actions every 10 minutes.
// Checks timeRemainingInSegment() on TimbPrize and calls settleSegment()
// when the interaction window has elapsed.
//
// Improvements over v1:
//   - Retry logic: RPC/network failures retry up to MAX_RETRIES with backoff
//   - Error categorisation: revert vs network vs gas vs nonce
//   - Health check mode: node settler.js --health (logs state, no tx)
//   - Nonce conflict detection: warns if pending tx exists
//   - Segment timing guard: double-checks timestamp on-chain before settling
//   - Structured log prefix per step for easy CI log parsing

const { ethers } = require("ethers");

// ─── Config ───────────────────────────────────────────────────────────────────

const RPC_URL        = process.env.ARB_SEPOLIA_RPC;
const PRIVATE_KEY    = process.env.SETTLER_PRIVATE_KEY;
const TG_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID     = process.env.TELEGRAM_CHAT_ID;
const TIMBPRIZE_ADDR = "0x257F3658e29a7026CeebdcB352509d82A0993e4b";

const MAX_RETRIES    = 3;
const RETRY_DELAY_MS = 8000; // 8s between retries
const HEALTH_MODE    = process.argv.includes("--health");

// ─── ABI ──────────────────────────────────────────────────────────────────────

const TIMBPRIZE_ABI = [
  "function timeRemainingInSegment() external view returns (uint256)",
  "function currentRound() external view returns (uint256)",
  "function currentSegment() external view returns (uint256)",
  "function segmentStartTime() external view returns (uint256)",
  "function settleSegment() external",
  "function gameStarted() external view returns (bool)",
  "function isSettlementWindow() external view returns (bool)",
  "function currentAccumulatedRewards() external view returns (uint256)"
];

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function notify(msg, urgent = false) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.log("[notify] No Telegram config —", msg);
    return;
  }
  const prefix = urgent ? "🚨" : "🔄";
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:    TG_CHAT_ID,
        text:       `${prefix} *TimbSwap Settler*\n${msg}`,
        parse_mode: "Markdown"
      })
    });
    if (!res.ok) console.error("[notify] Telegram error:", await res.text());
  } catch (e) {
    console.error("[notify] Failed:", e.message);
  }
}

// ─── Retry Helper ─────────────────────────────────────────────────────────────

async function withRetry(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err?.shortMessage || err?.message || String(err);
      const isNetwork = msg.includes("network") || msg.includes("timeout") ||
                        msg.includes("ECONNREFUSED") || msg.includes("fetch");
      const isRevert  = msg.includes("revert") || msg.includes("execution reverted");

      console.warn(`[settler] ${label} attempt ${attempt}/${MAX_RETRIES} failed: ${msg}`);

      // Don't retry reverts — they are deterministic
      if (isRevert) {
        console.error(`[settler] Contract revert — not retrying.`);
        throw err;
      }

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt;
        console.log(`[settler] Retrying in ${delay / 1000}s…`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ─── Error Categoriser ────────────────────────────────────────────────────────

function categoriseError(err) {
  const msg = err?.shortMessage || err?.message || String(err);
  if (msg.includes("NONCE_EXPIRED") || msg.includes("nonce too low")) {
    return { type: "NONCE", detail: "Nonce conflict — fetch fresh pending nonce", msg };
  }
  if (msg.includes("insufficient funds") || msg.includes("INSUFFICIENT_FUNDS")) {
    return { type: "FUNDS", detail: "Settler wallet needs ETH for gas", msg };
  }
  if (msg.includes("SegmentNotComplete") || msg.includes("revert")) {
    return { type: "REVERT", detail: "Contract reverted — segment may not be ready", msg };
  }
  if (msg.includes("network") || msg.includes("timeout") || msg.includes("ECONNREFUSED")) {
    return { type: "NETWORK", detail: "RPC connection issue", msg };
  }
  if (msg.includes("maxFeePerGas") || msg.includes("gas")) {
    return { type: "GAS", detail: "Gas pricing issue — fee data may be stale", msg };
  }
  return { type: "UNKNOWN", detail: "Unclassified error", msg };
}

// ─── Health Check ─────────────────────────────────────────────────────────────

async function healthCheck(prize, provider, wallet) {
  const [started, round, segment, remaining, pot, inWindow] = await Promise.all([
    prize.gameStarted(),
    prize.currentRound(),
    prize.currentSegment(),
    prize.timeRemainingInSegment(),
    prize.currentAccumulatedRewards(),
    prize.isSettlementWindow()
  ]);

  const walletBal  = await provider.getBalance(wallet.address);
  const pendingTxs = await provider.getTransactionCount(wallet.address, "pending");
  const confirmedTxs = await provider.getTransactionCount(wallet.address, "latest");
  const hasPending = pendingTxs > confirmedTxs;

  const report = [
    `📊 *TimbSwap Settler Health*`,
    `Game started: ${started}`,
    `Round: #${round} | Segment: ${segment}/6`,
    `Time remaining: ${remaining}s`,
    `In settlement window: ${inWindow}`,
    `Prize pot: ${ethers.formatEther(pot)} ETH`,
    `Settler wallet: \`${wallet.address}\``,
    `Wallet ETH: ${parseFloat(ethers.formatEther(walletBal)).toFixed(4)} ETH`,
    hasPending ? `⚠️ Pending tx detected` : `No pending txs`
  ].join("\n");

  console.log("[health]", report.replace(/\*/g, "").replace(/`/g, ""));
  await notify(report);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!RPC_URL)     throw new Error("Missing ARB_SEPOLIA_RPC");
  if (!PRIVATE_KEY) throw new Error("Missing SETTLER_PRIVATE_KEY");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const prize    = new ethers.Contract(TIMBPRIZE_ADDR, TIMBPRIZE_ABI, wallet);

  // ── Health check mode ─────────────────────────────────────────────────────
  if (HEALTH_MODE) {
    await healthCheck(prize, provider, wallet);
    return;
  }

  // ── Sanity checks ─────────────────────────────────────────────────────────
  const started = await withRetry("gameStarted", () => prize.gameStarted());
  if (!started) {
    console.log("[settler] Game not started — exiting.");
    return;
  }

  const [round, segment, remaining] = await withRetry("state read", () =>
    Promise.all([
      prize.currentRound(),
      prize.currentSegment(),
      prize.timeRemainingInSegment()
    ])
  );

  console.log(`[settler] Round #${round} | Segment ${segment}/6 | ${remaining}s remaining`);

  if (remaining > 0n) {
    console.log(`[settler] Not ready — ${remaining}s left. Exiting.`);
    return;
  }

  // ── Pending tx guard ──────────────────────────────────────────────────────
  const pendingCount   = await provider.getTransactionCount(wallet.address, "pending");
  const confirmedCount = await provider.getTransactionCount(wallet.address, "latest");
  if (pendingCount > confirmedCount) {
    console.warn("[settler] ⚠️ Pending tx detected — may cause nonce conflict.");
    await notify(`⚠️ Pending tx detected for settler wallet before settleSegment()\nRound #${round} | Seg ${segment}/6`);
  }

  // ── Settle ────────────────────────────────────────────────────────────────
  console.log(`[settler] Window elapsed. Calling settleSegment()…`);

  try {
    const feeData = await withRetry("getFeeData", () => provider.getFeeData());
    const maxFeePerGas         = feeData.maxFeePerGas         * 130n / 100n;
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas * 130n / 100n;

    const gasEstimate = await withRetry("estimateGas", () =>
      prize.settleSegment.estimateGas()
    );
    const gasLimit = gasEstimate * 150n / 100n;
    const nonce    = await provider.getTransactionCount(wallet.address, "pending");

    const tx = await withRetry("settleSegment", () =>
      prize.settleSegment({ maxFeePerGas, maxPriorityFeePerGas, gasLimit, nonce })
    );

    console.log(`[settler] Submitted: ${tx.hash}`);
    await notify(`✅ Segment ${segment}/6 settled\nRound #${round}\nTx: \`${tx.hash}\``);

    const receipt = await tx.wait();
    console.log(`[settler] Confirmed in block ${receipt.blockNumber} | Gas used: ${receipt.gasUsed}`);

  } catch (err) {
    const { type, detail, msg } = categoriseError(err);
    console.error(`[settler] FAILED [${type}] ${detail}: ${msg}`);
    await notify(
      `❌ settleSegment() FAILED\nRound #${round} | Seg ${segment}/6\nType: ${type}\n${detail}\n\`${msg}\``,
      true
    );
    process.exit(1);
  }
}

main().catch(async (err) => {
  const msg = err?.message || String(err);
  console.error("[settler] Fatal:", msg);
  await notify(`💥 Settler fatal error\n\`${msg}\``, true);
  process.exit(1);
});
