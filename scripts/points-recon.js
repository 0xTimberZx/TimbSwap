// points-recon.js — does the leaderboard say what the chain says?
//
// The points scorer folds on-chain activity into Supabase behind a settlement
// lag and keeps its cursors in the `seasons` row. A cursor that skips a window
// under-scores everyone and a cursor that replays one over-scores everyone,
// and in both cases the board looks plausible. This witness keeps a shadow
// ledger: it folds the same events by its own path, with its own cursor,
// and compares every wallet's counters and display score to the board each
// run. It never reads the scorer's cursors (KEEPER_FLEET.md rule 2), only the
// season's configuration (start block and round, lag, minimum rounds, weights),
// and it never writes to Supabase.
//
// What is recomputed, exactly as the scorer defines it (points-scorer.js and
// the points_v3 migration):
//   rounds_played      +1 per settled round r ≤ current − lag_rounds whose
//                      GameRegistry.getRoundEntrants(r) lists the wallet
//   nudge_swaps        a TimbsEthPair Swap in a tx that also emitted ScrollNudged,
//                      attributed to tx.from, one per Swap event
//   plain_swaps        a Swap in a tx with no ScrollNudged
//   panel_nudges       ScrollNudged events in a tx with no Swap, N per tx
//   tickets_activated  a TicketActivated whose ticket's owner is among that
//                      round's entrants
//   farm_claims        TimbFarm RewardsClaimed ≥ 25 TIMBS; stake_claims likewise
//   wins               WinningsClaimed per winner
//   faucet_claims      `sent` faucet_claims rows reserved at or before the lag block
//   display_tp         the counters × seasons.weights, zero under min_rounds or
//                      with a sybil flag, rounded to two places
// The event window ends at the block where round (current − lag + 1) started,
// found from RoundStarted exactly as the scorer finds it.
//
// Findings:
//   over     the board's counter exceeds the shadow's: the scorer counted
//            something the chain does not show (a replayed window, a cursor
//            that moved backwards). Immediate
//   under    the board's counter is below the shadow's and has stayed so for
//            POINTS_GRACE_MIN: the scorer skipped a window. The grace covers the
//            scorer simply not having run since the lag block moved
//   tp       display_tp is not what the board's own counters and the weights
//            give: the SQL recompute and the weights disagree
//   unknown  the chain or the database could not be read
//
// State: scripts/points-recon-state.json — the shadow ledger, its block and
// round cursors, the pending under-counts with when they were first seen, and
// last-alerted stamps. Keyed to chain, contracts, season id and start block; a
// new season or a redeploy starts the ledger over.
//
// Env:
//   POINTS_RPC             optional; default = config.js public RPC (reads only)
//   POINTS_RECON_CHUNK     getLogs chunk (default 20000)
//   POINTS_GRACE_MIN       minutes an under-count may persist before it is a finding (default 180)
//   POINTS_MAX_ROUNDS      rounds folded per run (default 200, the scorer's cap)
//   POINTS_REALERT_MIN     minutes between repeat alerts for a standing finding (default 360)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   the board (RLS has no anon policy)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_OPS_MODE   optional alerts
//
// Flags: --self-test  --dry-run (no Telegram, no state write)  --report (summary even when healthy)

const fs   = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { addrFromConfig, rpcFromConfig } = require("./lib/config");
const { scanEvents } = require("./lib/logs");
const { loadState, saveState } = require("./lib/state");
const { makeTelegram, shouldRealert } = require("./lib/telegram");

const SELF_TEST = process.argv.includes("--self-test");
const DRY_RUN   = process.argv.includes("--dry-run");
const REPORT    = process.argv.includes("--report");

const STATE_PATH = path.join(__dirname, "points-recon-state.json");

const OPTS = {
  chunk:      Number(process.env.POINTS_RECON_CHUNK || 20_000),
  graceMin:   Number(process.env.POINTS_GRACE_MIN || 180),
  maxRounds:  Number(process.env.POINTS_MAX_ROUNDS || 200),
  realertMin: Number(process.env.POINTS_REALERT_MIN || 360),
  maxDetail:  10,
};
const CLAIM_MIN = 25n * 10n ** 18n;

// Counter keys: shadow ledger field → board column → weight key.
const COUNTERS = [
  ["rp", "rounds_played",     "round_played"],
  ["ta", "tickets_activated", "ticket_active"],
  ["ns", "nudge_swaps",       "nudge_swap"],
  ["ps", "plain_swaps",       "plain_swap"],
  ["pn", "panel_nudges",      "panel_nudge"],
  ["fc", "farm_claims",       "farm_claim"],
  ["sc", "stake_claims",      "stake_claim"],
  ["fa", "faucet_claims",     "faucet_claim"],
  ["w",  "wins",              "win"],
];
const DEFAULT_WEIGHTS = { round_played: 250, ticket_active: 200, nudge_swap: 25, plain_swap: 10, panel_nudge: 5, farm_claim: 50, stake_claim: 25, faucet_claim: 1, win: 0 };

// ─── Pure logic (exported for --self-test) ──────────────────────────────────

const blank = () => ({ rp: 0, ta: 0, ns: 0, ps: 0, pn: 0, fc: 0, sc: 0, w: 0 });
const bump = (ledger, addr, key, n = 1) => { const a = addr.toLowerCase(); (ledger[a] ??= blank())[key] += n; };

/**
 * Swaps and nudges the scorer's way. swaps: [{ tx }], nudges: [{ tx }],
 * fromOf: { tx → from|null }. Mutates ledger.
 */
function foldSwapsAndNudges(ledger, swaps, nudges, fromOf) {
  const nudgesByTx = new Map();
  for (const n of nudges) nudgesByTx.set(n.tx, (nudgesByTx.get(n.tx) || 0) + 1);
  const swapTxs = new Set();
  for (const s of swaps) {
    swapTxs.add(s.tx);
    const from = fromOf[s.tx];
    if (from) bump(ledger, from, nudgesByTx.has(s.tx) ? "ns" : "ps");
  }
  for (const [tx, n] of nudgesByTx) {
    if (swapTxs.has(tx)) continue;
    const from = fromOf[tx];
    if (from) bump(ledger, from, "pn", n);
  }
}

/** display_tp as points_recompute computes it from a board row. */
function expectedTp(row, weights, minRounds) {
  if (row.sybil_flag != null) return 0;
  if ((row.rounds_played || 0) < (minRounds || 0)) return 0;
  let tp = 0;
  for (const [, col, wk] of COUNTERS) tp += (row[col] || 0) * Number(weights?.[wk] ?? DEFAULT_WEIGHTS[wk]);
  return Math.round(tp * 100) / 100;
}

/**
 * Compare the shadow ledger (plus faucet counts) to the board rows.
 * pendingUnder: { "addr:col": firstSeenSec } — mutated.
 * Returns { findings, compared, matched }.
 */
function compare(ledger, faucetOf, rows, weights, minRounds, pendingUnder, nowSec, opts = OPTS) {
  const findings = [];
  const byAddr = new Map(rows.map((r) => [String(r.address).toLowerCase(), r]));
  const addrs = new Set([...Object.keys(ledger), ...Object.keys(faucetOf), ...byAddr.keys()]);
  const live = new Set();
  let matched = 0;

  for (const a of addrs) {
    const shadow = { ...blank(), ...(ledger[a] || {}), fa: faucetOf[a] || 0 };
    const row = byAddr.get(a) || {};
    let ok = true;
    for (const [key, col] of COUNTERS) {
      const want = shadow[key], have = row[col] || 0;
      if (have === want) continue;
      ok = false;
      if (have > want) {
        findings.push({ kind: "over", detail: `${short(a)} ${col}: board ${have}, chain ${want}` });
      } else {
        const k = `${a}:${col}`;
        live.add(k);
        pendingUnder[k] ??= nowSec;
        if (nowSec - pendingUnder[k] > opts.graceMin * 60) {
          findings.push({ kind: "under", detail: `${short(a)} ${col}: board ${have}, chain ${want}, behind for ${fmtMin(nowSec - pendingUnder[k])}` });
        }
      }
    }
    if (byAddr.has(a)) {
      const want = expectedTp(row, weights, minRounds), have = Number(row.display_tp || 0);
      if (Math.abs(have - want) > 0.005) { ok = false; findings.push({ kind: "tp", detail: `${short(a)} display_tp ${have} but the row's counters and weights give ${want}` }); }
    }
    if (ok) matched++;
  }
  for (const k of Object.keys(pendingUnder)) if (!live.has(k)) delete pendingUnder[k];
  return { findings, compared: addrs.size, matched };
}

const STANDING = new Set(["unknown"]);

function plan(state, findings, nowSec, opts = OPTS) {
  state.alerted ??= {};
  const alerts = [], recoveries = [];
  const present = new Set(findings.filter((f) => STANDING.has(f.kind)).map((f) => f.kind));
  // Only a standing kind recovers; a discrepancy kind's stamp is just its throttle.
  for (const kind of Object.keys(state.alerted)) if (STANDING.has(kind) && !present.has(kind)) { recoveries.push(kind); delete state.alerted[kind]; }
  // Discrepancies are re-sent once per re-alert interval per kind, not per run:
  // a skipped window is one problem across many wallets.
  const seen = new Set();
  for (const f of findings) {
    if (seen.has(f.kind)) continue;
    seen.add(f.kind);
    if (shouldRealert(state.alerted[f.kind], nowSec, opts.realertMin * 60)) { alerts.push(f.kind); state.alerted[f.kind] = nowSec; }
  }
  return { alerts, recoveries };
}

const short = (s) => `${String(s).slice(0, 10)}…`;
function fmtMin(sec) { const s = Math.max(0, Math.round(sec)); return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`; }

module.exports = { COUNTERS, blank, bump, foldSwapsAndNudges, expectedTp, compare, plan, main };

// ─── Self-test ──────────────────────────────────────────────────────────────

function selfTest() {
  const T = 1_800_000_000;
  const opts = { ...OPTS, graceMin: 180 };
  const A = "0x00000000000000000000000000000000000000aa", B = "0x00000000000000000000000000000000000000bb";
  let pass = 0, fail = 0;
  const eq = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) pass++;
    else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  };
  const kinds = (r) => r.findings.map((f) => f.kind);

  // Swap and nudge attribution.
  { const l = {}; foldSwapsAndNudges(l, [{ tx: "t1" }], [{ tx: "t1" }], { t1: A });
    eq("swap with nudge is a nudge-swap", l[A], { ...blank(), ns: 1 }); }
  { const l = {}; foldSwapsAndNudges(l, [{ tx: "t1" }], [], { t1: A });
    eq("swap without nudge is plain", l[A], { ...blank(), ps: 1 }); }
  { const l = {}; foldSwapsAndNudges(l, [], [{ tx: "t1" }, { tx: "t1" }, { tx: "t1" }], { t1: A });
    eq("nudges without swap are panel nudges, N per tx", l[A], { ...blank(), pn: 3 }); }
  { const l = {}; foldSwapsAndNudges(l, [{ tx: "t1" }, { tx: "t1" }], [{ tx: "t1" }], { t1: A });
    eq("two swap events in one tx count twice", l[A].ns, 2); }
  { const l = {}; foldSwapsAndNudges(l, [{ tx: "t1" }], [], { t1: null });
    eq("unattributable tx is skipped", l, {}); }
  { const l = {}; foldSwapsAndNudges(l, [{ tx: "t1" }], [{ tx: "t2" }], { t1: A, t2: B });
    eq("attribution is by tx.from", [l[A].ps, l[B].pn], [1, 1]); }

  // display_tp.
  const W = DEFAULT_WEIGHTS;
  eq("tp sums counters by weight",  expectedTp({ rounds_played: 2, nudge_swaps: 3, faucet_claims: 4 }, W, 2), 579);
  eq("tp zero under min_rounds",    expectedTp({ rounds_played: 1, nudge_swaps: 3 }, W, 2), 0);
  eq("tp zero with sybil flag",     expectedTp({ rounds_played: 5, sybil_flag: "x" }, W, 2), 0);
  eq("tp honours season weights",   expectedTp({ rounds_played: 1 }, { round_played: 7 }, 0), 7);
  eq("tp missing weight defaults",  expectedTp({ plain_swaps: 1 }, { round_played: 7 }, 0), 10);

  // Compare.
  const row = (over = {}) => ({ address: A, rounds_played: 2, tickets_activated: 0, nudge_swaps: 1, plain_swaps: 0, panel_nudges: 0, farm_claims: 0, stake_claims: 0, faucet_claims: 1, wins: 0, display_tp: 526, sybil_flag: null, ...over });
  const led = () => ({ [A]: { ...blank(), rp: 2, ns: 1 } });
  { const p = {}; const r = compare(led(), { [A]: 1 }, [row()], W, 2, p, T, opts);
    eq("exact match is clean", [kinds(r), r.compared, r.matched], [[], 1, 1]); }
  { const p = {}; const r = compare(led(), { [A]: 1 }, [row({ nudge_swaps: 2, display_tp: 551 })], W, 2, p, T, opts);
    eq("board above chain is over", kinds(r), ["over"]); }
  { const p = {}; const r = compare(led(), { [A]: 1 }, [row({ nudge_swaps: 0, display_tp: 501 })], W, 2, p, T, opts);
    eq("board below chain waits inside grace", [kinds(r), Object.keys(p)], [[], [`${A}:nudge_swaps`]]); }
  { const p = { [`${A}:nudge_swaps`]: T - 181 * 60 }; const r = compare(led(), { [A]: 1 }, [row({ nudge_swaps: 0, display_tp: 501 })], W, 2, p, T, opts);
    eq("board below chain past grace is under", kinds(r), ["under"]); }
  { const p = { [`${A}:nudge_swaps`]: T - 181 * 60 }; compare(led(), { [A]: 1 }, [row()], W, 2, p, T, opts);
    eq("caught-up under is forgotten", Object.keys(p), []); }
  { const p = {}; const r = compare(led(), { [A]: 1 }, [row({ display_tp: 500 })], W, 2, p, T, opts);
    eq("wrong display_tp is tp", kinds(r), ["tp"]); }
  { const p = {}; const r = compare(led(), { [A]: 1 }, [], W, 2, p, T, opts);
    eq("missing row is under (pending)", [kinds(r), Object.keys(p).length], [[], 3]); }
  { const p = {}; const r = compare({}, {}, [row({ rounds_played: 0, nudge_swaps: 0, faucet_claims: 0, display_tp: 0 })], W, 2, p, T, opts);
    eq("all-zero row with no shadow is clean", kinds(r), []); }
  { const p = {}; const r = compare({}, {}, [row({ display_tp: 0 })], W, 2, p, T, opts);
    eq("row with counters and no shadow is over", kinds(r).filter((k) => k === "over").length, 3); }
  { const p = {}; const r = compare(led(), { [A]: 1 }, [row({ sybil_flag: "dup", display_tp: 0 })], W, 2, p, T, opts);
    eq("sybil row scores zero and matches", kinds(r), []); }
  { const p = {}; const r = compare(led(), { [A]: 1 }, [row({ rounds_played: 1, display_tp: 0 })], W, 2, p, T, opts);
    eq("under min_rounds scores zero (rounds pending under)", kinds(r), []); }

  // Planning: one alert per kind per interval.
  const st = { alerted: {} };
  let pl = plan(st, [{ kind: "over" }, { kind: "over" }, { kind: "tp" }], T, opts);
  eq("first run alerts each kind once", pl.alerts, ["over", "tp"]);
  pl = plan(st, [{ kind: "over" }], T + 60, opts);
  eq("same kind throttled", pl.alerts, []);
  pl = plan(st, [{ kind: "over" }], T + 361 * 60, opts);
  eq("re-alert after interval", pl.alerts, ["over"]);

  console.log(`self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (SELF_TEST) selfTest();

// ─── Live run ───────────────────────────────────────────────────────────────

const PRIZE_ABI = [
  "function currentRound() view returns (uint256)",
  "event WinningsClaimed(address indexed winner, uint256 indexed round, uint256 amount)",
  "event RoundStarted(uint256 indexed round, uint256 timestamp)",
  "event ScrollNudged(uint256 newPosition, uint256 indexed round, uint256 segment)",
];
const REGISTRY_ABI = [
  "function getRoundEntrants(uint256 round) view returns (address[])",
  "event TicketMinted(uint256 indexed ticketId, address indexed owner, bytes6 string6, uint256 playRound, uint256 lastEligibleRound, uint256 escrowAmount, address escrowToken, uint256 supersedes)",
  "event TicketActivated(uint256 indexed ticketId, uint256 indexed round)",
];
const PAIR_ABI  = ["event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"];
const FARM_ABI  = ["event RewardsClaimed(address indexed user, uint256 timbsAmount)"];
const STAKE_ABI = ["event RewardsClaimed(address indexed user, uint256 amount)"];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.POINTS_RPC || rpcFromConfig());
  const chainId  = Number((await provider.getNetwork()).chainId);
  const addr = { prize: addrFromConfig("TimbPrize"), registry: addrFromConfig("GameRegistry"), pair: addrFromConfig("TimbsEthPair") };
  const opt = (k) => { try { return addrFromConfig(k); } catch { return null; } };
  addr.farm = opt("TimbFarm"); addr.staking = opt("TimbStaking");
  const I = { prize: new ethers.Interface(PRIZE_ABI), registry: new ethers.Interface(REGISTRY_ABI), pair: new ethers.Interface(PAIR_ABI), farm: new ethers.Interface(FARM_ABI), stake: new ethers.Interface(STAKE_ABI) };
  const prize    = new ethers.Contract(addr.prize, PRIZE_ABI, provider);
  const registry = new ethers.Contract(addr.registry, REGISTRY_ABI, provider);

  const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_URL || !SB_KEY) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY");
  const sbGet = async (pathq) => {
    const res = await fetch(`${SB_URL}/rest/v1/${pathq}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    if (!res.ok) throw new Error(`supabase GET ${pathq.split("?")[0]}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  const sbAll = async (pathq, page = 1000) => { const out = []; for (let off = 0; ; off += page) { const b = await sbGet(`${pathq}&limit=${page}&offset=${off}`); out.push(...b); if (b.length < page) return out; } };

  const tg = makeTelegram({ token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID, mode: process.env.TELEGRAM_OPS_MODE, tag: "points-recon" });
  const out = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
  const head = await provider.getBlock("latest");
  const nowSec = head.timestamp;

  let findings = [], summary = "", state = null;
  try {
    // Season configuration only: never the scorer's cursors.
    const seasons = await sbGet("seasons?status=eq.active&select=id,slug,start_block,start_round,end_block,lag_rounds,min_rounds,weights&order=id.desc&limit=1");
    if (!seasons.length || seasons[0].start_block == null || seasons[0].start_round == null) {
      out("assessed", "true"); out("findings", "0");
      console.log("points recon: no active season with a start block — nothing to compare"); return;
    }
    const s = seasons[0];
    const startBlock = Number(s.start_block), startRound = Number(s.start_round);
    const LAG = Math.max(0, Number(s.lag_rounds ?? 4));

    state = loadState(STATE_PATH, () => ({
      chainId, ...addr, seasonId: s.id, startBlock, cursorBlock: startBlock - 1, lastRound: startRound - 1, ledger: {}, pendingUnder: {}, alerted: {},
    }), { matches: (x) => x.chainId === chainId && x.seasonId === s.id && x.startBlock === startBlock && ["prize", "registry", "pair"].every((k) => String(x[k]).toLowerCase() === addr[k].toLowerCase()), label: "recon state" });

    // The lag block, the scorer's way: where round (current − lag + 1) started.
    const currentRound = Number(await prize.currentRound());
    const lastFoldable = currentRound - LAG;
    let lagBlock = head.number;
    if (LAG > 0) {
      lagBlock = startBlock - 1;
      const topic = I.prize.getEvent("RoundStarted").topicHash;
      const STEP = 50_000;
      for (let hi = head.number; hi >= startBlock; hi -= STEP) {
        const lo = Math.max(startBlock, hi - STEP + 1);
        const hits = await provider.getLogs({ address: addr.prize, topics: [topic, ethers.zeroPadValue(ethers.toBeHex(lastFoldable + 1), 32)], fromBlock: lo, toBlock: hi });
        if (hits.length) { lagBlock = hits[hits.length - 1].blockNumber; break; }
      }
    }
    const toBlock = Math.min(lagBlock, s.end_block != null ? Number(s.end_block) : lagBlock);
    const fromBlock = state.cursorBlock + 1;
    console.log(`points recon · season ${s.slug} · round ${currentRound} (foldable ≤ ${lastFoldable}) · window ${fromBlock} → ${toBlock} · ledger ${Object.keys(state.ledger).length} wallets`);

    // 1. Rounds.
    const entrantsOf = new Map();
    const entrants = async (r) => { if (!entrantsOf.has(r)) entrantsOf.set(r, new Set((await registry.getRoundEntrants(r)).map((a) => a.toLowerCase()))); return entrantsOf.get(r); };
    let roundsAdded = 0;
    const endRound = Math.min(lastFoldable, state.lastRound + OPTS.maxRounds);
    for (let r = state.lastRound + 1; r <= endRound; r++) {
      for (const a of await entrants(r)) bump(state.ledger, a, "rp");
      state.lastRound = r; roundsAdded++;
    }

    // 2. Events in the lagged window.
    let swapsSeen = 0;
    if (toBlock >= fromBlock) {
      const sc = (iface, name, address, o = {}) => scanEvents(provider, iface, name, address, fromBlock, toBlock, { chunk: OPTS.chunk, ...o });
      const fromCache = new Map();
      const txFrom = async (h) => { if (!fromCache.has(h)) { try { const t = await provider.getTransaction(h); fromCache.set(h, t?.from ? t.from.toLowerCase() : null); } catch { fromCache.set(h, null); } } return fromCache.get(h); };

      const swaps  = (await sc(I.pair, "Swap", addr.pair)).map(({ log }) => ({ tx: log.transactionHash }));
      const nudges = (await sc(I.prize, "ScrollNudged", addr.prize)).map(({ log }) => ({ tx: log.transactionHash }));
      const fromOf = {};
      for (const tx of new Set([...swaps, ...nudges].map((e) => e.tx))) fromOf[tx] = await txFrom(tx);
      foldSwapsAndNudges(state.ledger, swaps, nudges, fromOf);
      swapsSeen = swaps.length;

      const acts = await sc(I.registry, "TicketActivated", addr.registry);
      if (acts.length) {
        const owners = new Map();
        for (const { args } of await sc(I.registry, "TicketMinted", addr.registry)) owners.set(args.ticketId.toString(), String(args.owner).toLowerCase());
        const mintTopic = I.registry.getEvent("TicketMinted").topicHash;
        for (const { args, log } of acts) {
          const id = args.ticketId.toString(), r = Number(args.round);
          if (r > lastFoldable) continue;
          let owner = owners.get(id);
          if (!owner) {
            const minted = await provider.getLogs({ address: addr.registry, topics: [mintTopic, ethers.zeroPadValue(ethers.toBeHex(args.ticketId), 32)], fromBlock: Math.max(0, startBlock - 2_000_000), toBlock: log.blockNumber }).catch(() => []);
            owner = minted.length ? String(I.registry.parseLog(minted[0]).args.owner).toLowerCase() : null;
            if (owner) owners.set(id, owner);
          }
          if (!owner) continue;
          let ent; try { ent = await entrants(r); } catch { ent = new Set(); }
          if (ent.has(owner)) bump(state.ledger, owner, "ta");
        }
      }
      if (addr.farm)    for (const { args } of await sc(I.farm, "RewardsClaimed", addr.farm))     if (BigInt(args.timbsAmount) >= CLAIM_MIN) bump(state.ledger, args.user, "fc");
      if (addr.staking) for (const { args } of await sc(I.stake, "RewardsClaimed", addr.staking)) if (BigInt(args.amount) >= CLAIM_MIN)      bump(state.ledger, args.user, "sc");
      for (const { args } of await sc(I.prize, "WinningsClaimed", addr.prize)) bump(state.ledger, args.winner, "w");
      state.cursorBlock = toBlock;
    }

    // 3. Faucet drips up to the lag block's time, from the ledger table itself.
    const faucetOf = {};
    if (toBlock >= startBlock) {
      const until = new Date((await provider.getBlock(toBlock)).timestamp * 1000).toISOString();
      for (const r of await sbAll(`faucet_claims?select=address&status=eq.sent&reserved_at=lte.${encodeURIComponent(until)}`)) {
        const a = String(r.address).toLowerCase(); faucetOf[a] = (faucetOf[a] || 0) + 1;
      }
    }

    // 4. The board.
    const rows = await sbAll(`points_wallets?select=address,rounds_played,tickets_activated,nudge_swaps,plain_swaps,panel_nudges,farm_claims,stake_claims,faucet_claims,wins,display_tp,sybil_flag&season_id=eq.${s.id}`);
    const c = compare(state.ledger, faucetOf, rows, s.weights, Number(s.min_rounds ?? 0), state.pendingUnder, nowSec);
    findings = c.findings;
    summary = `${c.compared} wallets compared, ${c.matched} match · +${roundsAdded} rounds, ${swapsSeen} swaps this run · ${Object.keys(state.pendingUnder).length} under-count(s) inside grace`;
  } catch (e) {
    const inner = e?.error?.message || e?.info?.error?.message;
    findings = [{ kind: "unknown", detail: `read failed: ${e.shortMessage || e.message}${inner ? ` (${inner})` : ""}` }];
  }
  out("assessed", "true");

  console.log(`  ${findings.length ? "✗" : "✓"} ${summary}`);
  for (const f of findings.slice(0, OPTS.maxDetail)) console.log(`    [${f.kind}] ${f.detail}`);
  if (findings.length > OPTS.maxDetail) console.log(`    …and ${findings.length - OPTS.maxDetail} more`);

  if (state) {
    const { alerts, recoveries } = plan(state, findings, nowSec);
    if (DRY_RUN) {
      console.log(`\n(dry run) would alert: ${alerts.join(", ") || "none"}; recoveries: ${recoveries.join(", ") || "none"}`);
    } else {
      saveState(STATE_PATH, state);
      for (const kind of alerts) {
        const of = findings.filter((f) => f.kind === kind);
        await tg.notify(`🚨 Points reconciliation [${kind}] × ${of.length}\n` + of.slice(0, 5).map((f) => f.detail).join("\n") + (of.length > 5 ? `\n…and ${of.length - 5} more` : ""));
      }
      if (recoveries.length) await tg.notify(`✅ Points reconciliation recovered: ${recoveries.join(", ")}`);
      if (!findings.length && REPORT) await tg.send(`✅ Points reconciliation OK\n${summary}`);
    }
  }

  out("findings", String(findings.length));
  if (findings.length) {
    console.error(`\n${findings.length} finding(s): ${[...new Set(findings.map((f) => f.kind))].join(", ")}`);
    process.exit(1);
  }
  console.log("\npoints reconciliation OK");
}

if (!SELF_TEST && require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(2); });
