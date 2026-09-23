// bounty-poster.js — posts the bug bounty to X on a fixed cadence (default 48h).
//
// Why this isn't just a cron with one fixed string:
//
//   1. X REJECTS DUPLICATE POSTS. Sending byte-identical text returns
//      403 "You are not allowed to create a Tweet with duplicate content",
//      so a single fixed post would fail every time after the first.
//      VARIANTS below rotate, and the pool balance line changes on its own
//      as the wallet is funded.
//   2. GITHUB CRON IS UNRELIABLE HERE. This repo measured roughly one tick
//      delivered in four to six, so no cron expression can be trusted to
//      mean "every N hours". The workflow runs hourly and THIS script decides
//      whether BOUNTY_MIN_HOURS have elapsed, from a committed state file.
//      Cron is a best-effort heartbeat; the state file is the clock.
//
// State: scripts/bounty-poster-state.json — { lastPostedAt, lastVariant, posts }.
// The workflow commits it back, exactly like the reconcilers do.
//
// Env:
//   X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET
//                        required; absent ⇒ no-op (never an error).
//   BOUNTY_POST_MODE     "off" disables without removing secrets.
//   BOUNTY_MIN_HOURS     default 48. Minimum gap between posts. 48 rather than
//                        24 on purpose: with a small following, a daily bounty
//                        post on an otherwise quiet account reads as a bot
//                        talking to itself. Seven variants at 48h is a two-week
//                        cycle before anything repeats.
//   BOUNTY_CARD          optional path to a PNG to attach.
//   BOUNTY_WALLET        pool wallet, for the balance read.
//   ARB_ONE_RPC          Arbitrum One RPC for the balance read.
//   BOUNTY_DRY_RUN       "1" prints the post and exits without sending.

const fs   = require("fs");
const path = require("path");
const { tweet, uploadMedia, xConfigured } = require("./xposter.js");

const STATE_PATH  = path.join(__dirname, "bounty-poster-state.json");
const MODE        = (process.env.BOUNTY_POST_MODE || "on").toLowerCase();
const MIN_HOURS   = Number(process.env.BOUNTY_MIN_HOURS || 48);
const CARD        = process.env.BOUNTY_CARD || "";
const WALLET      = process.env.BOUNTY_WALLET || "0x6dc9380d32Bd7CaA16Cc079073fb54D644C6138C";
const ARB_ONE_RPC = process.env.ARB_ONE_RPC || "https://arb1.arbitrum.io/rpc";
const DRY_RUN     = process.env.BOUNTY_DRY_RUN === "1";

const USDT_ARB_ONE = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"; // canonical, 6 dec

// ── The rotation ───────────────────────────────────────────────────────────────
// Every variant must stand alone: someone sees exactly one of these, on one
// random day, with no thread above it. So each states the chain, the payout
// rail and the cap. `pool` is substituted with the live balance line when the
// balance reads, and dropped entirely when it doesn't — never a stale number.
const VARIANTS = [
  (pool) =>
`Paying real USDT to break my unaudited testnet contracts, before there's anyone's money on them to lose.

5 severity tiers, $500 cap per report.${pool}

timbswap.xyz/gov/#bounty`,

  (pool) =>
`Most bounties ask you to race an exploit on a contract holding strangers' savings.

Mine is on testnet. Severity still priced by what the bug WOULD do with real funds. Paid in USDT on Arbitrum One.${pool}

timbswap.xyz/gov/#bounty`,

  (pool) =>
`The TimbSwap bounty pool wallet is public, and the page reads its balance off-chain in your own browser.${pool}

I'd rather you check a real number than take a headline on faith.

timbswap.xyz/gov/#bounty`,

  (pool) =>
`Unaudited DEX + prize game on testnet. Find the drain before the audit does.

T5 (full drain, prize manipulation, privilege escalation): up to $500, paid in USDT on Arbitrum One.${pool}

timbswap.xyz/gov/#bounty`,

  (pool) =>
`Bug bounty, still open.

Pari-mutuel: each tier's share splits across every accepted report in it. First valid reporter of an issue is the one eligible.${pool}

Scope and tiers → timbswap.xyz/gov/#bounty`,

  (pool) =>
`If you've been meaning to read someone's contracts properly, read mine.

Arbitrum Sepolia, unaudited, open source. Real USDT for anything you break.${pool}

timbswap.xyz/gov/#bounty`,

  (pool) =>
`Shipping a DEX solo means the code has had exactly one set of eyes on it.

That's the problem the bounty exists to fix. Up to $500 per report, USDT on Arbitrum One.${pool}

timbswap.xyz/gov/#bounty`
];

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); }
  catch { return { lastPostedAt: null, lastVariant: -1, posts: 0 }; }
}

function writeState(s) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + "\n");
}

function hoursSince(iso) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 3_600_000;
}

// Live USDT balance of the pool wallet. Returns "" on any failure — the post
// goes out without a number rather than with a number we could not verify.
async function poolLine() {
  if (!WALLET) return "";
  try {
    const data = "0x70a08231" + WALLET.replace(/^0x/, "").toLowerCase().padStart(64, "0");
    const res = await fetch(ARB_ONE_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: USDT_ARB_ONE, data }, "latest"] })
    });
    const body = await res.json();
    if (!body?.result || body.error) return "";
    const usdt = Number(BigInt(body.result)) / 1e6;
    if (!Number.isFinite(usdt) || usdt <= 0) return "";
    return `\n\nPool right now: ${usdt.toLocaleString("en-US", {
      minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT — verify it yourself.`;
  } catch {
    return "";
  }
}

async function main() {
  if (MODE === "off")     { console.log("[bounty] BOUNTY_POST_MODE=off — skipping."); return; }
  if (!xConfigured() && !DRY_RUN) {
    console.log("[bounty] No X credentials — skipping."); return;
  }

  const state = readState();
  const elapsed = hoursSince(state.lastPostedAt);
  if (elapsed < MIN_HOURS) {
    console.log(`[bounty] Last post ${elapsed.toFixed(1)}h ago (< ${MIN_HOURS}h) — nothing to do.`);
    return;
  }

  // Advance the rotation rather than picking by date: an unreliable cron must
  // not repeat a variant just because two fires landed on the same day.
  const idx  = (state.lastVariant + 1) % VARIANTS.length;
  const text = VARIANTS[idx](await poolLine());

  if (text.length > 280) {
    // Never silently truncate a post that names money — fail loudly instead.
    throw new Error(`[bounty] Variant ${idx} is ${text.length} chars (> 280). Fix VARIANTS.`);
  }

  if (DRY_RUN) {
    console.log(`[bounty] DRY RUN — variant ${idx}, ${text.length} chars:\n\n${text}\n`);
    return;
  }

  let mediaId = null;
  if (CARD && fs.existsSync(CARD)) {
    try { mediaId = await uploadMedia(fs.readFileSync(CARD)); }
    catch (e) { console.warn("[bounty] card upload failed, posting text-only:", e?.message || e); }
  }

  const id = await tweet(text, mediaId);
  writeState({
    lastPostedAt: new Date().toISOString(),
    lastVariant:  idx,
    posts:        (state.posts || 0) + 1
  });
  console.log(`[bounty] Posted variant ${idx} → tweet ${id}`);
}

// ── Self-test ──────────────────────────────────────────────────────────────────
function selfTest() {
  let pass = 0, fail = 0;
  const ok = (name, cond) => { cond ? pass++ : (fail++, console.error("FAIL:", name)); };

  // Every variant fits X's limit, with and without the pool line.
  const longPool = "\n\nPool right now: 12,345.67 USDT — verify it yourself.";
  VARIANTS.forEach((v, i) => {
    ok(`variant ${i} fits with pool line`, v(longPool).length <= 280);
    ok(`variant ${i} fits without pool line`, v("").length <= 280);
    ok(`variant ${i} links the bounty page`, v("").includes("timbswap.xyz/gov/#bounty"));
  });

  // No two variants are identical — X would reject the repeat.
  const seen = new Set(VARIANTS.map(v => v("")));
  ok("all variants distinct", seen.size === VARIANTS.length);

  // The rotation advances and wraps.
  ok("rotation advances", ((0 + 1) % VARIANTS.length) === 1);
  ok("rotation wraps", ((VARIANTS.length - 1 + 1) % VARIANTS.length) === 0);

  // The cadence gate, asserted against MIN_HOURS rather than a literal, so
  // these stay true if BOUNTY_MIN_HOURS is overridden.
  ok("default cadence is 48h", Number(process.env.BOUNTY_MIN_HOURS || 48) === MIN_HOURS);
  ok("no state ⇒ due", hoursSince(null) === Infinity);
  ok("just posted ⇒ not due", hoursSince(new Date().toISOString()) < MIN_HOURS);
  ok("a minute short ⇒ not due",
     hoursSince(new Date(Date.now() - (MIN_HOURS * 3600e3 - 60e3)).toISOString()) < MIN_HOURS);
  ok("a minute over ⇒ due",
     hoursSince(new Date(Date.now() - (MIN_HOURS * 3600e3 + 60e3)).toISOString()) >= MIN_HOURS);
  ok("garbage timestamp ⇒ due", hoursSince("not-a-date") === Infinity);

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (process.argv.includes("--self-test")) selfTest();
else main().catch((e) => { console.error(e); process.exit(1); });
