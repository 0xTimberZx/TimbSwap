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
// No currency: posts never name USDT or any dollar figure (no pot size, no cap,
// no payout token). The bounty page carries the terms; the posts only point at it.
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
// random day, with no thread above it. None names a currency or an amount.
const VARIANTS = [
`Real rewards for breaking unaudited testnet contracts — before there is anyone's money on them to lose.

5 severity tiers, priced by what the bug would do with real funds.

timbswap.xyz/gov/#bounty`,

`Most bounties ask you to race an exploit on a contract holding strangers' savings.

TimbSwap's are on testnet. Severity still priced by what the bug WOULD do with real funds. Paid on Arbitrum One.

timbswap.xyz/gov/#bounty`,

`Every accepted TimbSwap report gets a public TS entry and a fix, logged on the bounty page.

Read what has been found, then find what hasn't.

timbswap.xyz/gov/#bounty`,

`Unaudited DEX + prize game on testnet. Find the drain before the audit does.

T5 (full drain, prize manipulation, privilege escalation) is the top tier, paid on Arbitrum One.

timbswap.xyz/gov/#bounty`,

`Bug bounty, still open.

Pari-mutuel: each tier's share splits across every accepted report in it. First valid reporter of an issue is the one eligible.

Scope and tiers → timbswap.xyz/gov/#bounty`,

`If you've been meaning to read someone's contracts properly, read these.

Arbitrum Sepolia, unaudited, open source. Real rewards for anything you break.

timbswap.xyz/gov/#bounty`,

`Shipping a DEX solo means the code has had exactly one set of eyes on it.

That's the problem the bounty exists to fix. Five severity tiers, paid on Arbitrum One.

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

// ── The close ──────────────────────────────────────────────────────────────────
// The last three days replace the rotation with two countdown posts:
//   "soon"  once, when 24h < time left <= 72h, on the normal MIN_HOURS gap;
//   "final" once, when time left <= 24h, at least FINAL_GAP_HOURS after the
//           previous post, so the last day is announced even if "soon" ran late.
// Nothing else posts inside the window. The date is read from CLOSES_AT, so an
// overridden close date stays correct in the text.
const SOON_WINDOW_HOURS = 72;
const FINAL_WINDOW_HOURS = 24;
const FINAL_GAP_HOURS = 12;

function closeLabel() {
  const d = new Date(CLOSES_AT);
  const month = d.toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return { day: `${d.getUTCDate()} ${month}`, time: `${hh}:${mm} UTC` };
}

const CLOSING = {
  soon: () => {
    const { day, time } = closeLabel();
    return `The TimbSwap bug bounty closes on ${day} at ${time}.

Unaudited, open source, live on Arbitrum Sepolia. Five severity tiers, priced by what the bug would do with real funds. Reports must land before the deadline.

timbswap.xyz/gov/#bounty`;
  },
  final: () => {
    const { time } = closeLabel();
    return `Last day: the TimbSwap bug bounty closes today at ${time}.

Anything submitted after that is out. If you found something, send it now.

Scope and tiers → timbswap.xyz/gov/#bounty`;
  },
};

/**
 * What to post now, or null. Pure: takes the state and the clock, so the
 * self-test can walk the calendar.
 */
function pickPost(state, now = Date.now()) {
  if (isClosed(now)) return null;
  const left = (CLOSES_AT - now) / 3_600_000;
  const since = state.lastPostedAt ? (now - Date.parse(state.lastPostedAt)) / 3_600_000 : Infinity;
  const done = state.closing || {};
  if (left <= FINAL_WINDOW_HOURS) {
    if (done.final || since < FINAL_GAP_HOURS) return null;
    return { kind: "final", text: CLOSING.final() };
  }
  if (left <= SOON_WINDOW_HOURS) {
    if (done.soon || since < MIN_HOURS) return null;
    return { kind: "soon", text: CLOSING.soon() };
  }
  if (since < MIN_HOURS) return null;
  // Advance the rotation rather than picking by date: an unreliable cron must
  // not repeat a variant just because two fires landed on the same day.
  const idx = (state.lastVariant + 1) % VARIANTS.length;
  return { kind: "rotation", idx, text: VARIANTS[idx] };
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
  const post = pickPost(state);
  if (!post) {
    console.log(`[bounty] Last post ${hoursSince(state.lastPostedAt).toFixed(1)}h ago — nothing due.`);
    return;
  }
  const { text } = post;
  const label = post.kind === "rotation" ? `variant ${post.idx}` : `closing post "${post.kind}"`;

  if (text.length > 280) {
    // Never silently truncate a post — fail loudly instead.
    throw new Error(`[bounty] ${label} is ${text.length} chars (> 280). Fix the text.`);
  }

  if (DRY_RUN) {
    console.log(`[bounty] DRY RUN — ${label}, ${text.length} chars:\n\n${text}\n`);
    return;
  }

  let mediaId = null;
  if (CARD && fs.existsSync(CARD)) {
    try { mediaId = await uploadMedia(fs.readFileSync(CARD)); }
    catch (e) { console.warn("[bounty] card upload failed, posting text-only:", e?.message || e); }
  }

  const id = await tweet(text, mediaId);
  const postedAt = new Date().toISOString();
  writeState({
    lastPostedAt: postedAt,
    lastVariant:  post.kind === "rotation" ? post.idx : state.lastVariant,
    posts:        (state.posts || 0) + 1,
    closing:      post.kind === "rotation" ? state.closing : { ...(state.closing || {}), [post.kind]: postedAt }
  });
  console.log(`[bounty] Posted ${label} → tweet ${id}`);
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

  // No currency and no amounts in any variant: not USDT, not a dollar figure.
  const AMOUNT = /USDT|USDC|\$\s*\d|\bUSD\b|\bdollars?\b/i;
  VARIANTS.forEach((v, i) => {
    const m = v.match(AMOUNT);
    ok(`variant ${i} names no currency or amount${m ? ` (found "${m[0]}")` : ""}`, !m);
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

  // The close: walk the calendar against the real default close time.
  {
    const H = 3_600_000;
    const at = (h) => CLOSES_AT - h * H;              // h hours before close
    const iso = (t) => new Date(t).toISOString();
    const base = { lastVariant: 0, posts: 1 };
    // Normal rotation well before the window.
    const p1 = pickPost({ ...base, lastPostedAt: iso(at(200)) }, at(120));
    ok("rotation before the window", p1 && p1.kind === "rotation" && p1.idx === 1);
    // 64h left, last post 48h ago: the "soon" post.
    const p2 = pickPost({ ...base, lastPostedAt: iso(at(112)) }, at(64));
    ok("soon at 64h left", p2 && p2.kind === "soon");
    // Inside the window but under the gap: nothing.
    ok("soon waits for the gap", pickPost({ ...base, lastPostedAt: iso(at(80)) }, at(64)) === null);
    // Soon done, 30h left: nothing (no rotation inside the window).
    ok("no rotation inside the window",
       pickPost({ ...base, lastPostedAt: iso(at(64)), closing: { soon: iso(at(64)) } }, at(30)) === null);
    // 23h left, soon 41h ago: the final post.
    const p3 = pickPost({ ...base, lastPostedAt: iso(at(64)), closing: { soon: iso(at(64)) } }, at(23));
    ok("final on the last day", p3 && p3.kind === "final");
    // Final needs 12h since the previous post.
    ok("final waits 12h after soon",
       pickPost({ ...base, lastPostedAt: iso(at(30)), closing: { soon: iso(at(30)) } }, at(23)) === null);
    // Final even if soon never ran.
    const p4 = pickPost({ ...base, lastPostedAt: iso(at(200)) }, at(10));
    ok("final even without soon", p4 && p4.kind === "final");
    // Final only once.
    ok("final only once",
       pickPost({ ...base, lastPostedAt: iso(at(23)), closing: { final: iso(at(23)) } }, at(1)) === null);
    // After the close: nothing at all.
    ok("nothing after the close", pickPost({ ...base, lastPostedAt: iso(at(200)) }, CLOSES_AT + H) === null);
    // Closing texts: fit, link, name the date, no currency, no first person.
    for (const k of ["soon", "final"]) {
      const t = CLOSING[k]();
      ok(`closing ${k} fits`, t.length <= 280);
      ok(`closing ${k} links the page`, t.includes("timbswap.xyz/gov/#bounty"));
      ok(`closing ${k} states the time`, t.includes(closeLabel().time));
      ok(`closing ${k} names no currency`, !/USDT|USDC|\$\s*\d|\bUSD\b|\bdollars?\b/i.test(t));
      ok(`closing ${k} no first person`, !FIRST_PERSON.test(t));
    }
    ok("soon names the day", CLOSING.soon().includes(closeLabel().day));
    ok("closing texts distinct", CLOSING.soon() !== CLOSING.final());
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (process.argv.includes("--self-test")) selfTest();
else if (process.argv.includes("--verify-auth")) verifyAuth();
else main().catch((e) => { console.error(e); process.exit(1); });
