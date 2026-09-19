// reclaim-reminder.js
// TimbSwap refund reminders — the nudge that makes forfeiture rare.
//
// A ticket's ETH/TIMBS principal is refundable through a generous §14 window
// (LER+4 rounds, LER+6 for a late winner). Past forfeitRound the settler sweeps
// the stake (community-tilted split — see dev-docs/ABANDONED_TICKET_REVENUE.md).
// This worker DMs opt-in holders BEFORE that deadline, so an eventual forfeiture
// only ever happens after the person was clearly reminded.
//
// Read-only on-chain; the only side effect is Telegram DMs + a dedupe row.
//   1. gen + currentRound from GameRegistry.
//   2. Candidate wallets = entrants of the recent play-round buckets.
//   3. For each: its LIVE ticket, kept if Active/Pending, escrow > 0, and
//      forfeitRound within REMIND_LEAD_ROUNDS of currentRound.
//   4. If the wallet is a subscriber and we haven't already reminded it for this
//      exact (wallet, generation, forfeitRound), DM the linked chat and record it.
//
// Opt-in is handled entirely by the Telegram bot (supabase/functions/
// telegram-webhook) via a /start <wallet> deep link; this worker only reads the
// registry with the service-role key.
//
// Env:
//   ARB_RPC / ARB_SEPOLIA_RPC   RPC (mainnet Arb One at launch)
//   SUPABASE_URL                https://<project>.supabase.co
//   SUPABASE_SERVICE_KEY        service_role key (bypasses RLS)
//   TELEGRAM_BOT_TOKEN          the bot that DMs subscribers
//   TELEGRAM_CHAT_ID            ops alerts (optional)
//   TELEGRAM_BOT_USERNAME       for the reclaim deep link (optional; else generic)
//   REMIND_LEAD_ROUNDS          default 2  (remind when forfeit is ≤ this many rounds out)
//   SCAN_BACK_ROUNDS            default 8  (how many recent play-round buckets to scan)
//   COMPETE_URL                 default https://timbswap.xyz/compete
//   REMIND_LINGER_MINUTES       default 55; 0 = a single pass and exit
//   REMIND_POLL_SECONDS         default 60  (how often the round number is checked)
//   REMIND_RESCAN_SECONDS       default 900 (full pass even if the round has not moved)
//
// Pacing: one run LINGERS and self-chains (like the settler, the faucet, and
// the match notifier) because GitHub fires an hourly cron late and unevenly —
// the fleet heartbeat measured this job's runs up to three hours apart. A
// ticket's at-risk status only changes when the round advances, so the loop
// polls currentRound cheaply every REMIND_POLL_SECONDS and runs the full
// entrant walk when the round moves, plus every REMIND_RESCAN_SECONDS to catch
// a holder who opted in mid-round. Reminders therefore land minutes after a
// rollover instead of up to an hour (or three) later.

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

const RPC_URL   = process.env.ARB_RPC || process.env.ARB_SEPOLIA_RPC;
const SB_URL    = process.env.SUPABASE_URL;
const SB_KEY    = process.env.SUPABASE_SERVICE_KEY;
const TG_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const TG_OPS    = process.env.TELEGRAM_CHAT_ID;
const BOT_USER  = process.env.TELEGRAM_BOT_USERNAME || "";
const LEAD      = Number(process.env.REMIND_LEAD_ROUNDS || 2);
const SCAN_BACK = Number(process.env.SCAN_BACK_ROUNDS || 8);
const COMPETE   = process.env.COMPETE_URL || "https://timbswap.xyz/compete";

// Ticket status enum: Pending=0, Active=1, Conceded=2, Ineligible=3, …
const ST_PENDING = 0n;
const ST_ACTIVE  = 1n;

function addrFromConfig(key) {
  const src = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  const m = src.match(new RegExp("\\b" + key + '\\s*:\\s*"(0x[0-9a-fA-F]{40})"'));
  if (!m) throw new Error(`Address "${key}" not found in config.js — refusing to start reminder`);
  return ethers.getAddress(m[1]);
}

const REGISTRY_ADDR = addrFromConfig("GameRegistry");

const REGISTRY_ABI = [
  "function generation() view returns (uint256)",
  "function currentRound() view returns (uint256)",
  "function getRoundEntrants(uint256 round) view returns (address[])",
  "function activeTicketOf(address) view returns (uint256)",
  "function getTicket(uint256 ticketId) view returns (tuple(uint256 id,address owner,bytes6 string6,uint256 playRound,uint256 lastEligibleRound,uint256 escrowAmount,address escrowToken,uint8 status,uint256 supersedes,uint256 supersededBy,uint256 createdAt,uint256 forfeitRound,uint256 generation) t, uint8 displayStatus)",
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

// Active subscriber for a wallet → its chat_id, or null.
async function subscriberChat(wallet) {
  const url = `${SB_URL}/rest/v1/reclaim_subscribers?wallet=eq.${wallet}&active=is.true&select=chat_id&limit=1`;
  const res = await fetch(url, { headers: sbHeaders });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0]?.chat_id ?? null;
}

// Have we already reminded (wallet, gen, forfeitRound)?
async function alreadyReminded(wallet, gen, forfeitRound) {
  const url = `${SB_URL}/rest/v1/reclaim_reminders_sent`
    + `?wallet=eq.${wallet}&generation=eq.${gen}&forfeit_round=eq.${forfeitRound}&select=id&limit=1`;
  const res = await fetch(url, { headers: sbHeaders });
  if (!res.ok) return true; // fail safe: don't double-DM if the ledger is unreadable
  const rows = await res.json();
  return rows.length > 0;
}

async function recordReminder(wallet, gen, forfeitRound, chatId) {
  await fetch(`${SB_URL}/rest/v1/reclaim_reminders_sent`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({ wallet, generation: gen.toString(), forfeit_round: forfeitRound.toString(), chat_id: String(chatId) }),
  });
}

function reclaimLink(wallet) {
  // A deep link back to the bot keeps the CTA in-thread; fall back to the site.
  return BOT_USER ? `https://t.me/${BOT_USER}` : COMPETE;
}

// `||`, not `??`: the workflow passes an UNSET repo variable as an empty string,
// which `??` keeps and Number("") turns into 0 — a zero-minute linger that
// exits at once and, with a dispatch token present, chains runs back to back.
// An explicit "0" is a non-empty string, so it still means a single pass.
const LINGER_MS = Number(process.env.REMIND_LINGER_MINUTES || 55) * 60 * 1000;
const POLL_MS   = Number(process.env.REMIND_POLL_SECONDS   || 60) * 1000;
const RESCAN_MS = Number(process.env.REMIND_RESCAN_SECONDS || 900) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One full pass: walk the recent round buckets and DM the at-risk subscribers. */
async function pass(registry, gen, cr) {

  // Gather candidate wallets from the recent play-round buckets. A ticket that
  // plays round r has forfeitRound r+4 (or r+6 if it won late), so the buckets
  // whose stakes are about to lapse sit a few rounds back from currentRound.
  const from = cr > BigInt(SCAN_BACK) ? cr - BigInt(SCAN_BACK) : 1n;
  const wallets = new Set();
  for (let r = from; r <= cr; r++) {
    try {
      const entrants = await registry.getRoundEntrants(r);
      for (const w of entrants) wallets.add(ethers.getAddress(w));
    } catch (e) {
      console.warn(`[reminder] getRoundEntrants(${r}) failed: ${e?.shortMessage || e?.message}`);
    }
  }

  let atRisk = 0, sent = 0;
  for (const w of wallets) {
    let id, ticket;
    try {
      id = await registry.activeTicketOf(w);
      if (id === 0n) continue;
      [ticket] = await registry.getTicket(id);
    } catch (e) {
      console.warn(`[reminder] read failed for ${w}: ${e?.shortMessage || e?.message}`);
      continue;
    }

    const status = BigInt(ticket.status);
    const escrow = BigInt(ticket.escrowAmount);
    const forfeit = BigInt(ticket.forfeitRound);
    const live = status === ST_ACTIVE || status === ST_PENDING;

    // Refund still claimable AND the deadline is within the lead window.
    const rounds = forfeit > cr ? forfeit - cr : 0n;
    if (!live || escrow === 0n || rounds === 0n || rounds > BigInt(LEAD)) continue;
    atRisk++;

    const wallet = w.toLowerCase();
    const chatId = await subscriberChat(wallet);
    if (!chatId) continue;                                   // not opted in
    if (await alreadyReminded(wallet, gen, forfeit)) continue;

    const isEth = ticket.escrowToken === ethers.ZeroAddress;
    const amount = isEth
      ? `${ethers.formatEther(escrow)} ETH`
      : `${ethers.formatEther(escrow)} TIMBS`;
    const roundWord = rounds === 1n ? "round" : "rounds";
    const text =
      `⏳ TimbSwap refund reminder\n\n` +
      `Your ticket's principal (${amount}) is refundable now, but the window ` +
      `closes in ${rounds} ${roundWord} (round ${forfeit}; it's round ${cr} now).\n\n` +
      `Reclaim it before then so it isn't swept: ${reclaimLink(wallet)}\n` +
      `Send /stop to turn these off.`;

    if (await tg(chatId, text)) {
      await recordReminder(wallet, gen, forfeit, chatId);
      sent++;
    }
  }

  console.log(`[reminder] gen ${gen} round ${cr}: ${wallets.size} candidates, ${atRisk} at-risk, ${sent} reminded.`);
  if (sent > 0) await opsNotify(`🕒 Sent ${sent} reclaim reminder(s) (round ${cr}).`);
}

async function main() {
  if (!RPC_URL) throw new Error("Missing ARB_RPC / ARB_SEPOLIA_RPC");
  if (!SB_URL || !SB_KEY) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY");
  if (!TG_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const registry = new ethers.Contract(REGISTRY_ADDR, REGISTRY_ABI, provider);

  const startedAt = Date.now();
  let polls = 0, passes = 0, failures = 0, lastError = null;
  let lastKey = null, lastPassAt = 0;   // gen:round of the last full pass, and when

  for (;;) {
    try {
      const gen = await registry.generation();
      const cr  = await registry.currentRound();
      polls++;
      if (cr === 0n) {
        console.log("[reminder] game not started — nothing to do.");
      } else {
        const key = `${gen}:${cr}`;
        const since = Date.now() - lastPassAt;
        if (key !== lastKey || since >= RESCAN_MS) {
          await pass(registry, gen, cr);
          passes++;
          lastKey = key; lastPassAt = Date.now();
        } else {
          console.log(`[reminder] round ${cr}: walked ${Math.round(since / 1000)}s ago, next full pass in ${Math.round((RESCAN_MS - since) / 1000)}s or at rollover`);
        }
      }
    } catch (err) {
      failures++;
      lastError = err?.shortMessage || err?.message || String(err);
      console.error(`[reminder] poll failed: ${lastError}`);
      if (failures === 1) await opsNotify(`💥 Reclaim-reminder poll failed (lingering on)\n${lastError}`);
    }

    if (Date.now() - startedAt + POLL_MS > LINGER_MS) break;
    await sleep(POLL_MS);
  }

  console.log(`[reminder] linger done: ${polls} poll(s), ${passes} full pass(es), ${failures} failure(s).`);
  // Every poll failed: exit non-zero so the workflow does NOT self-chain and the
  // cron backstop takes over — a broken RPC must not perpetuate itself.
  if (polls === 0 && failures > 0) throw new Error(`all polls failed: ${lastError}`);
}

main().catch(async (err) => {
  console.error("[reminder] Fatal:", err.message);
  await opsNotify(`💥 Reclaim-reminder error\n${err.message}`);
  process.exit(1);
});
