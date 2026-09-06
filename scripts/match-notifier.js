// match-notifier.js
// TimbSwap match-progress notifications — the hype nudge.
//
// When segment 1 of the current round LOCKS, its winning character is fixed for
// the round. This worker DMs opted-in holders whose ticket's first letter matches
// that locked character — "you're still in the running." It rides the same
// Telegram opt-in registry as the reclaim reminders (supabase/functions/
// telegram-webhook, reclaim_subscribers).
//
// Read-only on-chain; the only side effects are Telegram DMs + a dedupe row.
//   1. If round R's segment 1 isn't locked yet → nothing to do.
//   2. c1 = the locked char of segment 1.
//   3. For each entrant of round R, its LIVE ticket: kept if Active/Pending and
//      string6[0] == c1.
//   4. If the wallet is a subscriber and we haven't already notified it for
//      (wallet, generation, round, segment 1), DM and record it. The matcher set
//      is fixed the instant segment 1 locks, so this is one DM per ticket-round.
//
// Env:
//   ARB_RPC / ARB_SEPOLIA_RPC   RPC (mainnet Arb One at launch)
//   SUPABASE_URL                https://<project>.supabase.co
//   SUPABASE_SERVICE_KEY        service_role key (bypasses RLS)
//   TELEGRAM_BOT_TOKEN          the bot that DMs subscribers
//   TELEGRAM_CHAT_ID            ops alerts (optional)
//   TELEGRAM_BOT_USERNAME       for the in-DM link (optional)
//   COMPETE_URL                 default https://timbswap.xyz/compete

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

const RPC_URL   = process.env.ARB_RPC || process.env.ARB_SEPOLIA_RPC;
const SB_URL    = process.env.SUPABASE_URL;
const SB_KEY    = process.env.SUPABASE_SERVICE_KEY;
const TG_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const TG_OPS    = process.env.TELEGRAM_CHAT_ID;
const BOT_USER  = process.env.TELEGRAM_BOT_USERNAME || "";
const COMPETE   = process.env.COMPETE_URL || "https://timbswap.xyz/compete";

const SEGMENTS_PER_ROUND = 6;
const MATCH_SEGMENT = 1; // first letter

const ST_PENDING = 0n;
const ST_ACTIVE  = 1n;

function addrFromConfig(key) {
  const src = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  const m = src.match(new RegExp("\\b" + key + '\\s*:\\s*"(0x[0-9a-fA-F]{40})"'));
  if (!m) throw new Error(`Address "${key}" not found in config.js — refusing to start notifier`);
  return ethers.getAddress(m[1]);
}

const REGISTRY_ADDR = addrFromConfig("GameRegistry");
const PRIZE_ADDR    = addrFromConfig("TimbPrize");

const REGISTRY_ABI = [
  "function generation() view returns (uint256)",
  "function getRoundEntrants(uint256 round) view returns (address[])",
  "function activeTicketOf(address) view returns (uint256)",
  "function getTicket(uint256 ticketId) view returns (tuple(uint256 id,address owner,bytes6 string6,uint256 playRound,uint256 lastEligibleRound,uint256 escrowAmount,address escrowToken,uint8 status,uint256 supersedes,uint256 supersededBy,uint256 createdAt,uint256 forfeitRound,uint256 generation) t, uint8 displayStatus)",
];

const PRIZE_ABI = [
  "function currentRound() view returns (uint256)",
  "function currentSegment() view returns (uint256)",
  "function gameStarted() view returns (bool)",
  "function segmentDigitLocked(uint256) view returns (bool)",
  "function segmentLockedChar(uint256) view returns (bytes1)",
];

const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

async function tg(chatId, text) {
  if (!TG_TOKEN || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return res.ok;
  } catch (_e) { return false; }
}
const opsNotify = (msg) => tg(TG_OPS, msg);

async function subscriberChat(wallet) {
  const url = `${SB_URL}/rest/v1/reclaim_subscribers?wallet=eq.${wallet}&active=is.true&select=chat_id&limit=1`;
  const res = await fetch(url, { headers: sbHeaders });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0]?.chat_id ?? null;
}

async function alreadyNotified(wallet, gen, round, segment) {
  const url = `${SB_URL}/rest/v1/match_notifications_sent`
    + `?wallet=eq.${wallet}&generation=eq.${gen}&round=eq.${round}&segment=eq.${segment}&select=id&limit=1`;
  const res = await fetch(url, { headers: sbHeaders });
  if (!res.ok) return true; // fail safe: don't double-DM if the ledger is unreadable
  const rows = await res.json();
  return rows.length > 0;
}

async function recordNotification(wallet, gen, round, segment, matchedChar, chatId) {
  await fetch(`${SB_URL}/rest/v1/match_notifications_sent`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({
      wallet, generation: gen.toString(), round: round.toString(),
      segment, matched_char: matchedChar, chat_id: String(chatId),
    }),
  });
}

// bytes1 hex ("0x41") → "A"; bytes6 first byte → "A".
function charOfByte1(b1) {
  const code = parseInt(String(b1).slice(2, 4), 16);
  return code > 0 ? String.fromCharCode(code) : "";
}
function firstCharOfString6(b6) {
  const code = parseInt(String(b6).slice(2, 4), 16);
  return code > 0 ? String.fromCharCode(code) : "";
}

async function main() {
  if (!RPC_URL) throw new Error("Missing ARB_RPC / ARB_SEPOLIA_RPC");
  if (!SB_URL || !SB_KEY) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY");
  if (!TG_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const registry = new ethers.Contract(REGISTRY_ADDR, REGISTRY_ABI, provider);
  const prize    = new ethers.Contract(PRIZE_ADDR, PRIZE_ABI, provider);

  if (!(await prize.gameStarted())) { console.log("[match] game not started — nothing to do."); return; }

  const round = await prize.currentRound();
  const seg   = await prize.currentSegment();

  // Segment 1 must be LOCKED. It locks as the round advances past it; its matcher
  // set is then fixed for the round. Once we're well past it, the early polls have
  // already caught everyone, so skip the re-scan (dedupe still protects us).
  if (!(await prize.segmentDigitLocked(MATCH_SEGMENT))) {
    console.log(`[match] round ${round}: segment 1 not locked yet.`); return;
  }
  if (seg > 4n) { console.log(`[match] round ${round}: past the notify window (segment ${seg}).`); return; }

  const c1byte = await prize.segmentLockedChar(MATCH_SEGMENT);
  const c1 = charOfByte1(c1byte);
  if (!c1) { console.log(`[match] round ${round}: locked char empty — skipping.`); return; }

  const gen = await registry.generation();
  let entrants = [];
  try { entrants = await registry.getRoundEntrants(round); } catch (e) {
    console.warn(`[match] getRoundEntrants(${round}) failed: ${e?.shortMessage || e?.message}`); return;
  }

  const seen = new Set();
  let matched = 0, sent = 0;
  for (const raw of entrants) {
    const w = ethers.getAddress(raw);
    if (seen.has(w)) continue; seen.add(w);

    let id, ticket;
    try {
      id = await registry.activeTicketOf(w);
      if (id === 0n) continue;
      [ticket] = await registry.getTicket(id);
    } catch (e) {
      console.warn(`[match] read failed for ${w}: ${e?.shortMessage || e?.message}`); continue;
    }

    const status = BigInt(ticket.status);
    const live = status === ST_ACTIVE || status === ST_PENDING;
    if (!live) continue;
    if (firstCharOfString6(ticket.string6) !== c1) continue; // first letter must match
    matched++;

    const wallet = w.toLowerCase();
    const chatId = await subscriberChat(wallet);
    if (!chatId) continue;
    if (await alreadyNotified(wallet, gen, round, MATCH_SEGMENT)) continue;

    const link = BOT_USER ? `https://t.me/${BOT_USER}` : COMPETE;
    const text =
      `🎯 First letter matched!\n\n` +
      `Segment 1 locked on "${c1}" this round — and that's your ticket's first ` +
      `letter. You're still in the running with ${SEGMENTS_PER_ROUND - 1} to go.\n\n` +
      `Watch it play out: ${link}`;

    if (await tg(chatId, text)) {
      await recordNotification(wallet, gen, round, MATCH_SEGMENT, c1, chatId);
      sent++;
    }
  }

  console.log(`[match] gen ${gen} round ${round}: seg1='${c1}', ${matched} matching ticket(s), ${sent} notified.`);
  if (sent > 0) await opsNotify(`🎯 Sent ${sent} segment-1 match DM(s) (round ${round}, letter ${c1}).`);
}

main().catch(async (err) => {
  console.error("[match] Fatal:", err.message);
  await opsNotify(`💥 Match-notifier error\n${err.message}`);
  process.exit(1);
});
