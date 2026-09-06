// settler.js
// TimbSwap automated settler — runs via GitHub Actions every 10 minutes.
// Checks timeRemainingInSegment() on TimbPrize and calls settleSegment()
// when the interaction window has elapsed.
//
// H1 (VRF): settling a due segment now takes TWO settleSegment() calls. The
// first ARMS it — fires one Chainlink VRF request and returns without advancing
// (the winning char must not be knowable while the segment can still be nudged).
// Once the VRF callback lands, a second call LOCKS the char from the word and
// advances (segment N -> N+1), or — when the current segment is the 6th — runs
// the full round-boundary chain in one atomic transaction: lock the final digit,
// build the winning string, distribute the pot, then reset ALL 6 digit
// counters/locks and start the next round's segment 1 with a fresh
// segmentStartTime. This script drives that arm → wait-for-word → lock cycle and
// re-requests a draw that stalls past the module's re-request delay.
//
// The previous version of this script only ever made ONE such call per run
// and exited. If a run was skipped, delayed, or this job was paused for a
// stretch, multiple segments (or a segment PLUS the round rollover) could
// go overdue at once. On the next run, settling just one of them and
// exiting left the rest still overdue — from the UI it reads as "the meter
// never reset," because the round-boundary call (the one that actually
// zeroes every counter back to 'A') may not be the call that happens to run
// next. This version drains the whole backlog in a single job run: it loops
// calling settleSegment() while a segment is overdue, so a lagging chain of
// events (including a round rollover) resolves as one connected sequence
// instead of trickling out over several 10-minute cron ticks.
//
// It also LINGERS: GitHub throttles the */10 cron to ~hourly in practice,
// and while a segment sits unsettled the whole game is stuck in its
// settlement window (nudges revert on-chain). Rather than exit when the
// segment isn't due, the run sleeps until the boundary and settles within
// seconds of it (budgeted by SETTLER_LINGER_MINUTES, default 65, enforced
// alongside the workflow's timeout + a concurrency group so overlapping
// scheduled runs queue instead of double-settling).

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");
const { postRoundToX } = require("./xposter");

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC_URL       = process.env.ARB_SEPOLIA_RPC;
const PRIVATE_KEY   = process.env.SETTLER_PRIVATE_KEY;
const TG_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID    = process.env.TELEGRAM_CHAT_ID;        // ops: every message, incl. failures
const TG_CHAT_ID_PUBLIC = process.env.TELEGRAM_CHAT_ID_PUBLIC; // community group: round rollovers only
// Contract addresses come straight from config.js — the single source of
// truth the frontend already uses — so a redeploy only ever needs config.js
// edited and the settler follows automatically (no more drifting hardcodes).
// config.js isn't Node-requireable (it touches window/document at load), so we
// read it as text and pull the address out of its ADDRESSES map. Fails LOUD if
// a key is missing/malformed rather than silently settling the wrong contract.
function addrFromConfig(key) {
  const src = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  const m = src.match(new RegExp("\\b" + key + '\\s*:\\s*"(0x[0-9a-fA-F]{40})"'));
  if (!m) throw new Error(`Address "${key}" not found in config.js — refusing to start settler`);
  return ethers.getAddress(m[1]); // checksum-normalize (ethers v6); throws on a bad address
}

const TIMBPRIZE_ADDR    = addrFromConfig("TimbPrize");
const GAMEREGISTRY_ADDR = addrFromConfig("GameRegistry");

// ─── ABI (minimal) ───────────────────────────────────────────────────────────

const TIMBPRIZE_ABI = [
  "function timeRemainingInSegment() external view returns (uint256)",
  "function currentRound() external view returns (uint256)",
  "function currentSegment() external view returns (uint256)",
  "function segmentStartTime() external view returns (uint256)",
  "function settleSegment() external",
  "function gameStarted() external view returns (bool)",
  // H1: prize entropy is now VRF. settleSegment() is arm-then-lock — the first
  // due call ARMS (fires the request, no advance), a later call LOCKS + advances
  // once the callback has landed. These expose the entropy address + salt so the
  // keeper can poll readiness and re-request a stalled draw.
  "function entropy() external view returns (address)",
  "function saltFor(uint256 round, uint256 segment) external pure returns (bytes32)",
  "function rearmSegment() external",
  "function getRoundResult(uint256 round) external view returns (bytes6 winningString, uint256 potAmount, address[] winners, uint256 perWinner, uint256 remainder)"
];

// H1: the prize game's dedicated VRFEntropy module (read-only, from the keeper).
const ENTROPY_ABI = [
  "function isReady(bytes32 salt) external view returns (bool)",
  "function isRequested(bytes32 salt) external view returns (bool)",
  "function replaceable(bytes32 salt) external view returns (bool)"
];

const GAMEREGISTRY_ABI = [
  "function getRoundEntrants(uint256 round) external view returns (address[])",
  // H2: paginated post-settlement bookkeeping the keeper drains after a rollover.
  "function generation() external view returns (uint256)",
  "function settleDone(uint256 gen, uint256 round) external view returns (bool)",
  "function onRoundSettled(uint256 settledRound, uint256 maxSteps) external returns (bool)",
  "function activateRoundEntries(uint256 round, address[] players) external"
];

// Entrants processed per drain tx. Small enough to always fit gas; the keeper
// loops until the round is fully drained.
const DRAIN_CHUNK = Number(process.env.SETTLE_DRAIN_CHUNK || 100);

// bytes6 hex ("0x4B375857 32 51") -> "K7XW2Q"
function bytes6ToStr(b6) {
  if (!b6 || b6 === "0x000000000000") return "??????";
  let s = "";
  for (let i = 2; i < 14; i += 2) {
    const code = parseInt(b6.slice(i, i + 2), 16);
    if (code > 0) s += String.fromCharCode(code);
  }
  return s;
}

// ─── Segment-delay alerting ──────────────────────────────────────────────────
// A segment is 60:00 on the grid (59:45 interaction + 0:15 intermission).
// If a rollover is still pending past these marks, tell Telegram how bad:
//   > 60:05 (5s past the grid mark)  → ⚠️ slightly later
//   > 60:30 (30s past the grid mark) → 🚨 critically delayed
const SEGMENT_TOTAL_S    = 60 * 60; // 60:00 grid slot
const DELAY_SLIGHT_S     = 5;
const DELAY_CRITICAL_S   = 30;

/** Alert (tiered) if this overdue segment blew past the 60:00 grid mark. */
async function alertIfDelayed(prize, round, segment) {
  try {
    const startTs  = await prize.segmentStartTime();
    const lateness = Math.floor(Date.now() / 1000) - (Number(startTs) + SEGMENT_TOTAL_S);
    if (lateness > DELAY_CRITICAL_S) {
      await notify(
        `🚨 CRITICALLY DELAYED segment\nRound #${round} | Segment ${segment}/6 ran ` +
        `${lateness}s past its 60:00 mark before settling. The keeper (or any ` +
        `interaction) didn't land in time — check GitHub cron health.`
      );
    } else if (lateness > DELAY_SLIGHT_S) {
      await notify(
        `⚠️ Slightly later segment\nRound #${round} | Segment ${segment}/6 ran ` +
        `${lateness}s past its 60:00 mark before settling.`
      );
    }
    return lateness;
  } catch (e) {
    console.warn(`[settler] delay check failed: ${e?.message || e}`);
    return null;
  }
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(chatId, text) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const post = (body) => fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  try {
    let res = await post({ chat_id: chatId, text, parse_mode: "Markdown" });
    if (!res.ok) {
      // Markdown parsing chokes on error dumps ( _ * [ ] etc. from an RPC error
      // JSON), which previously dropped the alert entirely — so a FATAL failure
      // (e.g. an RPC 403) went unnoticed. Resend as plain text so critical
      // alerts are never silently lost.
      const err = await res.text();
      console.error("[notify] Telegram Markdown send failed, retrying plain text:", err);
      res = await post({ chat_id: chatId, text });
      if (!res.ok) console.error("[notify] Telegram plain-text send error:", await res.text());
    }
  } catch (e) {
    console.error("[notify] Failed to send Telegram message:", e.message);
  }
}

// Ops stream — every settle, delay alert, and failure goes here (private DM).
async function notify(msg) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.log("[notify] No Telegram config:", msg);
    return;
  }
  await sendTelegram(TG_CHAT_ID, `🔄 *TimbSwap Settler*\n${msg}`);
}

// Community stream — only clean, exciting beats (round rollovers), sent to
// the public group AFTER the tx confirms. Optional: silently skipped when
// TELEGRAM_CHAT_ID_PUBLIC isn't configured. Never carries ops/error detail.
async function notifyPublic(msg) {
  if (!TG_TOKEN || !TG_CHAT_ID_PUBLIC) return;
  await sendTelegram(TG_CHAT_ID_PUBLIC, msg);
}

// Hard cap on settle calls per run — a ~340-min run covers up to 6 live
// boundaries, plus a backlogged round on arrival; 14 bounds the loop
// without ever cutting a healthy run short.
const MAX_SETTLES_PER_RUN = 14;

// ─── Linger mode ─────────────────────────────────────────────────────────────
// GitHub throttles the */10 cron to roughly hourly in practice, and the
// nominal 15-second settlement window really lasts "until this script lands
// a settle" — during which nudging is blocked on-chain. So instead of
// exiting when the segment isn't ready, the run stays alive and sleeps
// until the segment boundary, settles within seconds of it, then looks for
// the next boundary inside its budget. This turns an up-to-an-hour dead
// window into a few seconds.
//
// The budget must EXCEED one full segment (59:45): a run landing right
// after a boundary sees ~59.8 min remaining, and with a smaller budget it
// bails instead of covering that boundary (observed live: 3454s remaining
// vs the original 55-min budget).
//
// Originally 65 min — one boundary per run, handing off to the next cron
// tick. GitHub then left a 2.4-hour cron hole and Round 2 segment 1 ran
// 8734s past its 60:00 mark before anything settled it. Each run now
// lingers up to ~340 min (GitHub-hosted jobs cap at 6 h), covering ~5
// hourly boundaries back-to-back, so a single missed cron tick no longer
// strands the game — the previous run is still alive and settling.
const LINGER_BUDGET_MS =
  Number(process.env.SETTLER_LINGER_MINUTES || 340) * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// H1: how long to wait between polling the VRF for a just-armed segment's word.
// The callback lands a few blocks after the request (typically ~5-15s on Arb
// Sepolia), so a tight poll locks within seconds of fulfillment instead of
// adding up to a full interval of dead wait on top. Each poll is a couple of
// cheap eth_calls over a short per-segment window, so 5s is comfortable; the
// run's linger budget still bounds the total wait. Override with
// SETTLER_VRF_POLL_SECONDS if a flakier RPC needs backing off.
const VRF_POLL_MS = Number(process.env.SETTLER_VRF_POLL_SECONDS || 5) * 1000;

// Shared tx plumbing for settleSegment() — used by BOTH the arm and the lock
// call (H1). Returns the confirmed receipt.
async function sendSettleSegment(provider, wallet, prize) {
  // Gas config — 130% buffer on fee params (ecosystem pattern)
  const feeData = await provider.getFeeData();
  const maxFeePerGas         = feeData.maxFeePerGas         * 130n / 100n;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas * 130n / 100n;

  // Estimate gas with 50% buffer
  const gasEstimate = await prize.settleSegment.estimateGas();
  const gasLimit    = gasEstimate * 150n / 100n;

  // Explicit nonce — prevents NONCE_EXPIRED on rapid back-to-back calls
  const nonce = await provider.getTransactionCount(wallet.address, "pending");

  const tx = await prize.settleSegment({
    maxFeePerGas,
    maxPriorityFeePerGas,
    gasLimit,
    nonce
  });
  console.log(`[settler] Submitted: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`[settler] Confirmed in block ${receipt.blockNumber}`);
  return { tx, receipt };
}

// H1: ARM the due segment — fires the VRF request. No advance happens here; the
// segment locks on a later call once the word lands. Kept quiet on the public
// channel (it is not a settlement), ops-noted only.
async function armSegment(provider, wallet, prize, round, segment) {
  console.log(`[settler] Arming round #${round} segment ${segment}/6 (VRF request)…`);
  const { tx } = await sendSettleSegment(provider, wallet, prize);
  await notify(`🎲 Armed segment ${segment}/6 (round #${round}) — awaiting VRF word\nTx: \`${tx.hash}\``);
}

// H1: LOCK the due segment — the word has landed, so this call locks the char
// and advances (or, on segment 6, rolls the round). This is the settlement event.
async function settleOnce(provider, wallet, prize, round, segment) {
  // segment 6 -> _settleRound(): builds the winning string, pays out,
  // expires old entries, and resets every counter for the next round.
  // Everything else is a plain single-segment advance.
  const isRoundBoundary = segment === 6n;

  const { tx } = await sendSettleSegment(provider, wallet, prize);
  await notify(
    isRoundBoundary
      ? `✅ Round #${round} settled (segment 6/6) — round #${round + 1n} starting fresh\nTx: \`${tx.hash}\``
      : `✅ Segment ${segment}/6 settled\nRound #${round}\nTx: \`${tx.hash}\``
  );

  // Community beat: announce the rollover in the public group only once the
  // round is actually settled on-chain (~every 6h, not the hourly segments).
  if (isRoundBoundary) {
    await notifyPublic(
      `📜 *Round #${round} has settled!*\n` +
      `The winning string is locked and the pot has been paid out on-chain.\n\n` +
      `🟢 Round #${round + 1n} is live — a fresh pot is building right now.\n` +
      `Enter or nudge the scroll → timbswap.xyz/compete`
    );

    // X post (opt-in via X_* secrets; see xposter.js). Fully fenced — a
    // failed read or post never affects settlement or the next loop turn.
    try {
      const registry = new ethers.Contract(GAMEREGISTRY_ADDR, GAMEREGISTRY_ABI, provider);
      const [res, entrants] = await Promise.all([
        prize.getRoundResult(round),
        registry.getRoundEntrants(round).catch(() => [])
      ]);
      const potEth = Number(ethers.formatEther(res.potAmount ?? res[1])).toFixed(4).replace(/\.?0+$/, "") || "0";
      await postRoundToX({
        round:   Number(round),
        string6: bytes6ToStr(res.winningString ?? res[0]),
        entries: entrants.length,
        potEth,
        winners: (res.winners ?? res[2]).length
      });
    } catch (e) {
      console.warn("[xposter] round post skipped:", e?.message || e);
    }
  }
  return isRoundBoundary;
}

// The deployed (pre-gen-3) GameRegistry gates activateRoundEntries behind
// onlyTimbPrize, so the keeper's call reverts NotTimbPrize() (selector
// 0x3e94dce9). There is nothing the keeper can do about it until the gen-3
// migration lands (dev-docs/GEN3_MIGRATION.md) — so log it, but do NOT page ops
// on every run. Any OTHER revert still alerts. Delete this guard once migrated.
function _isNotTimbPrizeRevert(e) {
  try {
    const s = JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    return /0x3e94dce9/i.test(s) || /NotTimbPrize/i.test(s);
  } catch {
    return /NotTimbPrize/i.test(e?.message || "");
  }
}

// ─── H2: drain paginated settlement bookkeeping after a rollover ────────────────
// TimbPrize advances the round O(1) and no longer runs expiry/forfeiture/
// activation inline (a sybil flood could OOG-freeze that). The keeper drains
// them here in bounded chunks. All calls are permissionless + idempotent, so a
// partial drain simply resumes next run — settlement is never blocked.
async function drainSettlement(registry, settledRound, newRound) {
  let gen;
  try { gen = await registry.generation(); } catch { gen = 0n; }

  // 1. Expiry + forfeiture of the just-settled round, chunk by chunk.
  for (let i = 0; i < 500; i++) {
    try {
      if (await registry.settleDone(gen, settledRound)) break;
      await (await registry.onRoundSettled(settledRound, DRAIN_CHUNK)).wait();
    } catch (e) {
      const msg = e?.shortMessage || e?.message || String(e);
      console.warn(`[settler] onRoundSettled(${settledRound}) drain paused: ${msg}`);
      await notify(`⚠️ Settler drain paused — onRoundSettled(#${settledRound})\n${msg}\nExpiry/forfeiture bookkeeping is incomplete; will retry next run.`);
      break;
    }
  }

  // 2. Activate the new round's entrants (idempotent, gated to currentRound).
  let entrants = [];
  // Plain, mutable copy of plain strings — see healCurrentRoundActivation: the
  // ethers v6 Result returned by getRoundEntrants is a FROZEN array, and passing
  // it (or slices of it) as `players` makes ethers throw "Cannot assign to read
  // only property" when it normalizes the addresses in place.
  try { entrants = Array.from(await registry.getRoundEntrants(newRound), (a) => String(a)); } catch {}
  for (let i = 0; i < entrants.length; i += DRAIN_CHUNK) {
    const chunk = entrants.slice(i, i + DRAIN_CHUNK);
    try {
      await (await registry.activateRoundEntries(newRound, chunk)).wait();
    } catch (e) {
      const msg = e?.shortMessage || e?.message || String(e);
      if (_isNotTimbPrizeRevert(e)) {
        console.warn(`[settler] activateRoundEntries(${newRound}) skipped: registry gates it to TimbPrize (pre-gen-3) — no-op until migration.`);
      } else {
        console.warn(`[settler] activateRoundEntries(${newRound}) drain paused: ${msg}`);
        await notify(`⚠️ Settler drain paused — activateRoundEntries(#${newRound})\n${msg}\nRound #${newRound} tickets may show stuck "Pending"; will retry next run.`);
      }
      break;
    }
  }
  console.log(`[settler] drained bookkeeping: settled #${settledRound}, activated ${entrants.length} for #${newRound}`);
}

// Self-healing activation catch-up. Entries flip Pending→Active only when the
// keeper activates them (TimbPrize advances the round O(1) and never activates
// inline). drainSettlement() does that — but ONLY right after a run settles a
// round boundary. So if the run that settled a boundary failed or was
// interrupted mid-drain (or was force-cancelled while holding the slot), that
// round's entries stay Pending forever: no later run retries them, because no
// later run settles that same boundary again. Symptom: tickets stuck "Pending"
// in an already-live round (the round-4 incident). Heal it every run by
// (re)activating the CURRENT round's entrants up front. activateRoundEntries is
// gated to currentRound and no-ops already-active tickets, so this is safe to
// call unconditionally; on testnet the occasional no-op tx is free, and it
// guarantees a missed/partial activation self-corrects on the very next run
// instead of requiring a manual poke.
async function healCurrentRoundActivation(registry, prize) {
  let round;
  try {
    round = await prize.currentRound();
  } catch (e) {
    console.warn(`[settler] activation catch-up skipped (round read failed): ${e?.shortMessage || e?.message}`);
    return;
  }
  let entrants = [];
  // getRoundEntrants returns an ethers v6 Result — a FROZEN array. Passing it,
  // or a slice of it, back as the `players` argument makes ethers throw
  // "Cannot assign to read only property '0'" when it normalizes the addresses
  // in place (this was the real reason activation silently failed and tickets
  // stuck "Pending"). Copy to a plain, mutable array of plain strings first.
  try { entrants = Array.from(await registry.getRoundEntrants(round), (a) => String(a)); } catch { return; }
  if (!entrants.length) return;
  console.log(`[settler] activation catch-up: ensuring ${entrants.length} entrant(s) active for round #${round}…`);
  for (let i = 0; i < entrants.length; i += DRAIN_CHUNK) {
    const chunk = entrants.slice(i, i + DRAIN_CHUNK);
    try {
      await (await registry.activateRoundEntries(round, chunk)).wait();
    } catch (e) {
      const msg = e?.shortMessage || e?.message || String(e);
      if (_isNotTimbPrizeRevert(e)) {
        console.warn(`[settler] activation catch-up for #${round} skipped: registry gates activateRoundEntries to TimbPrize (pre-gen-3). No-op until migration — see dev-docs/GEN3_MIGRATION.md.`);
      } else {
        console.warn(`[settler] activation catch-up for #${round} paused: ${msg}`);
        await notify(`⚠️ Settler activation catch-up FAILED — round #${round}\n${msg}\nTickets may show stuck "Pending" until this clears.`);
      }
      break;
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!RPC_URL)      throw new Error("Missing ARB_SEPOLIA_RPC");
  if (!PRIVATE_KEY)  throw new Error("Missing SETTLER_PRIVATE_KEY");

  // Bound every RPC request so a dead-air endpoint fails fast instead of hanging
  // on ethers' 5-minute default. A wedged read or tx otherwise freezes the whole
  // run, and with the workflow's `cancel-in-progress: false` a frozen run holds
  // the concurrency slot and blocks every queued run behind it (the exact
  // failure that left round-4 tickets stuck). A timed-out request throws, is
  // caught by the handlers below, alerts, and exits — letting cron / the next
  // run recover and freeing the slot.
  const fetchReq = new ethers.FetchRequest(RPC_URL);
  fetchReq.timeout = Number(process.env.SETTLER_RPC_TIMEOUT_MS || 30_000);
  const provider = new ethers.JsonRpcProvider(fetchReq);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const prize    = new ethers.Contract(TIMBPRIZE_ADDR, TIMBPRIZE_ABI, wallet);
  const registry = new ethers.Contract(GAMEREGISTRY_ADDR, GAMEREGISTRY_ABI, wallet);

  // ── Sanity checks ────────────────────────────────────────────────────────

  const started = await prize.gameStarted();
  if (!started) {
    console.log("[settler] Game not started yet — exiting.");
    return;
  }

  // H1: the prize game's VRFEntropy — read the wired address off TimbPrize so a
  // redeploy needs no settler edit. Refuse to run if it isn't set: startGame()
  // reverts without it, so a live game always has one.
  const entropyAddr = await prize.entropy();
  if (entropyAddr === ethers.ZeroAddress) {
    throw new Error("TimbPrize.entropy() is unset — prize VRF not wired; refusing to start settler");
  }
  const entropy = new ethers.Contract(entropyAddr, ENTROPY_ABI, provider);
  console.log(`[settler] Prize VRFEntropy: ${entropyAddr}`);

  // Self-heal any round whose entrants were left un-activated by a prior failed
  // or interrupted drain, BEFORE settling anything this run. Idempotent, so it's
  // a no-op on a healthy game. This is what makes a missed activation recover on
  // its own instead of leaving tickets stuck "Pending" until a manual poke.
  await healCurrentRoundActivation(registry, prize);

  // ── Drain the backlog: settle every overdue segment/round-boundary event
  //    this run finds, instead of stopping after the first one. Each
  //    iteration re-reads on-chain state, so a round rollover mid-loop is
  //    picked up correctly on the very next iteration.

  const startedAt   = Date.now();
  let settledCount  = 0;
  let roundsRolled  = 0;

  while (settledCount < MAX_SETTLES_PER_RUN) {
    const round     = await prize.currentRound();
    const segment   = await prize.currentSegment();
    const remaining = await prize.timeRemainingInSegment();

    console.log(`[settler] Round #${round} | Segment ${segment}/6 | ${remaining}s remaining`);

    if (remaining > 0n) {
      // Not due yet — linger to the boundary if it fits in this run's
      // budget, otherwise hand off to the next scheduled run.
      const waitMs = Number(remaining) * 1000 + 5_000; // small buffer past 59:45
      if (Date.now() - startedAt + waitMs > LINGER_BUDGET_MS) {
        console.log(`[settler] Next boundary is beyond this run's linger budget — exiting; next run picks it up.`);
        break;
      }
      console.log(`[settler] Lingering ${Math.round(waitMs / 1000)}s until the segment boundary…`);
      await sleep(waitMs);
      continue;
    }

    // Tiered Telegram alert if this segment blew past its 60:00 grid mark
    // (>60:03 slight, >60:10 major) before we could settle it.
    await alertIfDelayed(prize, round, segment);

    // H1: settlement is arm → VRF callback → lock. Resolve the segment's VRF
    // state and act accordingly:
    //   ready     → LOCK (settle event: advances / rolls the round)
    //   unarmed   → ARM (fire the request), then wait for the word
    //   armed,    → wait for the callback; re-request if it has stalled past
    //   not ready   REREQUEST_DELAY (replaceable)
    let salt, requested, ready;
    try {
      salt      = await prize.saltFor(round, segment);
      requested = await entropy.isRequested(salt);
      ready     = requested ? await entropy.isReady(salt) : false;
    } catch (err) {
      const msg = err?.shortMessage || err?.message || String(err);
      console.error(`[settler] VRF state read failed: ${msg}`);
      await notify(`❌ VRF state read FAILED\nRound #${round} | Segment ${segment}/6\nError: ${msg}`);
      process.exit(1);
    }

    if (ready) {
      console.log(`[settler] VRF word ready. Locking segment ${segment}/6…`);
      try {
        const wasRoundBoundary = await settleOnce(provider, wallet, prize, round, segment);
        settledCount++;
        if (wasRoundBoundary) {
          roundsRolled++;
          // H2: drain the just-settled round's expiry/forfeiture and activate the
          // new round's entrants, now that advancement no longer does it inline.
          await drainSettlement(registry, round, round + 1n);
        }
      } catch (err) {
        const msg = err?.shortMessage || err?.message || String(err);
        console.error(`[settler] lock settleSegment() failed: ${msg}`);
        await notify(`❌ Lock settleSegment() FAILED\nRound #${round} | Segment ${segment}/6\nError: ${msg}`);
        process.exit(1);
      }
      continue; // re-read state; the next segment (or round) may also be due
    }

    // Not ready yet — arm if needed, otherwise re-request a stalled draw.
    try {
      if (!requested) {
        await armSegment(provider, wallet, prize, round, segment);
      } else if (await entropy.replaceable(salt)) {
        console.log(`[settler] VRF draw stalled past the re-request delay — rearming…`);
        await (await prize.rearmSegment()).wait();
        await notify(`♻️ Re-requested a stalled VRF draw\nRound #${round} | Segment ${segment}/6`);
      }
    } catch (err) {
      const msg = err?.shortMessage || err?.message || String(err);
      console.error(`[settler] arm/rearm failed: ${msg}`);
      await notify(`❌ Arm/rearm FAILED\nRound #${round} | Segment ${segment}/6\nError: ${msg}`);
      process.exit(1);
    }

    // Wait for the callback if the run's budget allows, then loop to re-check.
    if (Date.now() - startedAt + VRF_POLL_MS > LINGER_BUDGET_MS) {
      console.log(`[settler] VRF word not in and the linger budget is spent — exiting; next run locks it.`);
      break;
    }
    console.log(`[settler] Waiting ${Math.round(VRF_POLL_MS / 1000)}s for the VRF word…`);
    await sleep(VRF_POLL_MS);
  }

  if (settledCount === 0) {
    console.log("[settler] Nothing to settle this run.");
  } else {
    console.log(`[settler] Settled ${settledCount} event(s) this run (${roundsRolled} round rollover(s)).`);
    if (settledCount === MAX_SETTLES_PER_RUN) {
      // Hit the cap — there may still be more overdue than one run should
      // ever need to catch up in practice; flag it instead of looping more.
      await notify(
        `⚠️ Settled the max of ${MAX_SETTLES_PER_RUN} events this run and stopped — ` +
        `there may still be a backlog. Will keep draining on the next run.`
      );
    }
  }
}

main().catch(async (err) => {
  console.error("[settler] Fatal error:", err.message);
  await notify(`💥 Settler fatal error\n${err.message}`);
  process.exit(1);
});
