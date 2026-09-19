// faucet-recon.js — do the faucet's three records agree about who was paid?
//
// A faucet claim leaves three marks: a row in Supabase `faucet_claims` that
// the worker resolves to `sent` with the transaction hash, a `Dispensed` event
// in that transaction, and the contract's own `lastClaimAt[claimant]`. The
// invariants monitor (faucet-invariants.js) already reconciles the events
// against the contract's tally. This witness adds the database leg and pairs
// the three, so a disagreement says which leg lied instead of just that one
// did. It reads all three and writes none of them, and holds no key.
//
// Pairing. A `sent` row and a `Dispensed` event pair by transaction hash. Both
// arrive within seconds of each other, but not in the same instant and not
// always in the same run, so unmatched items are carried in state and only
// become findings once older than RECON_LAG_MIN. The contract clock is read
// only for the items that failed to pair.
//
// Findings:
//   db-only     a `sent` row whose transaction has no Dispensed event. The
//               contract says which side is wrong: lastClaimAt at or after the
//               row's reservation means the chain saw a claim and the event scan
//               missed it; earlier means the chain never saw it and the row is
//               wrong (a transaction that reverted, or a hash that is not the
//               dispense)
//   chain-only  a Dispensed event whose transaction is no `sent` row's hash.
//               If a `failed` row for the same wallet sits within the lag of the
//               event, the worker paid and then failed to record it (that
//               wallet's day was not burned in the database and it may reserve
//               again); otherwise the dispatcher key was used outside the worker
//   mismatch    a `sent` row whose transaction paid a different wallet
//   stale       a `reserved` row older than the lag; the worker's housekeeping
//               (expire_stale_reservations at fifteen minutes) is not running
//   unknown     the chain or the database could not be read
//
// State: scripts/faucet-recon-state.json — a block cursor, a row-id cursor,
// the unmatched rows and events still inside the lag, and last-alerted stamps.
// Keyed to chain id and faucet address; a redeploy starts the record over.
//
// Env:
//   FAUCET_RPC             optional; default = config.js public RPC (reads only)
//   FAUCET_ADDRESS         optional override; default = config.js ADDRESSES.GasFaucet
//   FAUCET_GENESIS_BLOCK   first block on the first run; else the per-chain default;
//                          else latest − 3,000,000. Rows before that block's time are ignored
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   the claim ledger (RLS has no anon policy)
//   RECON_LAG_MIN          minutes an unmatched item may wait before it is a finding (default 20)
//   RECON_REALERT_MIN      minutes between repeat alerts for a standing finding (default 360)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_OPS_MODE   optional alerts
//
// Flags: --self-test  --dry-run (no Telegram, no state write)  --report (summary even when healthy)

const fs   = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { addrFromConfig, rpcFromConfig } = require("./lib/config");
const { scanEvents, blockTimestamps } = require("./lib/logs");
const { loadState, saveState } = require("./lib/state");
const { makeTelegram, shouldRealert } = require("./lib/telegram");

const SELF_TEST = process.argv.includes("--self-test");
const DRY_RUN   = process.argv.includes("--dry-run");
const REPORT    = process.argv.includes("--report");

const STATE_PATH = path.join(__dirname, "faucet-recon-state.json");
const GENESIS_FALLBACK_SPAN = 3_000_000;
// Same first-run default as the invariants monitor: the testnet faucet's deploy.
const GENESIS_DEFAULT_BY_CHAIN = { 421614: 309_038_324 };

const OPTS = {
  lagMin:     Number(process.env.RECON_LAG_MIN || 20),
  realertMin: Number(process.env.RECON_REALERT_MIN || 360),
};

// ─── Pure logic (exported for --self-test) ──────────────────────────────────
//
// rows:   [{ id, address (lowercase), status, tx (wallet_tx|null), reservedAt, sentAt, error }]
// events: [{ tx, claimant (lowercase), block, ts }]
// pending: { rows: { [id]: row }, events: { [tx]: event } }   carried across runs
//
// reconcile() folds new rows and events into `pending`, pairs by tx hash, and
// returns the items that are still unmatched and older than the lag, so the
// caller can read the contract for them. It mutates `pending`.

function reconcile(pending, rows, events, nowSec, opts = OPTS) {
  const findings = [];
  const lag = opts.lagMin * 60;

  for (const e of events) pending.events[e.tx.toLowerCase()] = e;
  for (const r of rows) {
    if (r.status === "sent" && r.tx) pending.rows[r.id] = r;
    else if (r.status === "reserved") {
      if (nowSec - r.reservedAt > lag) findings.push({ kind: "stale", id: r.id, detail: `row #${r.id} for ${short(r.address)} reserved ${fmtMin(nowSec - r.reservedAt)} ago and never resolved` });
    }
    // failed rows are kept only long enough to explain a chain-only event
    else if (r.status === "failed") (pending.failed ??= {})[r.id] = r;
  }

  // Pair by tx hash.
  for (const [id, r] of Object.entries(pending.rows)) {
    const e = pending.events[r.tx.toLowerCase()];
    if (!e) continue;
    if (e.claimant !== r.address) {
      findings.push({ kind: "mismatch", id: r.id, detail: `row #${r.id} says ${short(r.address)} but its tx ${short(r.tx)} paid ${short(e.claimant)}` });
    }
    delete pending.rows[id];
    delete pending.events[r.tx.toLowerCase()];
  }

  // Age out the unmatched.
  const dbOnly = [], chainOnly = [];
  for (const [id, r] of Object.entries(pending.rows)) {
    const at = r.sentAt ?? r.reservedAt;
    if (nowSec - at > lag) { dbOnly.push(r); delete pending.rows[id]; }
  }
  for (const [tx, e] of Object.entries(pending.events)) {
    if (nowSec - e.ts > lag) {
      // A failed row for the same wallet around the event's time explains it.
      const near = Object.values(pending.failed || {}).find((f) => f.address === e.claimant && Math.abs(f.reservedAt - e.ts) <= lag);
      chainOnly.push({ ...e, failedRow: near || null });
      delete pending.events[tx];
    }
  }
  // Drop failed rows older than two lags; they can no longer explain anything.
  for (const [id, f] of Object.entries(pending.failed || {})) if (nowSec - f.reservedAt > 2 * lag) delete pending.failed[id];

  return { findings, dbOnly, chainOnly };
}

/** Turn an unmatched `sent` row into a finding, given the contract's clock for its wallet. */
function judgeDbOnly(r, lastClaimAt) {
  const chainSaw = lastClaimAt >= r.reservedAt;
  return {
    kind: "db-only", id: r.id,
    detail: chainSaw
      ? `row #${r.id} sent to ${short(r.address)} (tx ${short(r.tx)}) has no Dispensed event, but the contract's lastClaimAt agrees a claim landed — the event scan missed it`
      : `row #${r.id} sent to ${short(r.address)} (tx ${short(r.tx)}) has no Dispensed event and the contract's lastClaimAt (${lastClaimAt || "never"}) predates the reservation — the row is wrong`,
  };
}

function judgeChainOnly(e) {
  return {
    kind: "chain-only", tx: e.tx,
    detail: e.failedRow
      ? `Dispensed to ${short(e.claimant)} in tx ${short(e.tx)} but row #${e.failedRow.id} is failed ("${String(e.failedRow.error || "").slice(0, 60)}") — paid, then not recorded; the wallet can reserve again`
      : `Dispensed to ${short(e.claimant)} in tx ${short(e.tx)} with no row at all — dispensed outside the worker`,
  };
}

const STANDING = new Set(["stale", "unknown"]);

function plan(state, findings, nowSec, opts = OPTS) {
  state.alerted ??= {};
  const alerts = [], recoveries = [];
  const present = new Set(findings.filter((f) => STANDING.has(f.kind)).map((f) => f.kind));
  for (const kind of Object.keys(state.alerted)) {
    if (!present.has(kind)) { recoveries.push(kind); delete state.alerted[kind]; }
  }
  const seen = new Set();
  for (const f of findings) {
    if (!STANDING.has(f.kind)) { alerts.push(f); continue; }
    if (seen.has(f.kind)) continue;
    seen.add(f.kind);
    if (shouldRealert(state.alerted[f.kind], nowSec, opts.realertMin * 60)) { alerts.push(f); state.alerted[f.kind] = nowSec; }
  }
  return { alerts, recoveries };
}

const short = (s) => (s ? `${String(s).slice(0, 10)}…` : "?");
function fmtMin(sec) { const s = Math.max(0, Math.round(sec)); return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`; }

module.exports = { reconcile, judgeDbOnly, judgeChainOnly, plan, main };

// ─── Self-test ──────────────────────────────────────────────────────────────

function selfTest() {
  const T = 1_800_000_000;
  const opts = { lagMin: 20, realertMin: 360 };
  const LAG = 20 * 60;
  const W = "0x00000000000000000000000000000000000000aa", V = "0x00000000000000000000000000000000000000bb";
  const TX = "0x" + "11".repeat(32), TX2 = "0x" + "22".repeat(32);
  const row = (id, over = {}) => ({ id, address: W, status: "sent", tx: TX, reservedAt: T, sentAt: T + 5, error: null, ...over });
  const ev  = (over = {}) => ({ tx: TX, claimant: W, block: 100, ts: T + 4, ...over });
  const fresh = () => ({ rows: {}, events: {} });
  const kinds = (r) => r.findings.map((f) => f.kind);

  let pass = 0, fail = 0;
  const eq = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) pass++;
    else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  };

  // Pairing.
  { const p = fresh(); const r = reconcile(p, [row(1)], [ev()], T + 10, opts);
    eq("row and event pair by tx", [kinds(r), r.dbOnly.length, r.chainOnly.length], [[], 0, 0]);
    eq("paired items leave pending", [Object.keys(p.rows).length, Object.keys(p.events).length], [0, 0]); }
  { const p = fresh(); const r = reconcile(p, [row(1, { tx: TX.toUpperCase().replace("0X", "0x") })], [ev()], T + 10, opts);
    eq("tx hash case-insensitive", r.dbOnly.length, 0); }
  { const p = fresh(); reconcile(p, [row(1)], [], T + 10, opts);
    const r = reconcile(p, [], [ev()], T + 60, opts);
    eq("event arriving a run later pairs", [r.dbOnly.length, Object.keys(p.rows).length], [0, 0]); }
  { const p = fresh(); reconcile(p, [], [ev()], T + 10, opts);
    const r = reconcile(p, [row(1)], [], T + 60, opts);
    eq("row arriving a run later pairs", [r.chainOnly.length, Object.keys(p.events).length], [0, 0]); }

  // Aging.
  { const p = fresh(); const r = reconcile(p, [row(1)], [], T + LAG, opts);
    eq("unmatched row inside lag waits", [r.dbOnly.length, Object.keys(p.rows).length], [0, 1]); }
  { const p = fresh(); const r = reconcile(p, [row(1)], [], T + 5 + LAG + 1, opts);
    eq("unmatched row past lag is db-only", [r.dbOnly.map((x) => x.id), Object.keys(p.rows).length], [[1], 0]); }
  { const p = fresh(); const r = reconcile(p, [], [ev()], T + 4 + LAG + 1, opts);
    eq("unmatched event past lag is chain-only", [r.chainOnly.map((x) => x.tx), Object.keys(p.events).length], [[TX], 0]);
    eq("chain-only with no failed row", r.chainOnly[0].failedRow, null); }
  { const p = fresh(); const r = reconcile(p, [row(1, { status: "failed", tx: null, sentAt: null, error: "expired: worker never dispatched" })], [ev()], T + 4 + LAG + 1, opts);
    eq("chain-only explained by a failed row", r.chainOnly[0].failedRow?.id, 1); }
  { const p = fresh(); const r = reconcile(p, [row(1, { status: "failed", tx: null, sentAt: null, address: V })], [ev()], T + 4 + LAG + 1, opts);
    eq("failed row for another wallet does not explain", r.chainOnly[0].failedRow, null); }
  { const p = fresh(); const r = reconcile(p, [row(1, { status: "failed", tx: null, sentAt: null, reservedAt: T - 2 * LAG })], [ev()], T + 4 + LAG + 1, opts);
    eq("failed row outside the lag does not explain", r.chainOnly[0].failedRow, null); }

  // Mismatch and stale.
  { const p = fresh(); const r = reconcile(p, [row(1)], [ev({ claimant: V })], T + 10, opts);
    eq("different claimant is mismatch", kinds(r), ["mismatch"]);
    eq("mismatch still consumes the pair", Object.keys(p.rows).length + Object.keys(p.events).length, 0); }
  { const p = fresh(); const r = reconcile(p, [row(1, { status: "reserved", tx: null, sentAt: null })], [], T + LAG, opts);
    eq("reserved inside lag is fine", kinds(r), []); }
  { const p = fresh(); const r = reconcile(p, [row(1, { status: "reserved", tx: null, sentAt: null })], [], T + LAG + 1, opts);
    eq("reserved past lag is stale", kinds(r), ["stale"]); }
  { const p = fresh(); const r = reconcile(p, [row(1, { status: "sent", tx: null })], [], T + LAG + 1, opts);
    eq("sent row without a hash is ignored", [kinds(r), r.dbOnly.length], [[], 0]); }
  { const p = fresh(); const r = reconcile(p, [row(1), row(2, { tx: TX2 })], [ev(), ev({ tx: TX2, claimant: V })], T + 10, opts);
    eq("second pair with wrong wallet is the only finding", kinds(r), ["mismatch"]); }

  // Judgement by the contract clock.
  eq("db-only, chain saw a claim: scan missed it",  /event scan missed/.test(judgeDbOnly(row(1), T + 3).detail), true);
  eq("db-only, chain never saw it: row is wrong",   /row is wrong/.test(judgeDbOnly(row(1), T - 100).detail), true);
  eq("db-only, wallet never claimed",               /never/.test(judgeDbOnly(row(1), 0).detail), true);
  eq("chain-only with failed row names it",         /row #7 is failed/.test(judgeChainOnly({ ...ev(), failedRow: { id: 7, error: "x" } }).detail), true);
  eq("chain-only without row says outside worker",  /outside the worker/.test(judgeChainOnly({ ...ev(), failedRow: null }).detail), true);

  // Planning.
  const st = { alerted: {} };
  let p = plan(st, [{ kind: "db-only" }, { kind: "stale" }], T, opts);
  eq("first run alerts both",                 p.alerts.map((f) => f.kind), ["db-only", "stale"]);
  p = plan(st, [{ kind: "chain-only" }, { kind: "stale" }, { kind: "stale" }], T + 60, opts);
  eq("one-off always, standing throttled",    p.alerts.map((f) => f.kind), ["chain-only"]);
  p = plan(st, [], T + 120, opts);
  eq("standing recovers once",                p.recoveries, ["stale"]);

  console.log(`self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (SELF_TEST) selfTest();

// ─── Live run ───────────────────────────────────────────────────────────────

const FAUCET_ABI = [
  "event Dispensed(address indexed claimant, uint256 ethToWallet, uint256 ethToPot, uint256 timbsOut)",
  "function lastClaimAt(address) view returns (uint256)",
];

async function main() {
  const provider   = new ethers.JsonRpcProvider(process.env.FAUCET_RPC || rpcFromConfig());
  const chainId    = Number((await provider.getNetwork()).chainId);
  const faucetAddr = process.env.FAUCET_ADDRESS ? ethers.getAddress(process.env.FAUCET_ADDRESS) : addrFromConfig("GasFaucet");
  const faucet     = new ethers.Contract(faucetAddr, FAUCET_ABI, provider);
  const iface      = new ethers.Interface(FAUCET_ABI);

  const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_URL || !SB_KEY) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY");
  const sbGet = async (pathq) => {
    const res = await fetch(`${SB_URL}/rest/v1/${pathq}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    if (!res.ok) throw new Error(`supabase GET ${pathq.split("?")[0]}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };

  const tg = makeTelegram({ token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID, mode: process.env.TELEGRAM_OPS_MODE, tag: "faucet-recon" });
  const out = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };

  const latest = await provider.getBlock("latest");
  const nowSec = latest.timestamp;

  const state = loadState(STATE_PATH, () => {
    let genesis;
    if (process.env.FAUCET_GENESIS_BLOCK) genesis = Number(process.env.FAUCET_GENESIS_BLOCK);
    else if (GENESIS_DEFAULT_BY_CHAIN[chainId] !== undefined) genesis = GENESIS_DEFAULT_BY_CHAIN[chainId];
    else { genesis = Math.max(0, latest.number - GENESIS_FALLBACK_SPAN); console.warn(`FAUCET_GENESIS_BLOCK unset — record starts at ${genesis}`); }
    return { chainId, faucet: faucetAddr, cursorBlock: genesis - 1, genesisBlock: genesis, sinceIso: null, cursorRowId: 0, pending: { rows: {}, events: {}, failed: {} }, alerted: {} };
  }, { matches: (s) => s.chainId === chainId && String(s.faucet).toLowerCase() === faucetAddr.toLowerCase(), label: "recon state" });

  let findings = [], summary = "";
  try {
    // Rows before the genesis block's time are outside the event record.
    if (!state.sinceIso) state.sinceIso = new Date((await provider.getBlock(state.genesisBlock)).timestamp * 1000).toISOString();

    // 1. New events and new rows.
    const from = state.cursorBlock + 1, to = latest.number;
    const raw = await scanEvents(provider, iface, "Dispensed", faucetAddr, from, to);
    const tsOf = await blockTimestamps(provider, raw.map(({ log }) => log.blockNumber));
    const events = raw.map(({ args, log }) => ({ tx: log.transactionHash.toLowerCase(), claimant: String(args.claimant).toLowerCase(), block: log.blockNumber, ts: tsOf[log.blockNumber] }));

    const rowsRaw = await sbGet(`faucet_claims?select=id,address,status,wallet_tx,reserved_at,sent_at,error&id=gt.${state.cursorRowId}&reserved_at=gte.${encodeURIComponent(state.sinceIso)}&order=id.asc&limit=1000`);
    const toSec = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);
    const rows = rowsRaw.map((r) => ({ id: r.id, address: String(r.address).toLowerCase(), status: r.status, tx: r.wallet_tx, reservedAt: toSec(r.reserved_at), sentAt: toSec(r.sent_at), error: r.error }));
    console.log(`faucet recon @ block ${to}  faucet ${faucetAddr}  chain ${chainId}  scan ${from} → ${to}  lag ${OPTS.lagMin} min`);
    console.log(`  new: ${events.length} Dispensed event(s), ${rows.length} row(s) (${rows.filter((r) => r.status === "sent").length} sent, ${rows.filter((r) => r.status === "failed").length} failed, ${rows.filter((r) => r.status === "reserved").length} reserved)`);

    // The row cursor advances only past rows that are resolved: a row read
    // while `reserved` must be read again once the worker resolves it, or its
    // eventual `sent` would look like an event with no row. Resolved rows
    // beyond the cursor (behind a still-open reservation) are remembered so
    // they are not fed twice. Reservations expire in fifteen minutes, so this
    // set stays small.
    const processed = new Set(state.processedRowIds || []);
    const fresh = rows.filter((r) => r.status === "reserved" || !processed.has(r.id));
    let cursorRowId = state.cursorRowId;
    for (const r of rows) { if (r.status === "reserved") break; cursorRowId = r.id; }

    // 2. Pair, age, judge.
    const r = reconcile(state.pending, fresh, events, nowSec);
    findings.push(...r.findings);
    for (const row of r.dbOnly) {
      const last = Number(await faucet.lastClaimAt(row.address, { blockTag: to }).catch(() => 0));
      findings.push(judgeDbOnly(row, last));
    }
    for (const e of r.chainOnly) findings.push(judgeChainOnly(e));

    state.cursorBlock = to;
    state.cursorRowId = cursorRowId;
    state.processedRowIds = rows.filter((r) => r.id > cursorRowId && r.status !== "reserved").map((r) => r.id);
    const waiting = Object.keys(state.pending.rows).length + Object.keys(state.pending.events).length;
    summary = `${events.length} event(s) and ${rows.length} row(s) this run · ${waiting} unmatched inside the lag · rows from #${state.cursorRowId + 1}`;
  } catch (e) {
    const inner = e?.error?.message || e?.info?.error?.message;
    findings.push({ kind: "unknown", detail: `read failed: ${e.shortMessage || e.message}${inner ? ` (${inner})` : ""}` });
  }
  out("assessed", "true");

  console.log(`  ${findings.length ? "✗" : "✓"} ${summary}`);
  for (const f of findings) console.log(`    [${f.kind}] ${f.detail}`);

  const { alerts, recoveries } = plan(state, findings, nowSec);
  if (DRY_RUN) {
    console.log(`\n(dry run) would alert: ${alerts.map((f) => f.kind).join(", ") || "none"}; recoveries: ${recoveries.join(", ") || "none"}`);
  } else {
    saveState(STATE_PATH, state);
    for (const f of alerts) await tg.notify(`${f.kind === "stale" ? "⚠️" : "🚨"} Faucet reconciliation [${f.kind}]\n${f.detail}`);
    if (recoveries.length) await tg.notify(`✅ Faucet reconciliation recovered: ${recoveries.join(", ")}`);
    if (!findings.length && REPORT) await tg.send(`✅ Faucet reconciliation OK\n${summary}`);
  }

  out("findings", String(findings.length));
  if (findings.length) {
    console.error(`\n${findings.length} finding(s): ${findings.map((f) => f.kind).join(", ")}`);
    process.exit(1);
  }
  console.log("\nfaucet reconciliation OK");
}

if (!SELF_TEST && require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(2); });
