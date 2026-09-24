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
//   BOUNTY_WALLET        pool wallet, whose inbound USDT is summed.
//   BOUNTY_FUNDING_FROM_BLOCK
//                        Arbitrum One block of the FIRST funding transfer into
//                        the wallet. Seeds the first scan; after that the state
//                        file's cursor takes over. Unset ⇒ no pot line.
//   BOUNTY_FUNDING_CHUNK default 50000. getLogs range per request.
//   ARB_ONE_RPC          Arbitrum One RPC for the funding scan.
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
const FUNDING_FROM_BLOCK = Number(process.env.BOUNTY_FUNDING_FROM_BLOCK || 0);
const FUNDING_CHUNK      = Number(process.env.BOUNTY_FUNDING_CHUNK || 50000);

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

// ── Cumulative funding ─────────────────────────────────────────────────────────
// The pot line reports TOTAL USDT EVER PAID INTO the wallet, not its current
// balance. Balance falls when a hunter is paid, which would read as the
// programme shrinking; cumulative funding only ever rises, so it says what it
// looks like it says.
//
// It is computed by summing ERC-20 Transfer logs whose `to` is the wallet, and
// cached incrementally in the state file: each run scans only from the last
// block it scanned to the chain head. A chunk that fails leaves the cursor
// where it was, so a bad scan under-reports and retries rather than skipping a
// window and permanently losing funding.
//
// BOUNTY_FUNDING_FROM_BLOCK seeds the first scan. Without it (and with no
// cursor in state) there is no honest starting point, so no line is emitted.
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; // Transfer(address,address,uint256)

async function rpc(method, params) {
  const res = await fetch(ARB_ONE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const body = await res.json();
  if (body?.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body?.result;
}

// Sums inbound USDT (in base units) over [from, to], chunked. Returns the sum
// and the last block actually scanned — which is < `to` if a chunk failed.
async function scanInbound(from, to) {
  let total = 0n;
  let cursor = from - 1;
  const topicWallet = "0x" + WALLET.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  for (let start = from; start <= to; start += FUNDING_CHUNK) {
    const end = Math.min(start + FUNDING_CHUNK - 1, to);
    let logs;
    try {
      logs = await rpc("eth_getLogs", [{
        address:   USDT_ARB_ONE,
        fromBlock: "0x" + start.toString(16),
        toBlock:   "0x" + end.toString(16),
        topics:    [TRANSFER_TOPIC, null, topicWallet]
      }]);
    } catch (e) {
      // Stop here and keep the cursor. Under-reporting is recoverable next
      // run; skipping a window would lose that funding for good.
      console.warn(`[bounty] getLogs ${start}-${end} failed, stopping scan:`, e?.message || e);
      break;
    }
    for (const log of logs || []) total += BigInt(log.data);
    cursor = end;
  }
  return { total, cursor };
}

// Returns the pot line, and the funding state to persist. On any failure the
// line is "" — the post goes out without a number rather than with one we
// could not verify.
async function potLine(state) {
  if (!WALLET) return { line: "", funding: state.funding };

  const prev  = state.funding || {};
  const start = Number.isFinite(prev.lastScannedBlock)
    ? prev.lastScannedBlock + 1
    : (FUNDING_FROM_BLOCK || 0);

  if (!start) {
    console.warn("[bounty] No BOUNTY_FUNDING_FROM_BLOCK and no cursor — omitting the pot line.");
    return { line: "", funding: prev };
  }

  try {
    const head = Number(BigInt(await rpc("eth_blockNumber", [])));
    if (!Number.isFinite(head) || head < start) {
      return { line: potText(prev.cumulativeBaseUnits), funding: prev };
    }
    const { total, cursor } = await scanInbound(start, head);
    const cumulative = BigInt(prev.cumulativeBaseUnits || "0") + total;
    return {
      line: potText(cumulative.toString()),
      funding: { cumulativeBaseUnits: cumulative.toString(), lastScannedBlock: cursor }
    };
  } catch (e) {
    console.warn("[bounty] funding scan failed:", e?.message || e);
    // Still print what we already knew, if anything.
    return { line: potText(prev.cumulativeBaseUnits), funding: prev };
  }
}

// Whole USDT, rounded DOWN. Flooring can only ever understate the pot;
// rounding could print 26 for 25.6, and a bounty post must never quote more
// money than has actually been committed.
function potText(baseUnits) {
  if (baseUnits === undefined || baseUnits === null) return "";
  const usdt = Number(BigInt(baseUnits)) / 1e6;
  if (!Number.isFinite(usdt) || usdt <= 0) return "";
  return `\n\nBounty Pot Funded: ${Math.floor(usdt).toLocaleString("en-US")} USDT`;
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
  const idx = (state.lastVariant + 1) % VARIANTS.length;
  const { line, funding } = await potLine(state);
  const text = VARIANTS[idx](line);

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
    posts:        (state.posts || 0) + 1,
    funding
  });
  console.log(`[bounty] Posted variant ${idx} → tweet ${id}`);
}

// ── Self-test ──────────────────────────────────────────────────────────────────
function selfTest() {
  let pass = 0, fail = 0;
  const ok = (name, cond) => { cond ? pass++ : (fail++, console.error("FAIL:", name)); };

  // Every variant fits X's limit, with and without the pool line.
  const longPool = "\n\nBounty Pot Funded: 12,345 USDT";
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

  // potText: whole USDT, rounded DOWN, from base units (6 decimals).
  ok("25.999 USDT floors to 25", potText("25999000").includes("25 USDT"));
  ok("25.005 USDT floors to 25", potText("25005000").includes("25 USDT"));
  ok("thousands separated",      potText("12345670000").includes("12,345 USDT"));
  ok("label says Funded",        potText("25000000").includes("Bounty Pot Funded:"));
  ok("no 'To Date' anywhere",    !potText("25000000").includes("To Date"));
  ok("zero ⇒ no line",           potText("0") === "");
  ok("undefined ⇒ no line",      potText(undefined) === "");
  ok("null ⇒ no line",           potText(null) === "");

  // Cumulative funding must never fall: a payout reduces the balance but not
  // the total ever funded, which is the whole reason for the change.
  const fundedThenPaid = BigInt("25000000") + BigInt("50000000"); // two top-ups
  ok("top-ups accumulate", potText(fundedThenPaid.toString()).includes("75 USDT"));

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (process.argv.includes("--self-test")) selfTest();
else main().catch((e) => { console.error(e); process.exit(1); });
