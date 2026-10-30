// solvency-watch.js
// Read-only watchdog for the game's ETH backing: does the ETH the contracts
// hold cover what they owe? The live twin of the forge invariants
// RegistryHoldsAllEthPrincipal, EscrowBacksPrizeBooks and
// TerminalTicketsHoldNothing (tests/invariants/GameInvariants.t.sol).
//
// Invariants:
//   W1 PRINCIPAL  GameRegistry ETH ≥ Σ escrowAmount of every ETH ticket, all
//                 generations (full sweep of getTicket, batched via Multicall3).
//   W2 METER      GameRegistry ETH ≥ totalEthEscrow. Cheap and always run; the
//                 meter covers the current generation only (it resets when a
//                 new game starts), so W1 is the complete check.
//   W3 ESCROW     PrizeEscrow ETH ≥ pot + unclaimed winnings + protocol cut.
//   W4 TERMINAL   a Conceded, Cancelled or Closed ticket holds no principal.
//   W5 DRIFT      (warning) Σ current-generation ETH escrow = totalEthEscrow.
//                 The meter prices entries; drift means wrong prices, not lost
//                 funds.
//
// W1–W4 failing alerts 🚨 (ops chat and the critical chat) and exits 1. W5
// warns ⚠️. This keeper never pauses anything: GameRegistry.pause and
// TimbPrize.pauseEntries / pauseSettlement are owner-only, so a breach is for
// the owner to act on. An alert repeats every WATCH_REALERT_MIN while the
// breach stands and sends one ✅ recovery when it clears. A run that cannot read
// the chain alerts ⚠️ on the same throttle and exits 2: a blind watchdog must be
// noticed.
//
// State: scripts/solvency-watch-state.json holds the alert stamps only. On an
// ephemeral host it is lost on redeploy, which at worst repeats one alert.
//
// Env:
//   WATCH_RPC           optional; default = config.js public RPC (lib/config.js).
//                       A keyed URL belongs in a secret: the script scrubs it
//                       from every line it prints or sends.
//   WATCH_REGISTRY      optional override; default = TimbPrize.gameRegistry()
//   WATCH_PRIZE         optional override; default = config.js ADDRESSES.TimbPrize
//   WATCH_BATCH         tickets per Multicall3 call (default 200)
//   WATCH_REALERT_MIN   minutes between repeat alerts per finding (default 60)
//   TELEGRAM_*          as the rest of the fleet (lib/telegram.js)
//
// Flags: --self-test (no network)  --report (Telegram summary even when healthy)
//        --dry-run (print what would be sent; no Telegram, no state write)

"use strict";

const { ethers } = require("ethers");
const path = require("path");
const { addrFromConfig, rpcFromConfig } = require("./lib/config");
const { loadState, saveState } = require("./lib/state");
const tgLib = require("./lib/telegram");

const SELF_TEST = process.argv.includes("--self-test");
const REPORT    = process.argv.includes("--report");
const DRY_RUN   = process.argv.includes("--dry-run");

const STATE_PATH  = path.join(__dirname, "solvency-watch-state.json");
const BATCH       = Number(process.env.WATCH_BATCH || 200);
const REALERT_MIN = Number(process.env.WATCH_REALERT_MIN || 60);
const MULTICALL3  = "0xcA11bde05977b3631167028862bE2a173976CA11"; // same address on every chain

// ─── ABI ────────────────────────────────────────────────────────────────────

const TICKET_TUPLE = "tuple(uint256 id,address owner,bytes6 string6,uint256 playRound,uint256 lastEligibleRound," +
  "uint256 escrowAmount,address escrowToken,uint8 status,uint256 supersedes,uint256 supersededBy," +
  "uint256 createdAt,uint256 forfeitRound,uint256 generation)";
const REGISTRY_ABI = [
  `function getTicket(uint256 ticketId) view returns (${TICKET_TUPLE} t, uint8 displayStatus)`,
  "function nextTicketId() view returns (uint256)",
  "function totalEthEscrow() view returns (uint256)",
  "function generation() view returns (uint256)",
];
const PRIZE_ABI = [
  "function gameRegistry() view returns (address)",
  "function prizeEscrow() view returns (address)",
  "function currentAccumulatedRewards() view returns (uint256)",
  "function gameUnclaimed_winningsPool() view returns (uint256)",
  "function protocolCutAccrued() view returns (uint256)",
];
const MULTICALL_ABI = [
  "function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) view returns (tuple(bool success,bytes returnData)[])",
];

// GameRegistry.TicketStatus { Pending, Active, Conceded, Ineligible, Cancelled, Closed }
const TERMINAL = new Set([2, 4, 5]);

// ─── Pure logic (exported for --self-test) ──────────────────────────────────

/** wei → ETH rounded to 6 decimals (integer math), trailing zeros trimmed. A
 *  non-zero amount below 0.000001 reads "<0.000001", never "0". */
function eth6(v) {
  const wei = BigInt(v), unit = 10n ** 12n;
  if (wei === 0n) return "0";
  if (wei < unit) return "<0.000001";
  const micro = (wei + unit / 2n) / unit;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return (micro / 1_000_000n).toString() + (frac ? "." + frac : "");
}

/**
 * Fold the ticket sweep into totals.
 * tickets: [{ id, escrowAmount (bigint), escrowToken, status, generation }]
 */
function sweepTotals(tickets, generation) {
  let ethOwed = 0n, currentGenEth = 0n;
  const terminalHolding = [];
  for (const t of tickets) {
    const isEth = BigInt(t.escrowToken) === 0n;
    if (isEth) {
      ethOwed += t.escrowAmount;
      if (t.generation === generation) currentGenEth += t.escrowAmount;
    }
    if (TERMINAL.has(t.status) && t.escrowAmount > 0n) terminalHolding.push(t.id);
  }
  return { ethOwed, currentGenEth, terminalHolding };
}

/**
 * Turn a snapshot into findings. Amounts are bigint wei.
 * snap: { registryEth, meter, escrowEth, pot, unclaimed, cut, sweep|null }
 */
function assess(snap) {
  const f = (kind, severity, detail) => ({ kind, severity, detail });
  const out = [];
  const eth = eth6;
  if (snap.sweep && snap.registryEth < snap.sweep.ethOwed) {
    out.push(f("W1_PRINCIPAL", "breach", `registry holds ${eth(snap.registryEth)} ETH, tickets are owed ${eth(snap.sweep.ethOwed)} (short ${eth(snap.sweep.ethOwed - snap.registryEth)})`));
  }
  if (snap.registryEth < snap.meter) {
    out.push(f("W2_METER", "breach", `registry holds ${eth(snap.registryEth)} ETH < totalEthEscrow ${eth(snap.meter)}`));
  }
  const books = snap.pot + snap.unclaimed + snap.cut;
  if (snap.escrowEth < books) {
    out.push(f("W3_ESCROW", "breach", `PrizeEscrow holds ${eth(snap.escrowEth)} ETH < pot ${eth(snap.pot)} + unclaimed ${eth(snap.unclaimed)} + cut ${eth(snap.cut)} = ${eth(books)}`));
  }
  if (snap.sweep && snap.sweep.terminalHolding.length) {
    const ids = snap.sweep.terminalHolding;
    out.push(f("W4_TERMINAL", "breach", `${ids.length} closed/cancelled/conceded ticket(s) still hold principal: #${ids.slice(0, 10).join(", #")}${ids.length > 10 ? " …" : ""}`));
  }
  if (snap.sweep && snap.sweep.currentGenEth !== snap.meter) {
    out.push(f("W5_DRIFT", "warn", `totalEthEscrow ${eth(snap.meter)} ≠ current-generation ETH principal ${eth(snap.sweep.currentGenEth)}`));
  }
  return out;
}

/**
 * Decide what to send. Mutates state.alerted (kind → unix seconds of the last
 * alert). A kind alerted before and absent now yields one recovery.
 */
function plan(state, findings, nowSec, realertSec = REALERT_MIN * 60) {
  state.alerted ??= {};
  const alerts = [], recoveries = [];
  const present = new Set(findings.map((x) => x.kind));
  for (const kind of Object.keys(state.alerted)) {
    if (!present.has(kind)) { recoveries.push(kind); delete state.alerted[kind]; }
  }
  for (const x of findings) {
    const last = state.alerted[x.kind];
    if (last === undefined || nowSec - last >= realertSec) {
      alerts.push(x);
      state.alerted[x.kind] = nowSec;
    }
  }
  return { alerts, recoveries };
}

/** Strip RPC credentials from text that is printed or sent: the configured URL
 *  itself and any path segment that looks like a provider key (/v2/<key>). */
function redact(text, url = process.env.WATCH_RPC) {
  let s = String(text);
  if (url) s = s.split(url).join("<WATCH_RPC>");
  return s.replace(/(\/v[0-9]\/)[A-Za-z0-9_-]{8,}/g, "$1<key>");
}

module.exports = { eth6, sweepTotals, assess, plan, redact, main };

// ─── Self-test ──────────────────────────────────────────────────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const t = (name, cond) => { if (cond) pass++; else { fail++; console.log("  FAIL", name); } };
  const E = (n) => ethers.parseEther(String(n));
  const ZERO = ethers.ZeroAddress, TIMBS = "0x" + "11".repeat(20);
  const tk = (id, amt, { token = ZERO, status = 1, gen = 2 } = {}) =>
    ({ id, escrowAmount: E(amt), escrowToken: token, status, generation: gen });

  // Sweep: ETH only, all generations; TIMBS tickets ignored; terminal holders found.
  { const s = sweepTotals([tk(1, 1, { gen: 1 }), tk(2, 2), tk(3, 5, { token: TIMBS }), tk(4, 0, { status: 5 }), tk(5, 0.5, { status: 4 })], 2);
    t("sweep sums ETH across generations", s.ethOwed === E(3.5));
    t("sweep current generation only for the meter", s.currentGenEth === E(2.5));
    t("sweep flags a terminal ticket holding principal", s.terminalHolding.length === 1 && s.terminalHolding[0] === 5); }

  const healthy = { registryEth: E(10), meter: E(4), escrowEth: E(3), pot: E(1), unclaimed: E(1), cut: E(0.5),
                    sweep: { ethOwed: E(9), currentGenEth: E(4), terminalHolding: [] } };
  t("healthy snapshot has no findings", assess(healthy).length === 0);
  t("exact cover is not a breach", assess({ ...healthy, registryEth: E(9), escrowEth: E(2.5) }).length === 0);
  { const k = assess({ ...healthy, registryEth: E(8.9) }).map((x) => x.kind);
    t("W1 fires when the registry is short of all tickets", k.includes("W1_PRINCIPAL") && !k.includes("W2_METER")); }
  t("W2 fires when the registry is short of the meter", assess({ ...healthy, registryEth: E(3.9), sweep: null }).some((x) => x.kind === "W2_METER"));
  t("W3 fires when escrow is short of the books", assess({ ...healthy, escrowEth: E(2.4) }).some((x) => x.kind === "W3_ESCROW"));
  t("W4 fires on a terminal ticket", assess({ ...healthy, sweep: { ...healthy.sweep, terminalHolding: [7] } }).some((x) => x.kind === "W4_TERMINAL"));
  { const d = assess({ ...healthy, sweep: { ...healthy.sweep, currentGenEth: E(4.1) } });
    t("W5 drift is a warning only", d.length === 1 && d[0].kind === "W5_DRIFT" && d[0].severity === "warn"); }
  t("no sweep: only the cheap checks run", assess({ ...healthy, sweep: null }).length === 0);

  // Alert planning: first alert, throttle, re-alert, one recovery.
  { const st = {}; const w = { kind: "W3_ESCROW", severity: "breach", detail: "" };
    t("first finding alerts", plan(st, [w], 1000, 3600).alerts.length === 1);
    t("repeat inside the window is held", plan(st, [w], 2000, 3600).alerts.length === 0);
    t("repeat after the window alerts", plan(st, [w], 4700, 3600).alerts.length === 1);
    const r = plan(st, [], 4800, 3600);
    t("cleared finding sends one recovery", r.recoveries.length === 1 && r.recoveries[0] === "W3_ESCROW");
    t("no second recovery", plan(st, [], 4900, 3600).recoveries.length === 0); }

  // Display: 6 decimals, rounded; dust never shows as zero.
  t("eth6 rounds to 6 decimals", eth6(504238390149088205n) === "0.504238");
  t("eth6 rounds half up", eth6(1_499_999_500_000_000n) === "0.0015");
  t("eth6 trims trailing zeros", eth6(E(0.0015)) === "0.0015" && eth6(E(2)) === "2");
  t("eth6 shows dust, not zero", eth6(1n) === "<0.000001" && eth6(0n) === "0");

  // Redaction: the configured URL and any provider-key path segment.
  { const url = "https://arb-mainnet.example.com/v2/alch_SECRETKEY123";
    const r = redact(`connect failed for ${url} (method eth_call)`, url);
    t("redact removes the configured URL", !r.includes("SECRETKEY") && r.includes("<WATCH_RPC>"));
    t("redact masks a key path without the URL set", !redact("GET https://x.io/v2/abcdEFGH1234 failed", "").includes("abcdEFGH1234")); }

  console.log(`self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (SELF_TEST) selfTest();

// ─── Live run ───────────────────────────────────────────────────────────────

const telegram = tgLib.opsTelegram
  ? tgLib.opsTelegram({ tag: "solvency-watch" })
  : tgLib.makeTelegram({ token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID, tag: "solvency-watch" });
const tg = (text) => (DRY_RUN ? (console.log(`(dry run) telegram:\n${redact(text)}`), false) : telegram.send(redact(text)));

/** Every ticket, batched through Multicall3; one call per ticket if it is absent. */
async function readTickets(provider, registry, count) {
  const ids = Array.from({ length: count }, (_, i) => i + 1);
  const decode = (data) => {
    const [t] = registry.interface.decodeFunctionResult("getTicket", data);
    return { id: Number(t.id), escrowAmount: BigInt(t.escrowAmount), escrowToken: t.escrowToken,
             status: Number(t.status), generation: Number(t.generation) };
  };
  const out = [];
  let unreadable = 0;
  if ((await provider.getCode(MULTICALL3)) !== "0x") {
    const mc = new ethers.Contract(MULTICALL3, MULTICALL_ABI, provider);
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      const res = await mc.aggregate3(slice.map((id) => ({
        target: registry.target, allowFailure: true,
        callData: registry.interface.encodeFunctionData("getTicket", [id]),
      })));
      res.forEach((r) => { if (r.success) out.push(decode(r.returnData)); else unreadable++; });
    }
  } else {
    console.warn("Multicall3 not deployed on this chain: reading tickets one by one");
    for (let i = 0; i < ids.length; i += 8) {
      const got = await Promise.all(ids.slice(i, i + 8).map((id) =>
        provider.call({ to: registry.target, data: registry.interface.encodeFunctionData("getTicket", [id]) }).then(decode, () => null)));
      got.forEach((g) => { if (g) out.push(g); else unreadable++; });
    }
  }
  return { tickets: out, unreadable };
}

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.WATCH_RPC || rpcFromConfig());
  const chainId  = Number((await provider.getNetwork()).chainId);
  const prizeAddr = process.env.WATCH_PRIZE ? ethers.getAddress(process.env.WATCH_PRIZE) : addrFromConfig("TimbPrize");
  const prize     = new ethers.Contract(prizeAddr, PRIZE_ABI, provider);
  // The registry and escrow come from the prize itself, so the watchdog always
  // checks the contracts the live game uses, whatever config.js says.
  const registryAddr = process.env.WATCH_REGISTRY ? ethers.getAddress(process.env.WATCH_REGISTRY) : await prize.gameRegistry();
  const escrowAddr   = await prize.prizeEscrow();
  const registry     = new ethers.Contract(registryAddr, REGISTRY_ABI, provider);

  const state = loadState(STATE_PATH, () => ({ chainId, prize: prizeAddr, alerted: {} }), {
    matches: (s) => s.chainId === chainId && String(s.prize).toLowerCase() === prizeAddr.toLowerCase(),
    label: "solvency-watch state",
  });

  const block = await provider.getBlock("latest");
  const [registryEth, meter, generation, nextId, escrowEth, pot, unclaimed, cut] = await Promise.all([
    provider.getBalance(registryAddr, block.number), registry.totalEthEscrow({ blockTag: block.number }),
    registry.generation({ blockTag: block.number }), registry.nextTicketId({ blockTag: block.number }),
    provider.getBalance(escrowAddr, block.number), prize.currentAccumulatedRewards({ blockTag: block.number }),
    prize.gameUnclaimed_winningsPool({ blockTag: block.number }), prize.protocolCutAccrued({ blockTag: block.number }),
  ]);

  // The sweep reads the latest block, a few seconds after the balances: a ticket
  // minted in between adds principal and ETH together, so it can only make W1
  // look tighter for one run, never looser. A sweep failure keeps the cheap checks.
  let sweep = null, unreadable = 0, sweepError = null;
  try {
    const r = await readTickets(provider, registry, Number(nextId) - 1);
    unreadable = r.unreadable;
    sweep = sweepTotals(r.tickets, Number(generation));
  } catch (e) {
    sweepError = redact(e.shortMessage || e.message);
    console.warn(`ticket sweep failed, cheap checks only: ${sweepError}`);
  }

  const snap = { registryEth, meter, escrowEth, pot, unclaimed, cut, sweep };
  const findings = assess(snap);
  if (sweepError) findings.push({ kind: "SWEEP_FAILED", severity: "warn", detail: `ticket sweep failed (${sweepError}); W1 and W4 not checked this run` });
  if (unreadable) findings.push({ kind: "SWEEP_UNREADABLE", severity: "warn", detail: `${unreadable} ticket(s) could not be read; W1 and W4 may be incomplete` });

  const eth = eth6;
  const books = pot + unclaimed + cut;
  const summary =
    `registry ${registryAddr.slice(0, 10)}… holds ${eth(registryEth)} ETH` +
    (sweep ? ` · owed ${eth(sweep.ethOwed)} over ${Number(nextId) - 1} tickets` : "") + ` · meter ${eth(meter)}\n` +
    `escrow ${escrowAddr.slice(0, 10)}… holds ${eth(escrowEth)} ETH · books ${eth(books)} (pot ${eth(pot)}, unclaimed ${eth(unclaimed)}, cut ${eth(cut)})`;
  console.log(`chain ${chainId} block ${block.number} generation ${generation}\n${summary}`);

  const { alerts, recoveries } = plan(state, findings, block.timestamp);
  const breaches = findings.filter((x) => x.severity === "breach");
  for (const x of findings) console[x.severity === "breach" ? "error" : "warn"](`[${x.kind}] ${x.detail}`);

  if (alerts.length) {
    const head = alerts.some((x) => x.severity === "breach")
      ? "🚨 Solvency breach: the game holds less ETH than it owes. Owner: pause entries and settlement."
      : "⚠️ Solvency watch warning";
    await tg(`${head}\n${alerts.map((x) => `[${x.kind}] ${x.detail}`).join("\n")}\n${summary}`);
  }
  if (recoveries.length) await tg(`✅ Solvency watch recovered: ${recoveries.join(", ")}\n${summary}`);
  if (!findings.length && REPORT) await tg(`✅ Solvency OK\n${summary}`);
  if (!DRY_RUN) saveState(STATE_PATH, state);

  if (breaches.length) process.exit(1);
  console.log("solvency OK" + (findings.length ? " (with warnings)" : ""));
}

// Only run the live path when executed directly, so a test can drive main().
if (!SELF_TEST && require.main === module) main().catch(async (e) => {
  const msg = redact(e.shortMessage || e.message || String(e));
  console.error(msg);
  // A watchdog that cannot read the chain is blind: say so, on the same throttle.
  try {
    const state = loadState(STATE_PATH, () => ({ alerted: {} }), { label: "solvency-watch state" });
    const { alerts } = plan(state, [{ kind: "READ_FAILED", severity: "warn", detail: msg }], Math.floor(Date.now() / 1000));
    if (alerts.length) await tg(`⚠️ Solvency watch cannot read the chain: ${msg.slice(0, 300)}`);
    if (!DRY_RUN) saveState(STATE_PATH, state);
  } catch { /* the alert path must never mask the original error */ }
  process.exit(2);
});
