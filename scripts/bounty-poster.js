// bounty-poster.js — posts the bug bounty to X on a fixed cadence (default 48h).
//
// Why this isn't just a cron with one fixed string:
//
//   1. X REJECTS DUPLICATE POSTS. Sending byte-identical text returns
//      403 "You are not allowed to create a Tweet with duplicate content",
//      so a single fixed post would fail every time after the first.
//      VARIANTS below rotate.
//   2. GITHUB CRON IS UNRELIABLE HERE. This repo measured roughly one tick
//      delivered in four to six, so no cron expression can be trusted to
//      mean "every N hours". The workflow runs hourly and THIS script decides
//      whether BOUNTY_MIN_HOURS have elapsed, from a committed state file.
//      Cron is a best-effort heartbeat; the state file is the clock.
//
// State: scripts/bounty-poster-state.json — { lastPostedAt, lastVariant, posts }.
// The workflow commits it back, exactly like the reconcilers do.
//
// No amounts: posts never quote a dollar or USDT figure (no pot size, no cap).
// The bounty page carries the terms; the posts only point at it.
//
// Cutoff: nothing is posted at or after BOUNTY_CLOSES_AT, so a closed bounty
// is never advertised.
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
//   BOUNTY_CLOSES_AT     ISO time the bounty closes; default 2026-10-26T23:59:59Z.
//   BOUNTY_DRY_RUN       "1" prints the post and exits without sending.
//   --verify-auth        uploads a 1x1 PNG and attaches it to nothing. Media
//                        upload needs WRITE scope, so this proves the token can
//                        post without posting anything. Exit 0 = write OK;
//                        2 = read-only token (explicit oauth1-permissions);
//                        3 = media endpoint refused with no scope error (not a
//                        token problem); 4 = bad credentials (401); 1 = other.

const fs   = require("fs");
const path = require("path");
const { tweet, uploadMedia, xConfigured } = require("./xposter.js");

const STATE_PATH  = path.join(__dirname, "bounty-poster-state.json");
const MODE        = (process.env.BOUNTY_POST_MODE || "on").toLowerCase();
const MIN_HOURS   = Number(process.env.BOUNTY_MIN_HOURS || 48);
const CARD        = process.env.BOUNTY_CARD || "";
const DRY_RUN     = process.env.BOUNTY_DRY_RUN === "1";
const CLOSES_AT   = Date.parse(process.env.BOUNTY_CLOSES_AT || "2026-10-26T23:59:59Z");

// ── The rotation ───────────────────────────────────────────────────────────────
// Every variant must stand alone: someone sees exactly one of these, on one
// random day, with no thread above it. So each states the chain and the payout
// rail. None quotes an amount.
const VARIANTS = [
`Real USDT for breaking unaudited testnet contracts — before there is anyone's money on them to lose.

5 severity tiers, priced by what the bug would do with real funds.

timbswap.xyz/gov/#bounty`,

`Most bounties ask you to race an exploit on a contract holding strangers' savings.

TimbSwap's are on testnet. Severity still priced by what the bug WOULD do with real funds. Paid in USDT on Arbitrum One.

timbswap.xyz/gov/#bounty`,

`Every accepted TimbSwap report gets a public TS entry and a fix, logged on the bounty page.

Read what has been found, then find what hasn't.

timbswap.xyz/gov/#bounty`,

`Unaudited DEX + prize game on testnet. Find the drain before the audit does.

T5 (full drain, prize manipulation, privilege escalation) is the top tier, paid in USDT on Arbitrum One.

timbswap.xyz/gov/#bounty`,

`Bug bounty, still open.

Pari-mutuel: each tier's share splits across every accepted report in it. First valid reporter of an issue is the one eligible.

Scope and tiers → timbswap.xyz/gov/#bounty`,

`If you've been meaning to read someone's contracts properly, read these.

Arbitrum Sepolia, unaudited, open source. Real USDT for anything you break.

timbswap.xyz/gov/#bounty`,

`Shipping a DEX solo means the code has had exactly one set of eyes on it.

That's the problem the bounty exists to fix. Paid in USDT on Arbitrum One.

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

/** True once the bounty has closed (or the close time is unreadable). */
function isClosed(now = Date.now()) {
  return !Number.isFinite(CLOSES_AT) || now >= CLOSES_AT;
}

async function main() {
  if (MODE === "off")     { console.log("[bounty] BOUNTY_POST_MODE=off — skipping."); return; }
  if (isClosed()) {
    console.log(`[bounty] Bounty closed at ${process.env.BOUNTY_CLOSES_AT || "2026-10-26T23:59:59Z"} — not posting.`);
    return;
  }
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
  const idx = (state.lastVariant + 1) % VARIANTS.length;
  const text = VARIANTS[idx];

  if (text.length > 280) {
    // Never silently truncate a post — fail loudly instead.
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

// ── Write-scope probe ──────────────────────────────────────────────────────────
// X returns 403 oauth1-permissions for any write when the access token was
// minted while the app was read-only - and a token keeps the scope it was
// minted with, so fixing the app setting alone does nothing until the token is
// regenerated. This makes that visible on demand instead of at the next post.
async function verifyAuth() {
  if (!xConfigured()) { console.log("[bounty] No X credentials configured."); process.exit(1); }
  // Smallest valid PNG: 1x1 transparent.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64");
  try {
    const id = await uploadMedia(png);
    console.log(`[bounty] WRITE OK - media upload accepted (media_id ${id}). Token can post.`);
    process.exit(0);
  } catch (e) {
    const msg = String(e?.message || e);
    // Only X's explicit scope error proves a read-only token. A bare 403 with
    // an empty body from the v1.1 media endpoint is a different failure - that
    // endpoint is being retired - and must not be reported as a scope problem,
    // or the fix chases the wrong thing.
    if (/oauth1-permissions/.test(msg)) {
      console.error("[bounty] READ-ONLY TOKEN - X refused a write on scope grounds:", msg);
      console.error("[bounty] Fix: app -> User authentication settings -> Read and Write -> Save, then REGENERATE the Access Token and Secret and update the two secrets. The API key/secret can stay.");
      process.exit(2);
    }
    if (/^media upload 403/.test(msg)) {
      console.error("[bounty] MEDIA ENDPOINT REFUSED (403, no scope error):", msg);
      console.error("[bounty] Token scope is NOT the cause here. Likely the v1.1 media endpoint itself. Text-only posts may still work - the next real post will show. Exit 3.");
      process.exit(3);
    }
    if (/401/.test(msg)) {
      console.error("[bounty] BAD CREDENTIALS (401) - the four X_* values do not form a valid pair:", msg);
      process.exit(4);
    }
    console.error("[bounty] probe failed for another reason:", msg);
    process.exit(1);
  }
}

// ── Self-test ──────────────────────────────────────────────────────────────────
function selfTest() {
  let pass = 0, fail = 0;
  const ok = (name, cond) => { cond ? pass++ : (fail++, console.error("FAIL:", name)); };

  // Every variant fits X's limit and links the page.
  VARIANTS.forEach((v, i) => {
    ok(`variant ${i} fits`, v.length <= 280);
    ok(`variant ${i} links the bounty page`, v.includes("timbswap.xyz/gov/#bounty"));
  });

  // No amounts: no dollar figure and no USDT figure, in any variant.
  const AMOUNT = /\$\s*\d|\d[\d,.]*\s*(USDT|USD|dollars?)\b/i;
  VARIANTS.forEach((v, i) => {
    const m = v.match(AMOUNT);
    ok(`variant ${i} quotes no amount${m ? ` (found "${m[0]}")` : ""}`, !m);
  });

  // Public copy speaks as TimbSwap, never as a person. This guard is why:
  // the variants read like a founder wrote them, and it is easy to slip back
  // into "my contracts" when adding one.
  const FIRST_PERSON = /\b(I|I'm|I'd|I've|I'll|me|my|mine|myself|we|we're|we've|our|ours|us)\b/i;
  VARIANTS.forEach((v, i) => {
    const m = v.match(FIRST_PERSON);
    ok(`variant ${i} has no first person${m ? ` (found "${m[0]}")` : ""}`, !m);
  });

  // No two variants are identical — X would reject the repeat.
  const seen = new Set(VARIANTS);
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

  // The cutoff: open before the close time, closed at and after it.
  ok("open a second before close", !isClosed(CLOSES_AT - 1000));
  ok("closed at close",            isClosed(CLOSES_AT));
  ok("closed after close",         isClosed(CLOSES_AT + 86400e3));
  ok("default close is 26 Oct 23:59:59 UTC",
     process.env.BOUNTY_CLOSES_AT || CLOSES_AT === Date.parse("2026-10-26T23:59:59Z"));

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (process.argv.includes("--self-test")) selfTest();
else if (process.argv.includes("--verify-auth")) verifyAuth();
else main().catch((e) => { console.error(e); process.exit(1); });
