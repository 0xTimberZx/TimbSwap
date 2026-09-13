// faucet-worker.js
// TimbSwap faucet keeper — the ONLY thing that touches the faucet hot wallet.
// Runs via GitHub Actions (.github/workflows/faucet.yml). Drains `reserved`
// rows from Supabase `faucet_claims`, calls GasFaucet.dispense(claimant) on the
// TESTNET chain (Arbitrum Sepolia), and resolves each row to `sent` or `failed`.
//
// Mirrors the settler pattern (single sender on one sequential nonce stream,
// config.js as the single source of truth for addresses, Telegram alerts, a
// linger loop so a claim lands within seconds of being reserved). The edge
// function (supabase/functions/faucet-claim) is the gatekeeper and never sends;
// this worker is the sender and re-checks eligibility on-chain before dispensing.
//
// Env (GitHub Actions secrets):
//   ARB_SEPOLIA_RPC                 testnet RPC
//   FAUCET_DISPATCHER_PRIVATE_KEY   the faucet dispatcher hot wallet (set as
//                                   GasFaucet.dispatcher; holds only gas)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   drains faucet_claims (bypasses RLS)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID optional ops alerts
// Vars:
//   FAUCET_LINGER_MINUTES (default 55), FAUCET_POLL_SECONDS (default 12),
//   FAUCET_DRAIN_LIMIT (default 50)

const { ethers }       = require("ethers");
const { createClient } = require("@supabase/supabase-js");
const fs   = require("fs");
const path = require("path");

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC_URL     = process.env.ARB_SEPOLIA_RPC;
const PRIVATE_KEY = process.env.FAUCET_DISPATCHER_PRIVATE_KEY;
const SB_URL      = process.env.SUPABASE_URL;
const SB_SERVICE  = process.env.SUPABASE_SERVICE_KEY;
const TG_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;

const LINGER_BUDGET_MS = Number(process.env.FAUCET_LINGER_MINUTES || 55) * 60 * 1000;
const POLL_MS          = Number(process.env.FAUCET_POLL_SECONDS || 12) * 1000;
const DRAIN_LIMIT      = Number(process.env.FAUCET_DRAIN_LIMIT || 50);

// GasFaucet address from config.js — the single source of truth (see settler.js).
function addrFromConfig(key) {
  const src = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  const m = src.match(new RegExp("\\b" + key + '\\s*:\\s*"(0x[0-9a-fA-F]{40})"'));
  if (!m) throw new Error(`Address "${key}" not found in config.js — refusing to start faucet worker`);
  const a = ethers.getAddress(m[1]);
  if (a === ethers.ZeroAddress) throw new Error(`"${key}" is the zero address in config.js — set the deployed GasFaucet first`);
  return a;
}

// ─── ABI (minimal) ───────────────────────────────────────────────────────────

const FAUCET_ABI = [
  "function dispense(address claimant) external",
  "function claimable(address claimant) external view returns (bool)",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const post = (body) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    let res = await post({ chat_id: TG_CHAT_ID, text, parse_mode: "Markdown" });
    if (!res.ok) { res = await post({ chat_id: TG_CHAT_ID, text }); }
  } catch (e) {
    console.error("[notify] Telegram send failed:", e.message);
  }
}
async function notify(msg) {
  if (!TG_TOKEN || !TG_CHAT_ID) { console.log("[notify]", msg); return; }
  await sendTelegram(`🚰 *TimbSwap Faucet*\n${msg}`);
}

// ─── Supabase (service role, bypasses RLS) ──────────────────────────────────────

let sb;
async function fetchReserved(limit) {
  const { data, error } = await sb
    .from("faucet_claims")
    .select("id,address,ticket_id")
    .eq("status", "reserved")
    .order("reserved_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`fetch reserved failed: ${error.message}`);
  return data || [];
}
async function markSent(id, txHash) {
  const { error } = await sb.from("faucet_claims")
    .update({ status: "sent", wallet_tx: txHash, sent_at: new Date().toISOString() })
    .eq("id", id).eq("status", "reserved");
  if (error) console.error(`[faucet] markSent(${id}) failed: ${error.message}`);
}
async function markFailed(id, reason) {
  const { error } = await sb.from("faucet_claims")
    .update({ status: "failed", error: String(reason).slice(0, 500) })
    .eq("id", id).eq("status", "reserved");
  if (error) console.error(`[faucet] markFailed(${id}) failed: ${error.message}`);
}
async function expireStale() {
  try {
    const { data, error } = await sb.rpc("expire_stale_reservations");
    if (error) throw error;
    if (data) console.log(`[faucet] expired ${data} stale reservation(s)`);
  } catch (e) {
    console.warn(`[faucet] expire_stale_reservations failed: ${e?.message || e}`);
  }
}

// ─── Dispense one claim ─────────────────────────────────────────────────────────

async function dispenseOne(provider, faucet, row, nonce) {
  // Re-check on-chain before spending a tx — the row was reserved off the
  // gatekeeper's read, which may be stale (ticket conceded, cooldown, cap hit).
  const ok = await faucet.claimable(row.address);
  if (!ok) {
    await markFailed(row.id, "not claimable on-chain at dispense time (ticket/cooldown/cap)");
    return { sent: false, nonceUsed: false };
  }

  // Gas config — 130% fee buffer / 150% gas buffer (ecosystem pattern).
  const feeData = await provider.getFeeData();
  const overrides = {
    maxFeePerGas:         feeData.maxFeePerGas         * 130n / 100n,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 130n / 100n,
    nonce,
  };
  try {
    overrides.gasLimit = (await faucet.dispense.estimateGas(row.address)) * 150n / 100n;
  } catch (e) {
    // estimateGas reverts ⇒ the tx would revert; don't spend a nonce/gas on it.
    await markFailed(row.id, e?.shortMessage || e?.message || "dispense would revert");
    return { sent: false, nonceUsed: false };
  }

  const tx = await faucet.dispense(row.address, overrides);
  console.log(`[faucet] dispense ${row.address} → ${tx.hash} (nonce ${nonce})`);
  const receipt = await tx.wait();
  if (receipt.status !== 1) {
    await markFailed(row.id, `dispense tx reverted (${tx.hash})`);
    return { sent: false, nonceUsed: true };
  }
  await markSent(row.id, tx.hash);
  await notify(`✅ Dispensed to \`${row.address}\`\nTx: \`${tx.hash}\``);
  return { sent: true, nonceUsed: true };
}

// ─── Drain the reserved backlog once ────────────────────────────────────────────

async function drainOnce(provider, wallet, faucet) {
  const rows = await fetchReserved(DRAIN_LIMIT);
  if (!rows.length) return 0;
  console.log(`[faucet] draining ${rows.length} reserved claim(s)…`);

  let nonce = await provider.getTransactionCount(wallet.address, "pending");
  let sent = 0;
  for (const row of rows) {
    try {
      const res = await dispenseOne(provider, faucet, row, nonce);
      if (res.nonceUsed) nonce++;
      if (res.sent) sent++;
    } catch (e) {
      const msg = e?.shortMessage || e?.message || String(e);
      console.error(`[faucet] dispense ${row.address} failed: ${msg}`);
      await markFailed(row.id, msg);
      await notify(`❌ Dispense FAILED for \`${row.address}\`\n${msg}`);
      // Refresh nonce in case the failed send consumed/skipped one.
      nonce = await provider.getTransactionCount(wallet.address, "pending");
    }
  }
  return sent;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!RPC_URL)     throw new Error("Missing ARB_SEPOLIA_RPC");
  if (!PRIVATE_KEY) throw new Error("Missing FAUCET_DISPATCHER_PRIVATE_KEY");
  if (!SB_URL || !SB_SERVICE) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY");

  const FAUCET_ADDR = addrFromConfig("GasFaucet");
  sb = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });

  const fetchReq = new ethers.FetchRequest(RPC_URL);
  fetchReq.timeout = Number(process.env.FAUCET_RPC_TIMEOUT_MS || 30_000);
  const provider = new ethers.JsonRpcProvider(fetchReq);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const faucet   = new ethers.Contract(FAUCET_ADDR, FAUCET_ABI, wallet);
  console.log(`[faucet] worker up · GasFaucet ${FAUCET_ADDR} · dispatcher ${wallet.address}`);

  const startedAt = Date.now();
  let totalSent = 0;

  // Housekeeping first: release rows a prior crashed run left `reserved`.
  await expireStale();

  // Linger loop: drain, then poll for new reservations so a claim lands within
  // seconds instead of waiting for the next cron tick. One sender only (workflow
  // concurrency group), so the sequential-nonce stream is never contended.
  for (;;) {
    totalSent += await drainOnce(provider, wallet, faucet);
    if (Date.now() - startedAt + POLL_MS > LINGER_BUDGET_MS) break;
    await sleep(POLL_MS);
  }

  await expireStale();
  console.log(`[faucet] run complete · dispensed ${totalSent} claim(s)`);
}

main().catch(async (err) => {
  console.error("[faucet] Fatal error:", err.message);
  await notify(`💥 Faucet worker fatal error\n${err.message}`);
  process.exit(1);
});
