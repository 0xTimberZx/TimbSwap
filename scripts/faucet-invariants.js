// faucet-invariants.js
// Read-only monitor for the GasFaucet claim record. Scans `Dispensed` events and
// checks them against what the cooldown and the era PERMIT — the detection half
// of the faucet guard (dev-docs/EMISSIONS_SCHEDULE.md §7). The on-chain
// per-wallet cap is the prevention half; this catches the case that cap cannot:
// a claim that should not have been possible at all.
//
// Invariants:
//   A. GAP         every wallet's consecutive claims are ≥ cooldown apart.
//                  Exact. A breach means the cooldown was BYPASSED (dispatcher
//                  bug, contract bug, or a redeploy that lost lastClaimAt) — a
//                  different and worse failure than the budget draining.
//   B. COUNT       per wallet, claims ≤ floor((last − first) / cooldown) + 1.
//                  Implied by A; stated because it is the bound as spoken.
//   C. AGGREGATE   total claims ≤ unique wallets × (floor((now − eraStart)/cooldown) + 1).
//   D. TALLY       the contract's timbsClaimedBy(w) equals Σ timbsOut(w) from
//                  events, and never exceeds maxTimbsPerWallet when that is set.
//                  Catches accounting drift between the contract and the record.
//   E. PACING      (advisory) TIMBS spent / cap vs era elapsed / era length —
//                  warns when spend runs ahead of time by more than PACE_SLACK.
//   F. CONCENTRATION (informational) top wallets' share of the total.
//
// A, B, C, D failing exits 1 and alerts. E warns. F is printed.
//
// State: scripts/faucet-invariants-state.json — a cursor block plus one compact
// entry per wallet {count, first, last, timbs}. Only NEW events are fetched each
// run, so the block-timestamp lookups stay small after the first backfill. The
// file is keyed by chain + faucet address and starts over if either changes.
//
// Env:
//   FAUCET_RPC             optional; default = config.js PUBLIC_RPCS[0] / canonical.
//                          NOT the ARB_SEPOLIA_RPC secret: metered providers cap
//                          eth_getLogs to tiny block ranges (observed live: 10 blocks)
//                          and the first-run backfill is millions of blocks wide. The
//                          canonical public endpoint serves large ranges; the epoch
//                          keeper scans it the same way.
//   FAUCET_ADDRESS         optional override; default = config.js ADDRESSES.GasFaucet
//   FAUCET_GENESIS_BLOCK   first block to scan on the first run. Unset → the per-chain
//                          default below (the testnet faucet's deploy) or, on a chain
//                          with none, latest − 3,000,000 (~8 days on Arbitrum). Set it
//                          on mainnet — the fallback can miss older claims and then
//                          A/B/C are checked on a partial record.
//   FAUCET_ERA_DAYS        era length for C and E (default 250)
//   FAUCET_ERA_START       unix seconds; default = timestamp of the first claim seen
//   FAUCET_PACE_SLACK      E tolerance (default 1.5 = spend may run 50 % ahead of time)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   optional alerts
//
// Flags: --self-test (synthetic cases, no network)  --report (Telegram summary even when healthy)

const { ethers } = require("ethers");
const path = require("path");
const { addrFromConfig, rpcFromConfig } = require("./lib/config");
const { scanEvents, blockTimestamps } = require("./lib/logs");
const { loadState, saveState } = require("./lib/state");
const { makeTelegram } = require("./lib/telegram");

const SELF_TEST = process.argv.includes("--self-test");
const REPORT    = process.argv.includes("--report");

const STATE_PATH = path.join(__dirname, "faucet-invariants-state.json");
const LOG_CHUNK  = Number(process.env.FAUCET_LOG_CHUNK || 40_000);
const ERA_DAYS   = Number(process.env.FAUCET_ERA_DAYS || 250);
const PACE_SLACK = Number(process.env.FAUCET_PACE_SLACK || 1.5);
const GENESIS_FALLBACK_SPAN = 3_000_000;
// First-run scan start per chain when FAUCET_GENESIS_BLOCK is unset. The
// testnet value is the epoch keeper's block from the run just before the
// GasFaucet address landed in config.js (2026-09-15 04:56 UTC), so it precedes
// the deploy. Mainnet has no entry on purpose: set the variable at deploy time.
const GENESIS_DEFAULT_BY_CHAIN = { 421614: 309_038_324 };

const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// config.js readers: lib/config.js (addrFromConfig refuses the zero address;
// rpcFromConfig is the canonical PUBLIC endpoint with the same fallbacks).

// ─── ABI ────────────────────────────────────────────────────────────────────

const FAUCET_ABI = [
  "event Dispensed(address indexed claimant, uint256 ethToWallet, uint256 ethToPot, uint256 timbsOut)",
  "function cooldown() view returns (uint256)",
  "function timbsCap() view returns (uint256)",
  "function timbsDistributed() view returns (uint256)",
  "function maxTimbsPerWallet() view returns (uint256)",
  "function timbsClaimedBy(address) view returns (uint256)",
];

// ─── Pure invariant logic (exported for --self-test) ────────────────────────
//
// state.wallets[addr] = { count, first, last, timbs }  (timbs as a decimal string)
// events: [{ wallet, ts, timbs (bigint), block, logIndex }] in chain order.

function freshState(chainId, faucet) {
  return { chainId, faucet, cursorBlock: null, eraStart: null, wallets: {} };
}

/** Fold new events into state, checking invariant A on the way. Returns breaches. */
function applyEvents(state, events, cooldown) {
  const breaches = [];
  for (const e of events) {
    const w = (state.wallets[e.wallet] ||= { count: 0, first: e.ts, last: null, timbs: "0" });
    if (w.last !== null && e.ts - w.last < cooldown) {
      breaches.push({
        kind: "A_GAP", wallet: e.wallet, block: e.block,
        detail: `claims ${e.ts - w.last}s apart, cooldown is ${cooldown}s (prev ts ${w.last}, this ts ${e.ts})`,
      });
    }
    w.count += 1;
    w.last   = e.ts;
    w.timbs  = (BigInt(w.timbs) + e.timbs).toString();
    if (state.eraStart === null || e.ts < state.eraStart) state.eraStart = e.ts;
  }
  return breaches;
}

/** Invariant B: per-wallet count bound. */
function checkCounts(state, cooldown) {
  const breaches = [];
  for (const [wallet, w] of Object.entries(state.wallets)) {
    const allowed = Math.floor((w.last - w.first) / cooldown) + 1;
    if (w.count > allowed) {
      breaches.push({ kind: "B_COUNT", wallet, detail: `${w.count} claims but only ${allowed} fit between first and last at this cooldown` });
    }
  }
  return breaches;
}

/** Invariant C: aggregate bound against the era clock. */
function checkAggregate(state, now, cooldown, eraStart) {
  const wallets = Object.values(state.wallets);
  const total   = wallets.reduce((a, w) => a + w.count, 0);
  const unique  = wallets.length;
  const periods = eraStart === null ? 0 : Math.floor((now - eraStart) / cooldown) + 1;
  const allowed = unique * periods;
  const ok = total <= allowed;
  return { ok, total, unique, periods, allowed,
           breach: ok ? null : { kind: "C_AGGREGATE", detail: `${total} claims > ${unique} wallets × ${periods} periods = ${allowed}` } };
}

/** Invariant D: contract tally vs record, and the per-wallet cap. */
function checkTally(state, onchain, maxPerWallet) {
  // onchain: { wallet -> bigint timbsClaimedBy }
  const breaches = [];
  for (const [wallet, w] of Object.entries(state.wallets)) {
    const rec = BigInt(w.timbs);
    const oc  = onchain[wallet];
    if (oc !== undefined && oc !== rec) {
      breaches.push({ kind: "D_TALLY", wallet, detail: `contract timbsClaimedBy=${oc} but events sum to ${rec}` });
    }
    if (maxPerWallet > 0n && rec > maxPerWallet) {
      breaches.push({ kind: "D_CAP", wallet, detail: `events sum ${rec} > maxTimbsPerWallet ${maxPerWallet}` });
    }
  }
  return breaches;
}

/** Invariant E (advisory): spend fraction vs time fraction. */
function checkPacing(distributed, cap, now, eraStart, eraSeconds, slack) {
  if (cap === 0n || eraStart === null) return { ok: true, spendFrac: 0, timeFrac: 0 };
  const spendFrac = Number(distributed * 10_000n / cap) / 10_000;
  const timeFrac  = Math.min(1, Math.max(0, (now - eraStart) / eraSeconds));
  const ok = timeFrac === 0 ? spendFrac <= 0.05 : spendFrac <= timeFrac * slack;
  return { ok, spendFrac, timeFrac,
           warn: ok ? null : `spend ${(spendFrac*100).toFixed(1)}% of cap vs ${(timeFrac*100).toFixed(1)}% of era elapsed (slack ×${slack})` };
}

/** F: top-N concentration. */
function concentration(state, n = 5) {
  const rows = Object.entries(state.wallets).map(([w, s]) => ({ wallet: w, timbs: BigInt(s.timbs), count: s.count }));
  const total = rows.reduce((a, r) => a + r.timbs, 0n);
  rows.sort((a, b) => (b.timbs > a.timbs ? 1 : b.timbs < a.timbs ? -1 : 0));
  const top = rows.slice(0, n);
  const topSum = top.reduce((a, r) => a + r.timbs, 0n);
  return { total, top, topShare: total === 0n ? 0 : Number(topSum * 10_000n / total) / 10_000 };
}

module.exports = { freshState, applyEvents, checkCounts, checkAggregate, checkTally, checkPacing, concentration, main };

// ─── Self-test ──────────────────────────────────────────────────────────────

function selfTest() {
  const C = 86_400, T0 = 1_000_000;
  let pass = 0, fail = 0;
  const t = (name, cond) => { if (cond) pass++; else { fail++; console.log("  FAIL", name); } };
  const ev = (wallet, ts, timbs = 100n) => ({ wallet, ts, timbs, block: Math.floor(ts / 12), logIndex: 0 });

  // A: exactly-on-boundary is allowed; one second short is a breach.
  { const s = freshState(1, "0xF");
    const b = applyEvents(s, [ev("a", T0), ev("a", T0 + C)], C);
    t("A allows a gap of exactly one cooldown", b.length === 0); }
  { const s = freshState(1, "0xF");
    const b = applyEvents(s, [ev("a", T0), ev("a", T0 + C - 1)], C);
    t("A flags one second short", b.length === 1 && b[0].kind === "A_GAP"); }
  { const s = freshState(1, "0xF");
    const b = applyEvents(s, [ev("a", T0), ev("b", T0 + 10), ev("a", T0 + C), ev("b", T0 + 10 + C)], C);
    t("A is per wallet (interleaved wallets fine)", b.length === 0); }
  // A across runs: state carries `last`, so a fresh batch is checked against it.
  { const s = freshState(1, "0xF");
    applyEvents(s, [ev("a", T0)], C);
    const b = applyEvents(s, [ev("a", T0 + 100)], C);
    t("A checks a new batch against persisted last", b.length === 1); }

  // B: derived bound agrees with A on a clean record and flags a packed one.
  { const s = freshState(1, "0xF");
    applyEvents(s, [ev("a", T0), ev("a", T0 + C), ev("a", T0 + 2 * C)], C);
    t("B clean: 3 claims over 2 cooldowns", checkCounts(s, C).length === 0); }
  { const s = freshState(1, "0xF");
    s.wallets["a"] = { count: 5, first: T0, last: T0 + 2 * C, timbs: "500" }; // 5 claims where 3 fit
    t("B flags a packed record", checkCounts(s, C).length === 1); }

  // C: aggregate bound.
  { const s = freshState(1, "0xF");
    applyEvents(s, [ev("a", T0), ev("b", T0), ev("a", T0 + C)], C);
    const r = checkAggregate(s, T0 + C, C, T0);      // 2 periods × 2 wallets = 4 allowed, 3 claimed
    t("C within bound", r.ok && r.allowed === 4 && r.total === 3);
    const r2 = checkAggregate({ wallets: { a: { count: 9, first: T0, last: T0, timbs: "0" } } }, T0 + C, C, T0);
    t("C flags impossible total", !r2.ok && r2.breach.kind === "C_AGGREGATE"); }

  // D: tally + cap.
  { const s = freshState(1, "0xF");
    applyEvents(s, [ev("a", T0, 100n), ev("a", T0 + C, 100n)], C);
    t("D matches when contract agrees", checkTally(s, { a: 200n }, 0n).length === 0);
    t("D flags drift", checkTally(s, { a: 150n }, 0n).length === 1);
    t("D flags over-cap record", checkTally(s, { a: 200n }, 150n).some((b) => b.kind === "D_CAP"));
    t("D ignores wallets not queried", checkTally(s, {}, 0n).length === 0); }

  // E: pacing.
  { const era = 250 * 86_400;
    t("E ok when spend tracks time",      checkPacing(100n, 1000n, T0 + era / 10, T0, era, 1.5).ok);   // 10% vs 10%
    t("E ok within slack",                checkPacing(140n, 1000n, T0 + era / 10, T0, era, 1.5).ok);   // 14% vs 15% allowed
    t("E warns when far ahead",          !checkPacing(400n, 1000n, T0 + era / 10, T0, era, 1.5).ok);   // 40% vs 15%
    t("E ok with no cap",                 checkPacing(400n, 0n,    T0 + 1,        T0, era, 1.5).ok); }

  // F: concentration.
  { const s = freshState(1, "0xF");
    applyEvents(s, [ev("a", T0, 900n), ev("b", T0, 100n)], C);
    const c = concentration(s, 1);
    t("F top-1 share", c.topShare === 0.9 && c.top[0].wallet === "a"); }

  console.log(`self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (SELF_TEST) selfTest();

// ─── Live run ───────────────────────────────────────────────────────────────

// Telegram: plain text, previews off, best-effort (lib/telegram.js). No
// ops-mode switch, as before: this monitor's messages are breaches and pacing.
const telegram = makeTelegram({ token: TG_TOKEN, chatId: TG_CHAT_ID, tag: "faucet-invariants" });
const tg = (text) => telegram.send(text);

// Events in chain order with block timestamps: lib/logs.js, chunked at
// LOG_CHUNK, one getBlock per distinct block.
async function fetchNewEvents(provider, faucetAddr, iface, fromBlock, toBlock) {
  const evs = await scanEvents(provider, iface, "Dispensed", faucetAddr, fromBlock, toBlock, { chunk: LOG_CHUNK });
  const raw = evs.map(({ args, log }) => ({ wallet: ethers.getAddress(args.claimant), timbs: BigInt(args.timbsOut), block: log.blockNumber, logIndex: log.index }));
  const tsOf = await blockTimestamps(provider, raw.map((r) => r.block));
  return raw.map((r) => ({ ...r, ts: tsOf[r.block] }));
}

async function main() {
  const provider   = new ethers.JsonRpcProvider(process.env.FAUCET_RPC || rpcFromConfig());
  const chainId    = Number((await provider.getNetwork()).chainId);
  const faucetAddr = process.env.FAUCET_ADDRESS ? ethers.getAddress(process.env.FAUCET_ADDRESS) : addrFromConfig("GasFaucet");
  const faucet     = new ethers.Contract(faucetAddr, FAUCET_ABI, provider);
  const iface      = new ethers.Interface(FAUCET_ABI);

  const latest = await provider.getBlockNumber();
  const now    = (await provider.getBlock(latest)).timestamp;
  const [cooldownBn, cap, distributed, maxPerWallet] = await Promise.all([
    faucet.cooldown(), faucet.timbsCap(), faucet.timbsDistributed(), faucet.maxTimbsPerWallet().catch(() => 0n),
  ]);
  const cooldown = Number(cooldownBn);

  // The record is keyed to chain and faucet; a redeploy starts it over.
  const state = loadState(STATE_PATH, () => freshState(chainId, faucetAddr), {
    matches: (s) => s.chainId === chainId && String(s.faucet).toLowerCase() === faucetAddr.toLowerCase(),
    label: "invariants state",
  });
  let fromBlock;
  if (state.cursorBlock !== null) fromBlock = state.cursorBlock + 1;
  else if (process.env.FAUCET_GENESIS_BLOCK) fromBlock = Number(process.env.FAUCET_GENESIS_BLOCK);
  else if (GENESIS_DEFAULT_BY_CHAIN[chainId] !== undefined) {
    fromBlock = GENESIS_DEFAULT_BY_CHAIN[chainId];
    console.log(`FAUCET_GENESIS_BLOCK unset — using the chain ${chainId} default ${fromBlock}`);
  } else {
    fromBlock = Math.max(0, latest - GENESIS_FALLBACK_SPAN);
    console.warn(`FAUCET_GENESIS_BLOCK unset — scanning from ${fromBlock} (latest − ${GENESIS_FALLBACK_SPAN}). Older claims are NOT in the record; set the var.`);
  }

  console.log(`faucet ${faucetAddr} chain ${chainId}  cooldown=${cooldown}s  cap=${ethers.formatEther(cap)} distributed=${ethers.formatEther(distributed)} maxPerWallet=${ethers.formatEther(maxPerWallet)}`);
  console.log(`scan ${fromBlock} → ${latest}`);

  const events = await fetchNewEvents(provider, faucetAddr, iface, fromBlock, latest);
  console.log(`new Dispensed events: ${events.length}`);

  const breaches = [];
  breaches.push(...applyEvents(state, events, cooldown));
  state.cursorBlock = latest;
  saveState(STATE_PATH, state);

  const eraStart = process.env.FAUCET_ERA_START ? Number(process.env.FAUCET_ERA_START) : state.eraStart;
  breaches.push(...checkCounts(state, cooldown));
  const agg = checkAggregate(state, now, cooldown, eraStart);
  if (agg.breach) breaches.push(agg.breach);

  // D only for wallets touched this run plus a bounded sample — a full sweep
  // every run would be one call per wallet.
  const touched = [...new Set(events.map((e) => e.wallet))];
  const sample  = Object.keys(state.wallets).filter((w) => !touched.includes(w)).slice(0, 25);
  const toCheck = [...touched, ...sample];
  const onchain = {};
  for (let i = 0; i < toCheck.length; i += 10) {
    const slice = toCheck.slice(i, i + 10);
    const got = await Promise.all(slice.map((w) => faucet.timbsClaimedBy(w).catch(() => undefined)));
    got.forEach((v, k) => { if (v !== undefined) onchain[slice[k]] = BigInt(v); });
  }
  breaches.push(...checkTally(state, onchain, BigInt(maxPerWallet)));

  const pace = checkPacing(BigInt(distributed), BigInt(cap), now, eraStart, ERA_DAYS * 86_400, PACE_SLACK);
  const conc = concentration(state, 5);

  // ── Report ──
  const eraDay = eraStart ? ((now - eraStart) / 86_400).toFixed(1) : "?";
  console.log(`\nrecord: ${agg.total} claims from ${agg.unique} wallets · era day ${eraDay} · allowed ≤ ${agg.allowed}`);
  console.log(`pacing: spend ${(pace.spendFrac*100).toFixed(1)}% of cap at ${(pace.timeFrac*100).toFixed(1)}% of era ${pace.ok ? "OK" : "WARN"}`);
  console.log(`top-5 share: ${(conc.topShare*100).toFixed(1)}%` + conc.top.map((r) => `\n  ${r.wallet}  ${r.count} claims  ${ethers.formatEther(r.timbs)} TIMBS`).join(""));

  if (breaches.length) {
    console.error(`\nINVARIANT BREACH (${breaches.length}):`);
    for (const b of breaches) console.error(`  [${b.kind}] ${b.wallet || ""} ${b.detail}`);
    await tg(`🚨 Faucet invariant breach on ${faucetAddr.slice(0, 8)}… (${breaches.length})\n` +
             breaches.slice(0, 8).map((b) => `[${b.kind}] ${(b.wallet || "").slice(0, 10)} ${b.detail}`).join("\n") +
             (breaches.length > 8 ? `\n…and ${breaches.length - 8} more` : ""));
    process.exit(1);
  }
  if (!pace.ok) {
    console.warn(`\nPACING WARN: ${pace.warn}`);
    await tg(`⚠️ Faucet pacing: ${pace.warn}\n${agg.total} claims / ${agg.unique} wallets, era day ${eraDay}`);
  } else if (REPORT) {
    await tg(`✅ Faucet record OK: ${agg.total} claims / ${agg.unique} wallets, era day ${eraDay}, spend ${(pace.spendFrac*100).toFixed(1)}% of cap, top-5 ${(conc.topShare*100).toFixed(1)}%`);
  }
  console.log("\ninvariants OK");
}

// Only run the live path when executed directly, so a test can drive main().
if (!SELF_TEST && require.main === module) main().catch((e) => {
  // ethers wraps provider errors ("could not coalesce error"); surface the RPC's
  // own message and the method so a range cap or a bad endpoint is readable.
  const inner = e?.error?.message || e?.info?.error?.message;
  const method = e?.info?.payload?.method;
  console.error(e.shortMessage || e.message || e);
  if (inner || method) console.error(`  rpc: ${method || "?"} → ${inner || "?"}`);
  process.exit(2);
});
