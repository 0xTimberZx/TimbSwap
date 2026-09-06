// compete.js — TimbSwap Prize Game v2 (digit-locking mechanic)

const TIMBPRIZE_ABI = [
  "function getRoundState() external view returns (uint256 round, uint256 segment, uint256 segmentStart, uint256 counter, bytes6 currentWindow, uint256 pot, uint256 unclaimedPool, bool inSettlement, uint256[6] digitCounters, bool[6] digitLocked)",
  "function getRoundResult(uint256 round) external view returns (bytes6 winningString, uint256 potAmount, address[] winners, uint256 perWinner, uint256 remainder)",
  "function hasClaimed(uint256 round, address winner) external view returns (bool)",
  "function claimWinnings(uint256 round) external",
  "function gameStarted() external view returns (bool)"
];

// GameRegistry v2 — ticket model. Every entry is a Ticket with an id;
// replacement mints a new ticket and the senior one becomes Conceded,
// tethered beneath the replacement via supersedes/supersededBy links.
const TICKET_TUPLE =
  "tuple(uint256 id, address owner, bytes6 string6, uint256 playRound, " +
  "uint256 lastEligibleRound, uint256 escrowAmount, address escrowToken, " +
  "uint8 status, uint256 supersedes, uint256 supersededBy, uint256 createdAt, " +
  "uint256 forfeitRound, uint256 generation)";

const GAME_REGISTRY_ABI = [
  "function currentRound() external view returns (uint256)",
  "function generation() external view returns (uint256)",
  "function reclaimFromPastGame(uint256 ticketId) external",
  "function entryCostTIMBS() external view returns (uint256)",
  "function entryCostETH() external view returns (uint256)",
  "function additionalRoundCost(uint256 extraRounds) external view returns (uint256)",
  "function activeTicketOf(address owner) external view returns (uint256)",
  `function getTicketsOf(address owner) external view returns (${TICKET_TUPLE}[] list, uint8[] displayStatuses)`,
  "function submitEntry(bytes6 string6, bool useETH, uint256 extraRounds) external payable",
  "function replaceEntry(bytes6 newString6, uint256 extraRounds) external",
  "function claimRefund(uint256 ticketId) external",
  "function cancelEntry() external",
  "function getRoundEntrants(uint256 round) external view returns (address[])",
  "function ticketAt(uint256 gen, address owner, uint256 round) external view returns (uint256)"
];

const YIELD_VAULT_ABI = [
  "function previewAccrued() external view returns (uint256)",
  "function weightOf(uint256 ticketId) external view returns (uint256)"
];

const TIMBS_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)"
];

const ELIGIBLE_REGISTRY_ABI = [
  "function getEligibleTokens() external view returns (address[])"
];

const ERC20_SYMBOL_ABI = ["function symbol() external view returns (string)"];
const ERC20_BAL_ABI    = ["function balanceOf(address account) external view returns (uint256)"];

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
// Ticket lifecycle (GameRegistry v2): Cancelled reads as Closed once its
// play round begins (the contract's effectiveStatus handles that).
const STATUS_NAMES = ["Pending", "Active", "Conceded", "Ineligible", "Cancelled", "Closed"];

// ─── State ────────────────────────────────────────────────────────────────────

let selectedToken      = { address: "native", symbol: "ETH", isNative: true };
let eligibleTokens     = [];
let extraRounds        = 0;
let entryCostETH_wei   = null;
let entryCostTIMBS_wei = null;
// Cached wallet balances + extra-round cost (wei) so the entry button can flag
// over-balance presets synchronously. null = unknown, never blocks.
let entryBalWei  = null;   // balance of the currently-selected entry token
let timbsBalWei  = null;   // TIMBS balance (extra rounds are always TIMBS)
let extraCostWei = null;   // additionalRoundCost(extraRounds); zero when none
let currentRoundNum    = null;
let currentGen         = null;   // registry game generation; prior-gen tickets are reclaimable
let lastDigitCounters  = null;
let activeSegIndex     = -1;   // 0-based index into digitCounters for the live segment
let myActiveTicketStr  = null; // viewer's ticket string playing the CURRENT round (gold streak)
let activeSegCounter   = null; // BigNumber — that segment's current counter
let advanceCount       = 1;    // chosen batch size for the Advance panel
let advanceInSettlement = false; // on-chain settlement window blocks nudges
// True when the wallet already has a Pending/Active entry for the next play
// round. The contract allows only one entry per round, so a second submit
// reverts (UNPREDICTABLE_GAS_LIMIT) — we route to replaceEntry instead.
let hasPlayEntry       = false;

// Read provider: when a wallet is connected and verified on Arb Sepolia, reads
// go THROUGH the wallet (its RPC isn't the shared public endpoint, so this
// page's heavy 4s polling can't trip a per-IP rate limit — the source of the
// "Loading/stale" throttling). Wallet-less visitors, or an unverified chain,
// fall back to the resilient public/keyed FallbackProvider. sharedReadProvider()
// (config.js) makes that decision; chainChanged reloads the page so it can't go
// stale, and a wrong-chain wallet is never used (guarded by _walletChainOk).
function readProv() {
  return sharedReadProvider();
}

// Cache read-only contracts by address — but REBIND them all when the read
// provider switches (wallet⇄public on connect/disconnect). Without this, a
// contract cached against the public provider before auto-reconnect resolved
// would keep polling the public RPC even after the wallet connected, defeating
// the wallet-read path.
let _roProvider = null;
const _roContracts = {};
function contractRO(address, abi) {
  const p = readProv();
  if (p !== _roProvider) { _roProvider = p; for (const k in _roContracts) delete _roContracts[k]; }
  return _roContracts[address] || (_roContracts[address] = new ethers.Contract(address, abi, p));
}

// ─── USD pricing (newcomer banner) ───────────────────────────────────────────
// Fixed real ETH rate (config ETH_USD_PRICE), the same figure the landing
// "Win the Pot" uses — so the banner's dollars match the dashboard. Testnet ETH
// has no market price, so a testnet pool ratio would be meaningless.
async function usdPerEth() { return ETH_USD_PRICE; }

// The yield read runs on the 4s poll; log a read failure only once per session
// so a persistent RPC hiccup doesn't spam DebugHub every tick.
function _logYieldErrOnce(err) {
  if (window.__yieldReadErrorLogged) return;
  window.__yieldReadErrorLogged = true;
  DebugHub.logError("pollRoundState.previewAccrued", err);
}

// ─── Digit Track Display ──────────────────────────────────────────────────────

// When the wallet is disconnected the whole track is gated: instead of the real
// digits it runs a slow marquee that spells out CONNECT WALLET across the six
// cells, so no game state (locked digits, active segment) is visible to onlookers.
const GATE_PHRASE = "CONNECT·WALLET·"; // · is a dim spacer between the words
let gateTimer  = null;
let gateOffset = 0;

function startGateMask() {
  for (let i = 0; i < 6; i++) {
    const cell = document.getElementById("dc" + i);
    // Gold streak is viewer-specific state — it must never survive a disconnect.
    if (cell) { cell.classList.remove("locked", "active", "future", "settling", "gold", "gold-flash"); cell.classList.add("gate-mask"); }
  }
  if (gateTimer) return;
  const paint = () => {
    for (let i = 0; i < 6; i++) {
      const el = document.getElementById("dchar" + i);
      if (!el) continue;
      const ch = GATE_PHRASE[(gateOffset + i) % GATE_PHRASE.length];
      el.textContent = ch;
      el.style.opacity = ch === "·" ? "0.2" : "0.8";
    }
    gateOffset = (gateOffset + 1) % GATE_PHRASE.length;
  };
  paint();
  gateTimer = setInterval(paint, 320);
}

function stopGateMask() {
  if (gateTimer) { clearInterval(gateTimer); gateTimer = null; }
  for (let i = 0; i < 6; i++) {
    document.getElementById("dc" + i)?.classList.remove("gate-mask");
    const el = document.getElementById("dchar" + i);
    if (el) el.style.opacity = "";
  }
}

// Decode the contract's bytes6 currentWindow ("0x414243…") into 6 chars.
// Locked positions carry the JITTERED character the round will actually
// score (TimbPrize v4 §13.2); 0x00 positions (future segments) become null.
function windowChars(window6) {
  const hex = (window6 || "0x").replace(/^0x/, "").padEnd(12, "0");
  const out = [];
  for (let i = 0; i < 6; i++) {
    const code = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    out.push(code > 0 ? String.fromCharCode(code) : null);
  }
  return out;
}

function renderDigitTrack(segment, digitCounters, digitLocked, inSettlement, winChars) {
  // Wallet-gated: hide every real digit behind the CONNECT WALLET marquee.
  if (!userAddress) { startGateMask(); return; }
  stopGateMask();

  for (let i = 0; i < 6; i++) {
    const seg = i + 1;
    const cell    = document.getElementById("dc" + i);
    const charEl  = document.getElementById("dchar" + i);
    if (!cell || !charEl) continue;
    cell.classList.remove("locked", "active", "future", "gated", "settling", "gate-mask", "gold", "gold-flash");
    if (seg < segment || (seg === segment && digitLocked[i])) {
      // Locked: the jittered character the contract froze — NOT counter % 36
      // (falls back to the counter char only if the window byte is missing).
      charEl.textContent = (winChars && winChars[i]) || ALPHABET[Number(digitCounters[i]) % 36];
      charEl.style.opacity = "";
      cell.classList.add("locked");
    } else if (seg === segment) {
      // Live digit — the pre-jitter influence meter.
      charEl.textContent = ALPHABET[Number(digitCounters[i]) % 36];
      charEl.style.opacity = "";
      // Keep the current segment marked as active even during settlement so the
      // "current part of the meter" indicator never disappears.
      cell.classList.add("active");
      if (inSettlement) cell.classList.add("settling");
    } else {
      // The meter is continuous — future segments already hold the value
      // carried over from the previous round (round 1 ending ABCJLA leaves
      // J, L, … sitting in their segments). Show it dimmed instead of a
      // blank dot; nudging resumes from here when the segment activates.
      charEl.textContent = ALPHABET[Number(digitCounters[i]) % 36];
      charEl.style.opacity = "";
      cell.classList.add("future");
    }
  }
  applyGoldStreak(segment, digitCounters, digitLocked, winChars);
}

// ─── Winning-streak highlight ─────────────────────────────────────────────────
// If the viewer's active ticket matches the settled letters as an UNBROKEN run
// from segment 1, those cells burn lightning-gold instead of green. The first
// incorrect settled letter kills the whole streak (all cells stay green) — no
// gaps allowed; gold must flush straight through to represent a live winning
// match. A full 6/6 match flashes just before the round rolls and resets.
function applyGoldStreak(segment, digitCounters, digitLocked, winChars) {
  if (!userAddress || !myActiveTicketStr || myActiveTicketStr.length !== 6) return;
  let run = 0;
  for (let i = 0; i < 6; i++) {
    const seg = i + 1;
    const settled = seg < segment || (seg === segment && digitLocked[i]);
    if (!settled) break;                                  // streak can only grow as letters settle
    // Match against the LOCKED (jittered) character — the one the round scores.
    const ch = (winChars && winChars[i]) || ALPHABET[Number(digitCounters[i]) % 36];
    if (ch !== myActiveTicketStr[i]) return;              // broken — everything stays green
    run++;
  }
  for (let i = 0; i < run; i++) {
    document.getElementById("dc" + i)?.classList.add("gold");
  }
  if (run === 6) {
    for (let i = 0; i < 6; i++) document.getElementById("dc" + i)?.classList.add("gold-flash");
  }
}

// ─── Poll Round State ─────────────────────────────────────────────────────────

// Transition tracking for DebugHub — see _trackRoundTransitions.
let _lastRound        = null;   // last seen round number
let _lastSegment      = null;   // last seen segment number
let _lastInSettlement = null;   // last seen settlement flag
let _settlementSince  = null;   // ms timestamp when the current window began
let _overdueLogged    = false;  // one alarm per window, not one per poll
const SETTLEMENT_OVERDUE_MS = 2 * 60 * 1000; // nominal window is 15s

function _trackRoundTransitions(s) {
  const round        = s.round.toNumber();
  const segment      = s.segment.toNumber();
  const inSettlement = !!s.inSettlement;

  if (_lastRound !== null && round !== _lastRound) {
    DebugHub.logCheckpoint("Prize:Round Rolled", "pass");
  } else if (_lastSegment !== null && segment !== _lastSegment) {
    DebugHub.logCheckpoint("Prize:Segment Advanced", "pass");
  }

  if (_lastInSettlement !== null && inSettlement !== _lastInSettlement) {
    DebugHub.logCheckpoint(
      inSettlement ? "Prize:Settlement Window Entered" : "Prize:Settlement Window Exited",
      "pass"
    );
  }
  if (inSettlement) {
    if (_settlementSince === null) _settlementSince = Date.now();
    if (!_overdueLogged && Date.now() - _settlementSince > SETTLEMENT_OVERDUE_MS) {
      // The settler keeper should land within seconds of the boundary —
      // minutes in this state means the game is stalled and nudges revert.
      DebugHub.logCheckpoint("Prize:Settlement Overdue", "fail");
      _overdueLogged = true;
    }
  } else {
    _settlementSince = null;
    _overdueLogged   = false;
  }

  _lastRound        = round;
  _lastSegment      = segment;
  _lastInSettlement = inSettlement;
}

async function pollRoundState() {
  try {
    const prize   = contractRO(ADDRESSES.TimbPrize, TIMBPRIZE_ABI);
    const started = await prize.gameStarted();

    if (!started) {
      document.getElementById("hdr-round").textContent   = "—";
      document.getElementById("sub-timer").textContent   = "Game not started";
      return;
    }

    const s = await prize.getRoundState();
    currentRoundNum = s.round.toNumber();

    // Game-state transition telemetry. Today's stagnation incident was
    // invisible in the DebugHub export (only sessions + RPC noise), so
    // record round/segment/settlement transitions — fired on CHANGE only,
    // never per 4-second poll — plus an explicit overdue alarm when a
    // settlement window outlives its nominal 15 seconds by 2+ minutes
    // (i.e. the settler keeper isn't landing).
    _trackRoundTransitions(s);

    document.getElementById("hdr-round").textContent      = "#" + s.round.toString();
    document.getElementById("hdr-segment-num").textContent = s.segment.toString();

    // An entry always plays the NEXT round — the current round's meter is
    // already locking. Show the concrete target round(s) on the entry form so
    // "Plays next round" isn't mistaken for "plays this round" (the source of
    // the "why is my round-1 entry active at round 3" confusion), and so the
    // extra rounds the user is paying for are reflected as a range.
    renderPlaysRound(currentRoundNum);

    // Pot substats as ordered segments: Pot · backed by · yield rate.
    // "backed by" (escrow reserve) sits right after the pot; yield rate
    // is its own segment (no longer parenthetical).
    // Each segment glues its own words with non-breaking spaces ( ) so it
    // never breaks mid-value; segments join with regular spaces around " · "
    // so the line wraps only *between* stats on a narrow (mobile) viewport.
    const potSegs = ["Pot: " + fmt(s.pot) + " ETH"];

    // The three secondary reads (escrow backing, accruing yield, round
    // entrants) are independent — fire them together instead of three serial
    // round-trips on every 4s poll. Each resolves to null on read failure.
    let activeEntries = null; // entrants that still carry live vault weight
    const hasVault = ADDRESSES.TimbYieldVault && !/^0x0{40}$/.test(ADDRESSES.TimbYieldVault.replace("0x",""));
    const [escrowBal, accrued, entrants] = await Promise.all([
      ADDRESSES.PrizeEscrow ? readProv().getBalance(ADDRESSES.PrizeEscrow).catch(() => null) : null,
      hasVault ? contractRO(ADDRESSES.TimbYieldVault, YIELD_VAULT_ABI).previewAccrued().catch(e => { _logYieldErrOnce(e); return null; }) : null,
      contractRO(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI).getRoundEntrants(currentRoundNum).catch(() => null),
    ]);

    // Escrow backing — only when it exceeds the accounted (winnable) pot, e.g.
    // a direct seed not registered via fundPot().
    if (escrowBal && escrowBal.gt(s.pot)) potSegs.push(`backed by ${fmt(escrowBal)} ETH`);
    document.getElementById("sub-pot").textContent = potSegs.join(" · ");

    // FLOW GROUP (right of the "|" divider): live yield rate + round entries.
    // nbsp within each segment so a value never wraps mid-word.
    const flowSegs = [];
    if (accrued && !accrued.isZero()) flowSegs.push(`yield rate ${fmt(accrued)} ETH`);

    // Entries playing THIS round. getRoundEntrants() is append-only history —
    // it keeps a wallet forever, even after that ticket is replaced/cancelled/
    // expired and stops earning. So we don't trust the raw list length: an
    // "entry" counts only if its ticket still carries LIVE vault weight
    // (earningCount checks weightOf per entrant). This makes the entries number
    // reconcile with the pot's yield weight by construction — no footnote, no
    // "5 entries but 4 weight" gap to explain. Falls back to the raw count only
    // if the vault read fails.
    if (entrants) {
      const active = await earningCount(s.round.toNumber(), entrants).catch(() => null);
      activeEntries = active !== null ? active : entrants.length;
      flowSegs.push(`${activeEntries} ${activeEntries === 1 ? "entry" : "entries"}`);
    }
    document.getElementById("sub-entries").textContent = flowSegs.join(" · ");
    const _sep = document.getElementById("sub-sep");
    if (_sep) _sep.hidden = flowSegs.length === 0;

    if (s.inSettlement) {
      setBannerTimer("Intermission — calculating…");
    } else {
      const elapsed    = Math.floor(Date.now() / 1000) - s.segmentStart.toNumber();
      const remaining  = Math.max(0, (59 * 60 + 45) - elapsed);
      const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
      const ss = String(remaining % 60).padStart(2, "0");
      setBannerTimer(`${mm}:${ss} left in segment`);
    }

    // Flash active digit on counter change
    if (lastDigitCounters) {
      const seg = s.segment.toNumber() - 1;
      if (s.digitCounters[seg].toString() !== lastDigitCounters[seg]) {
        const cell = document.getElementById("dc" + seg);
        if (cell) {
          cell.style.transform = "scale(1.15)";
          setTimeout(() => { cell.style.transform = ""; }, 300);
        }
      }
    }
    lastDigitCounters = s.digitCounters.map(d => d.toString());

    renderDigitTrack(
      s.segment.toNumber(),
      s.digitCounters,
      s.digitLocked,
      s.inSettlement,
      windowChars(s.currentWindow)
    );

    // Show/hide gated notice
    const notice = document.getElementById("gated-notice");
    if (notice) notice.classList.toggle("hidden", !!userAddress);

    // Newcomer banner mirrors the gate: pitch the game to wallet-less
    // visitors with live numbers, vanish the moment a wallet connects.
    const banner = document.getElementById("newcomer-banner");
    if (banner) {
      banner.classList.toggle("hidden", !!userAddress);
      if (!userAddress) {
        // One combined figure: the winnable pot (whichever is larger of the
        // accounted pot and its escrow backing) plus any accruing yield,
        // in dollars at the fixed display rate — matches the landing "Win the Pot".
        let combined = escrowBal && escrowBal.gt(s.pot) ? escrowBal : s.pot;
        if (accrued) combined = combined.add(accrued);
        const ethFloat = parseFloat(ethers.utils.formatEther(combined));
        const px = await usdPerEth();
        const line = px !== null
          ? `$${(ethFloat * px).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ON THE LINE`
          : `${fmt(combined)} ETH ON THE LINE`;
        const stats = [`ROUND #${currentRoundNum}`, line];
        const players = activeEntries != null ? activeEntries : (entrants ? entrants.length : null);
        if (players != null) stats.push(`${players} ${players === 1 ? "PLAYER" : "PLAYERS"} IN`);
        const st = document.getElementById("nc-stats");
        if (st) st.textContent = stats.join("  ·  ");
      }
    }

    // Advance panel: wallet-gated, disabled during settlement; preview needs
    // the active segment's current digit.
    activeSegIndex   = s.segment.toNumber() - 1;
    activeSegCounter = s.digitCounters[activeSegIndex];

    // Remaining free (gas-only) nudges for this wallet this segment. Silent
    // on failure (old router without the view, or RPC hiccup) → treat as
    // unknown so the panel falls back to the plain per-tx cap.
    if (userAddress && ADDRESSES.TimbSwapRouter) {
      try {
        const router = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_NUDGE_ABI, readProv());
        freeNudgesLeft = (await router.freeNudgesRemaining(userAddress)).toNumber();
        if (advanceCount > advanceCeiling()) setAdvanceCount(advanceCeiling());
      } catch { freeNudgesLeft = null; }
    } else {
      freeNudgesLeft = null;
    }

    updateAdvancePanel(!!s.inSettlement);

  } catch (e) {
    // Public-RPC hiccups (a dropped eth_call response) surface as
    // CALL_EXCEPTION "missing revert data" with an inner SERVER_ERROR —
    // nothing reverted on-chain. Skip the tick quietly; the next poll is
    // 4 seconds away. Only report to DebugHub once several polls in a row
    // fail, which means the endpoint is actually down rather than flaky.
    if (isTransientRpcError(e)) {
      pollFailStreak++;
      console.warn(`pollRoundState: transient RPC error (${pollFailStreak} in a row) — ${e.message}`);
      if (pollFailStreak === POLL_FAIL_ALERT_AT) {
        DebugHub.logError("pollRoundState.rpcDown",
          new Error(`${POLL_FAIL_ALERT_AT} consecutive RPC failures — endpoint may be down`));
      }
      return;
    }
    console.warn("pollRoundState:", e.message);
    DebugHub.logError("pollRoundState", e);
    return;
  }
  pollFailStreak = 0;
}

// ─── Transient RPC detection ─────────────────────────────────────────────────

let pollFailStreak = 0;
const POLL_FAIL_ALERT_AT = 3;

function isTransientRpcError(e) {
  if (!e) return false;
  if (e.code === "SERVER_ERROR" || e.code === "TIMEOUT" || e.code === "NETWORK_ERROR") return true;
  const inner = e.error || {};
  const text  = `${e.message || ""} ${inner.message || ""} ${inner.reason || ""} ${inner.code || ""}`;
  return e.code === "CALL_EXCEPTION" &&
         /missing response|missing revert data|SERVER_ERROR|bad response|timeout/i.test(text);
}

// ─── Entry Costs ─────────────────────────────────────────────────────────────

async function loadEntryCosts() {
  try {
    const registry = new ethers.Contract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI, readProv());
    [entryCostETH_wei, entryCostTIMBS_wei] = await Promise.all([
      registry.entryCostETH(),
      registry.entryCostTIMBS()
    ]);
    updateCostDisplay();
  } catch (e) { console.warn("loadEntryCosts:", e.message); }
}

async function updateCostDisplay() {
  if (!entryCostETH_wei) return;
  const el = document.getElementById("entry-cost-val");

  let base = selectedToken.isNative
    ? fmt(entryCostETH_wei) + " ETH"
    : fmtTIMBS(entryCostTIMBS_wei);

  el.textContent = base;

  // Dynamic-pricing hint: entry costs are computed on-chain and fixed per round.
  // ETH floats with the pot's ETH escrow (0.001 floor); TIMBS steps with the
  // live entry count (2 floor). What's shown is locked for the round you enter.
  const hintEl = document.getElementById("entry-cost-hint");
  if (hintEl) {
    hintEl.textContent = selectedToken.isNative
      ? "Floats with the pot · 0.001 ETH floor"
      : "Scales with entries · 2 TIMBS floor";
  }

  const noteEl = document.getElementById("extra-cost-note");
  if (extraRounds > 0 && noteEl) {
    // Capture the count this call is pricing — the additionalRoundCost read is
    // async, and a rapid stepper change (or a post-submit reset to 0) can land
    // first, so bail if extraRounds moved on before the RPC resolves. Prevents a
    // stale "+N TIMBS" note surviving after the count changed.
    const forRounds = extraRounds;
    try {
      const registry = new ethers.Contract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI, readProv());
      const extra = await registry.additionalRoundCost(forRounds);
      if (forRounds !== extraRounds) return; // count changed mid-flight — stale
      extraCostWei = extra;
      noteEl.textContent = `+ ${fmtTIMBS(extra)} · non-refundable`;
      noteEl.classList.remove("hidden");
    } catch { extraCostWei = null; noteEl.classList.add("hidden"); }
  } else {
    extraCostWei = ethers.constants.Zero;
    if (noteEl) noteEl.classList.add("hidden");
  }
  updateEntryButton();
}

// ─── Token Dropdown ───────────────────────────────────────────────────────────

async function buildTokenDropdown() {
  try {
    const registry = new ethers.Contract(ADDRESSES.EligibleTokenRegistry, ELIGIBLE_REGISTRY_ABI, readProv());
    const addrs    = await registry.getEligibleTokens();

    eligibleTokens = [{ address: "native", symbol: "ETH", isNative: true }];

    // Read every eligible token's symbol in parallel instead of blocking on
    // each round-trip; preserve registry order and drop any that fail.
    const wanted = addrs.filter(a => {
      const lc = a.toLowerCase();
      return lc !== ADDRESSES.WETH.toLowerCase() && lc !== ADDRESSES.DAPP.toLowerCase();
    });
    const resolved = await Promise.all(wanted.map(async addr => {
      try {
        const symbol = await new ethers.Contract(addr, ERC20_SYMBOL_ABI, readProv()).symbol();
        return { address: addr, symbol, isNative: false };
      } catch { return null; }
    }));
    for (const t of resolved) if (t) eligibleTokens.push(t);
    renderTokenDropdown();
  } catch {
    eligibleTokens = [
      { address: "native", symbol: "ETH", isNative: true },
      { address: ADDRESSES.TIMBSToken, symbol: "TIMBS", isNative: false }
    ];
    renderTokenDropdown();
  }
}

function renderTokenDropdown() {
  const dropdown = document.getElementById("token-dropdown");
  if (!dropdown) return;
  dropdown.innerHTML = "";
  eligibleTokens.forEach(t => {
    const item = document.createElement("div");
    item.className = "token-drop-item" + (t.symbol === selectedToken.symbol ? " selected" : "");
    item.textContent = t.symbol;
    item.onclick = () => selectEntryToken(t);
    dropdown.appendChild(item);
  });
}

function selectEntryToken(token) {
  selectedToken = token;
  document.getElementById("selected-token-label").textContent = token.symbol;
  document.getElementById("token-dropdown").classList.add("hidden");
  renderTokenDropdown();
  updateCostDisplay();
  refreshEntryBalance();
}

// Discrete balance of the currently-selected eligible entry token. Entry
// tokens are ETH/TIMBS (18 decimals); the read is wallet-gated and silent
// when disconnected. Extra rounds always cost TIMBS regardless of the base
// token, so when extra rounds are selected we also surface the TIMBS balance.
async function refreshEntryBalance() {
  const el = document.getElementById("entry-token-bal");
  if (!el) return;
  if (!userAddress) { entryBalWei = null; timbsBalWei = null; el.textContent = ""; return; }
  try {
    const bal = selectedToken.isNative
      ? await readProv().getBalance(userAddress)
      : await new ethers.Contract(selectedToken.address, ERC20_BAL_ABI, readProv()).balanceOf(userAddress);
    entryBalWei = bal;
    if (!selectedToken.isNative &&
        selectedToken.address.toLowerCase() === ADDRESSES.TIMBSToken.toLowerCase()) {
      timbsBalWei = bal;
    }
    let txt = `Balance: ${fmt(bal, 18, 4)} ${selectedToken.symbol}`;
    if (extraRounds > 0 && selectedToken.isNative) {
      const timbs = await new ethers.Contract(ADDRESSES.TIMBSToken, ERC20_BAL_ABI, readProv()).balanceOf(userAddress);
      timbsBalWei = timbs;
      txt += ` · ${fmt(timbs, 18, 2)} TIMBS`;
    }
    el.textContent = txt;
    updateEntryButton();
  } catch {
    // Transient RPC read failure — keep whatever balance was last shown rather
    // than blanking the line, so the readout is consistently present. It'll
    // self-correct on the next refresh (poll, token switch, stepper).
  }
}

function toggleTokenDropdown() {
  if (eligibleTokens.length <= 2) {
    const idx  = eligibleTokens.findIndex(t => t.symbol === selectedToken.symbol);
    const next = eligibleTokens[(idx + 1) % eligibleTokens.length];
    selectEntryToken(next);
    return;
  }
  document.getElementById("token-dropdown").classList.toggle("hidden");
}

document.addEventListener("click", (e) => {
  const wrap = document.getElementById("token-select-btn")?.closest(".token-select-wrap");
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById("token-dropdown")?.classList.add("hidden");
  }
});

// ─── Extra Rounds ─────────────────────────────────────────────────────────────

// Contract caps extra rounds at MAX_EXTRA_ROUNDS (GameRegistry). The
// stepper must respect it — an out-of-range value reverts every entry
// with TooManyExtraRounds (observed live: user reached 15, cap is 12).
const MAX_EXTRA_ROUNDS = 12;
function adjustExtraRounds(delta) {
  extraRounds = Math.min(MAX_EXTRA_ROUNDS, Math.max(0, extraRounds + delta));
  document.getElementById("extra-rounds-val").textContent = extraRounds;
  renderPlaysRound(currentRoundNum);
  refreshEntryBalance();
  updateCostDisplay();
}

// The entry plays the NEXT round (curRound + 1), and each extra round extends
// its play window by one — so the ticket ends up playing curRound+1 through
// curRound+1+extraRounds. Mirror the ticket display's "R{first}–R{last}" range
// so the preview reflects what the extra-rounds TIMBS actually buy, instead of
// showing only the first round. Called from the poll (round changes) and the
// stepper (extra-rounds changes) so it stays live on both.
function renderPlaysRound(curRound) {
  const el = document.getElementById("entry-plays-round");
  if (!el || curRound == null) return;
  const first = curRound + 1;
  const last  = first + extraRounds;
  el.textContent = extraRounds > 0 ? `rounds ${first}–${last}` : `round ${first}`;
}

// ─── Entry Validation ─────────────────────────────────────────────────────────

function onEntryInput() {
  const input = document.getElementById("entry-string");
  input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const val   = input.value;
  const vEl   = document.getElementById("entry-validation");

  if (!val) {
    vEl.textContent = ""; vEl.className = "entry-validation";
    input.classList.remove("valid", "invalid");
    updateEntryButton(); return;
  }

  if (val.length < 6) {
    vEl.textContent = `${6 - val.length} more needed`;
    vEl.className   = "entry-validation";
    input.classList.remove("valid", "invalid");
    updateEntryButton(); return;
  }

  const seen = new Set();
  let hasRepeat = false;
  for (const c of val) { if (seen.has(c)) { hasRepeat = true; break; } seen.add(c); }

  if (hasRepeat) {
    vEl.textContent = "No repeating characters";
    vEl.className   = "entry-validation error";
    input.classList.add("invalid"); input.classList.remove("valid");
  } else {
    vEl.textContent = "Valid entry ✓";
    vEl.className   = "entry-validation ok";
    input.classList.add("valid"); input.classList.remove("invalid");
  }
  updateEntryButton();
}

function isEntryValid() {
  const val = document.getElementById("entry-string").value;
  if (val.length !== 6) return false;
  const seen = new Set();
  for (const c of val) { if (seen.has(c)) return false; seen.add(c); }
  return true;
}

// "Insufficient …" when the preset entry (base cost + extra rounds) exceeds the
// cached wallet balances; null otherwise. Unknown balances never block — the
// pre-flight in handleSubmitEntry still catches anything missed here.
function insufficientEntryLabel() {
  if (!userAddress) return null;
  // Updating an existing ticket re-uses its escrow — only extra rounds cost.
  const baseETH   = hasPlayEntry ? ethers.constants.Zero : (entryCostETH_wei   || null);
  const baseTIMBS = hasPlayEntry ? ethers.constants.Zero : (entryCostTIMBS_wei || null);
  if (selectedToken.isNative) {
    if (baseETH !== null && entryBalWei !== null && entryBalWei.lt(baseETH)) {
      return "Insufficient ETH balance";
    }
    if (extraRounds > 0 && extraCostWei !== null && timbsBalWei !== null &&
        timbsBalWei.lt(extraCostWei)) {
      return "Insufficient TIMBS for extra rounds";
    }
  } else {
    if (baseTIMBS !== null && timbsBalWei !== null && extraCostWei !== null &&
        timbsBalWei.lt(baseTIMBS.add(extraRounds > 0 ? extraCostWei : ethers.constants.Zero))) {
      return "Insufficient TIMBS balance";
    }
  }
  return null;
}

// ─── Segment-timer banner + rotating "How to play" ─────────────────────────
// The banner tucked under the meter card shows the live segment timer and,
// every HOWTO_EVERY_MS, rotates to a tappable "How to play" for HOWTO_FOR_MS.
// The TEXT is the button that opens the popup — not the banner. Rotation is
// user-toggleable (persisted). The timer value lives in _liveTimerText so the
// display can flip to "How to play" and back without losing the countdown.
let _liveTimerText = "Loading…";
let _bannerMode    = "timer";            // "timer" | "howto"
const HOWTO_EVERY_MS   = 16000;          // rotate in every 16s…
const HOWTO_FOR_MS     = 3000;           // …for 3s
const HOWTO_ROTATE_KEY = "timbswap_howto_rotate";
let _rotateEnabled = true;
try { _rotateEnabled = localStorage.getItem(HOWTO_ROTATE_KEY) !== "0"; } catch {}
let _rotTimer = null, _rotBackTimer = null;

function renderBanner() {
  const el = document.getElementById("banner-text");
  if (el) el.textContent = (_bannerMode === "howto") ? "How to play" : _liveTimerText;
}
function setBannerTimer(text) {          // called by the timer writers
  _liveTimerText = text;
  if (_bannerMode === "timer") renderBanner();
}
function startBannerRotation() {
  stopBannerRotation();
  if (!_rotateEnabled) return;
  _rotTimer = setInterval(() => {
    _bannerMode = "howto"; renderBanner();
    _rotBackTimer = setTimeout(() => { _bannerMode = "timer"; renderBanner(); }, HOWTO_FOR_MS);
  }, HOWTO_EVERY_MS);
}
function stopBannerRotation() {
  if (_rotTimer)     { clearInterval(_rotTimer);   _rotTimer = null; }
  if (_rotBackTimer) { clearTimeout(_rotBackTimer); _rotBackTimer = null; }
  _bannerMode = "timer"; renderBanner();
}
function isHowtoRotateOn() { return _rotateEnabled; }
function setHowtoRotate(on) {
  _rotateEnabled = !!on;
  try { localStorage.setItem(HOWTO_ROTATE_KEY, _rotateEnabled ? "1" : "0"); } catch {}
  const t = document.getElementById("howto-rotate-toggle");
  if (t) { t.classList.toggle("on", _rotateEnabled); t.setAttribute("aria-checked", String(_rotateEnabled)); }
  if (_rotateEnabled) startBannerRotation(); else stopBannerRotation();
}
function openHowTo() {
  const ov = document.getElementById("howto-overlay");
  if (ov) ov.classList.remove("hidden");
}
function closeHowTo(e) {
  if (e && e.currentTarget && e.target !== e.currentTarget) return; // backdrop / ✕ only
  const ov = document.getElementById("howto-overlay");
  if (ov) ov.classList.add("hidden");
}
function initBannerRotation() {          // called once from init
  const t = document.getElementById("howto-rotate-toggle");
  if (t) { t.classList.toggle("on", _rotateEnabled); t.setAttribute("aria-checked", String(_rotateEnabled)); }
  renderBanner();
  startBannerRotation();
}

function updateEntryButton() {
  const btn = document.getElementById("entry-btn");
  // No wallet: the entry button stays live and doubles as a connect trigger —
  // clicking it pops the wallet manager (see handleSubmitEntry) rather than
  // sitting greyed and dead.
  if (!userAddress) { btn.textContent = "Connect wallet to enter"; btn.disabled = false; return; }
  if (!isEntryValid()) { btn.textContent = "Enter a valid 6-character string"; btn.disabled = true; return; }
  const short = insufficientEntryLabel();
  if (short) { btn.textContent = short; btn.disabled = true; return; }
  // Only one entry per round — if we already have one queued, this replaces it.
  btn.textContent = hasPlayEntry ? "Update entry" : "Submit Entry";
  btn.disabled    = false;
}

// ─── Submit Entry ─────────────────────────────────────────────────────────────

function stringToBytes6(str) {
  let hex = "0x";
  for (let i = 0; i < 6; i++) hex += str.charCodeAt(i).toString(16).padStart(2, "0");
  return hex;
}

// ─── Earning count (entries vs live vault weight) ─────────────────────────────
// Of the round's entrants, how many tickets still carry yield-vault weight.
// Recomputed only when the round or entrant set changes — the 4s poll reuses
// the cached answer, so this adds no steady-state RPC load.
let _earningCache = { key: null, count: null };
async function earningCount(round, entrants) {
  const key = round + ":" + entrants.join(",");
  if (_earningCache.key === key) return _earningCache.count;

  const registry = contractRO(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI);
  const vault    = contractRO(ADDRESSES.TimbYieldVault, YIELD_VAULT_ABI);
  const gen      = await registry.generation();
  const ids      = await Promise.all(entrants.map((a) => registry.ticketAt(gen, a, round)));
  const weights  = await Promise.all(ids.map((id) => id.isZero()
    ? ethers.constants.Zero
    : vault.weightOf(id)));
  const count = weights.filter((w) => !w.isZero()).length;

  _earningCache = { key, count };
  return count;
}

// ─── Replace warning (entries don't stack) ────────────────────────────────
// Players mid-game submitting again may expect a SECOND stacked entry.
// One live ticket per wallet: a new submit concedes the old ticket. Warn
// once (dismissable forever via "don't show again"); "I understand"
// proceeds, tapping outside cancels the submit.

const REPLACE_WARN_KEY = "timbswap_replace_warn_off";
let _replaceWarnResolve = null;

function showReplaceWarning() {
  try { if (localStorage.getItem(REPLACE_WARN_KEY) === "1") return Promise.resolve(true); } catch {}
  const overlay = document.getElementById("replace-warn-overlay");
  if (!overlay) return Promise.resolve(true);
  overlay.classList.remove("hidden");
  return new Promise((resolve) => { _replaceWarnResolve = resolve; });
}

function _closeReplaceWarning(confirmed) {
  const overlay = document.getElementById("replace-warn-overlay");
  if (overlay) overlay.classList.add("hidden");
  if (confirmed && document.getElementById("replace-warn-dontshow")?.checked) {
    try { localStorage.setItem(REPLACE_WARN_KEY, "1"); } catch {}
  }
  if (_replaceWarnResolve) { _replaceWarnResolve(confirmed); _replaceWarnResolve = null; }
}

function confirmReplaceWarning() { _closeReplaceWarning(true); }
function dismissReplaceWarning(e) {
  // Backdrop taps only — clicks inside the card stopPropagation.
  if (e && e.target !== e.currentTarget) return;
  _closeReplaceWarning(false);
}

async function handleSubmitEntry() {
  // No wallet yet → this button pops the wallet manager to connect instead of
  // submitting; updateEntryButton then re-labels it to Submit/Update Entry.
  if (!userAddress) { handleConnect(); return; }
  if (!isEntryValid()) return;
  const btn      = document.getElementById("entry-btn");
  const entryStr = document.getElementById("entry-string").value;
  const string6  = stringToBytes6(entryStr);

  const replacing = hasPlayEntry;
  const resetLabel = replacing ? "Update entry" : "Submit Entry";

  if (replacing) {
    const proceed = await showReplaceWarning();
    if (!proceed) return; // tapped outside — nothing sent
  }

  try {
    btn.disabled = true;
    const registry = await writeContract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI);
    const useETH   = selectedToken.isNative;

    // When replacing an existing entry, the original principal stays in escrow
    // and is reused — only additional-round TIMBS (if any) is pulled. A fresh
    // entry needs the initial deposit (ETH value, or TIMBS entry cost).
    let timbsNeeded = ethers.BigNumber.from(0);
    if (!replacing && !useETH) timbsNeeded = timbsNeeded.add(entryCostTIMBS_wei);
    if (extraRounds > 0) {
      const extra = await registry.additionalRoundCost(extraRounds);
      timbsNeeded = timbsNeeded.add(extra);
    }

    // Pre-flight: state the shortfall instead of an opaque revert. Extra
    // rounds cost entryCostTIMBS each; this is what caps "how many rounds
    // can I afford" (observed: 4 rounds succeeded, 5+ reverted with the
    // reason stripped by the wallet — it was insufficient TIMBS).
    if (timbsNeeded.gt(0)) {
      const balNow = await new ethers.Contract(ADDRESSES.TIMBSToken, ERC20_BAL_ABI, readProv()).balanceOf(userAddress);
      if (balNow.lt(timbsNeeded)) {
        const roundsAffordable = entryCostTIMBS_wei && !entryCostTIMBS_wei.isZero()
          ? balNow.div(entryCostTIMBS_wei).toString() : "?";
        alert(
          `Not enough TIMBS for this entry.\nNeeds ${fmtTIMBS(timbsNeeded)} ` +
          `(${extraRounds} extra round${extraRounds === 1 ? "" : "s"}` +
          `${!replacing && !useETH ? " + entry" : ""}), you have ${fmtTIMBS(balNow)}. ` +
          `At the current cost you can afford about ${roundsAffordable} extra round(s). ` +
          `Lower the extra-rounds count or top up TIMBS.`
        );
        btn.disabled = false; btn.textContent = resetLabel;
        return;
      }
    }

    // Pre-flight the ETH side too: gas for submitEntry grows with extra
    // rounds (observed live: 12 extra rounds needs >593k gas — a wallet
    // holding 0.0013 ETH hit "gas required exceeds allowance" 10 times in a
    // row because balance − entry value capped estimateGas below the real
    // cost). Budget ~800k gas at the current fee and say exactly what's
    // missing instead of letting estimateGas fail opaquely.
    {
      const ethBal   = await readProv().getBalance(userAddress);
      const entryVal = (!replacing && useETH) ? entryCostETH_wei : ethers.BigNumber.from(0);
      const feeData  = await readProv().getFeeData().catch(() => null);
      const maxFee   = feeData && feeData.maxFeePerGas ? feeData.maxFeePerGas : ethers.utils.parseUnits("2", "gwei");
      const gasBudget = maxFee.mul(800_000);
      if (ethBal.lt(entryVal.add(gasBudget))) {
        alert(
          `Not enough ETH to cover gas for this entry.\n` +
          `You have ${fmtETH(ethBal)} ETH; this needs about ` +
          `${fmtETH(entryVal.add(gasBudget))} ETH` +
          (useETH && !replacing ? ` (entry + gas)` : ` (gas)`) +
          `. Entries with more extra rounds need more gas — top up ETH or ` +
          `lower the extra-rounds count.`
        );
        btn.disabled = false; btn.textContent = resetLabel;
        return;
      }
    }

    if (timbsNeeded.gt(0)) {
      const timbs = await writeContract(ADDRESSES.TIMBSToken, TIMBS_ABI);
      const allow = await timbs.allowance(userAddress, ADDRESSES.GameRegistry);
      if (allow.lt(timbsNeeded)) {
        btn.textContent = "Approving TIMBS…";
        DebugHub.logCheckpoint("Prize:Approve Requested", "pass");
        const gas = await getGasParams(); const nonce = await getPendingNonce();
        await confirmTx(await timbs.approve(ADDRESSES.GameRegistry, ethers.constants.MaxUint256, { ...gas, nonce }));
        DebugHub.logCheckpoint("Prize:Approve Confirmed", "pass");
      }
    }

    btn.textContent = replacing ? "Updating…" : "Submitting…";
    DebugHub.logCheckpoint("Prize:Entry Requested", "pass");
    const gas   = await getGasParams();
    const nonce = await getPendingNonce();
    let tx;
    if (replacing) {
      // replaceEntry concedes the senior ticket and mints a replacement —
      // the principal carries over, so no ETH value (non-payable in v2).
      tx = await registry.replaceEntry(string6, extraRounds, { ...gas, nonce });
    } else {
      let value = ethers.BigNumber.from(0);
      if (useETH) {
        // v5 entry cost is dynamic and fixed per round, so it can move between
        // the quoted price and this tx (e.g. a round rolled over). Re-read the
        // live cost right before sending and add a small buffer — submitEntry
        // refunds any overpayment, so the buffer is free insurance against
        // WrongEscrowAmount from intra-flight price drift.
        let liveCost = entryCostETH_wei;
        try { liveCost = await registry.entryCostETH(); } catch {}
        value = liveCost.mul(102).div(100); // +2%, refunded on-chain
      }
      tx = await registry.submitEntry(string6, useETH, extraRounds, { ...gas, nonce, value });
    }
    DebugHub.logCheckpoint("Prize:Entry Submitted", "pass");
    await confirmTx(tx);
    DebugHub.logCheckpoint("Prize:Entry Confirmed", "pass");

    btn.textContent = replacing ? "Entry updated ✓" : "Entry submitted ✓";
    document.getElementById("entry-string").value = "";
    extraRounds = 0;
    document.getElementById("extra-rounds-val").textContent = "0";
    renderPlaysRound(currentRoundNum);
    loadEntryCosts();     // our own entry moves the dynamic price — re-quote it
    updateCostDisplay();  // clear the stale "+N TIMBS" extra-rounds note
    await loadMyEntries();
    setTimeout(() => { updateEntryButton(); }, 2000);

  } catch (err) {
    console.error("Entry failed:", err.message);
    const sel = advanceRevertSelector(err);
    if (sel) DebugHub.logError("handleSubmitEntry.revertSelector", new Error("selector " + sel));
    DebugHub.logError("handleSubmitEntry", err);
    DebugHub.logCheckpoint("Prize:Entry Failed", "fail");
    if (ENTRY_REVERTS[sel]) {
      alert(ENTRY_REVERTS[sel]);
    } else if (/gas required exceeds allowance/i.test(err.message || "")) {
      // estimateGas capped by the wallet's ETH balance — the pre-flight
      // budget is an estimate, so this can still slip through on a fee spike.
      alert(
        "Not enough ETH to cover gas for this entry. " +
        "Entries with more extra rounds need more gas — top up ETH or " +
        "lower the extra-rounds count."
      );
    }
    btn.textContent = "Failed — try again";
    setTimeout(() => { btn.textContent = resetLabel; btn.disabled = false; }, 2500);
  }
}

// ─── My Entries ───────────────────────────────────────────────────────────────

function bytes6ToStr(b6) {
  if (!b6 || b6 === "0x000000000000") return "——";
  const hex = b6.replace("0x", "");
  let s = "";
  for (let i = 0; i < 6; i++) {
    const code = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (code > 0) s += String.fromCharCode(code);
  }
  return s;
}

// A prior-epoch ticket belongs to a retired game generation. Its round numbers
// no longer apply to the live game, so the only meaningful action is
// reclaimFromPastGame(). Prefer the on-chain generation; if that read hasn't
// landed (RPC hiccup, first paint) fall back to round geometry: a new game
// resets the round to 1, so a ticket whose play window sits far above the live
// round can only be a retired-epoch record. Without this fallback a failed
// generation() read left old tickets classified as current — flooding the list
// and hiding their Reclaim button.
const PRIOR_EPOCH_ROUND_GAP = 20; // buffer above any legit extra-rounds carry
function isPriorEpoch(t, roundNow) {
  const gen = t.generation ? t.generation.toNumber() : 0;
  if (currentGen !== null) return gen < currentGen;
  if (roundNow === null)   return false;
  return t.playRound.toNumber() > roundNow + PRIOR_EPOCH_ROUND_GAP;
}

// Renders one ticket card. Conceded ancestors render tethered beneath their
// replacement, dimmed, so the chain aiming for victory stays readable.
function renderTicketRow(t, displayStatus, opts) {
  const playRound = t.playRound.toNumber();
  const lastRound = t.lastEligibleRound.toNumber();

  // A raw-Active ticket whose play round is still AHEAD in the current game is
  // a migration artifact ("carried over"): it was activated in a prior game
  // cycle, then startGame on the reused GameRegistry reset the round below its
  // play round. It stays committed on-chain — Active, earning, NOT withdrawable
  // (cancelEntry rejects a non-Pending ticket) and refundable only after its
  // run ends. We used to re-anchor its badge to "Pending", but that read as
  // "withdrawable" and produced the confusing Pending-with-no-Withdraw row.
  // Show it honestly as Active and explain the state in the hint instead.
  // A ticket from a PAST generation was stranded by a new game epoch. Its
  // round numbers no longer apply to the live game, so none of the current-game
  // actions (withdraw / refund-window / carried-over) are meaningful — the only
  // action is reclaimFromPastGame(), which returns the principal immediately.
  // Prefer the round the loader resolved (it falls back to the registry's own
  // currentRound when the 4s poll hasn't landed) over the module global, which
  // can still be null on first paint. Reading the null global made an expired
  // ticket render as "Active / earning yield" with NO Refund button — so it
  // looked permanently stuck even though its principal was refundable.
  const roundNow = (opts && opts.round != null) ? opts.round : currentRoundNum;

  const isPastGen  = isPriorEpoch(t, roundNow);

  const notYetPlaying = roundNow !== null && roundNow < playRound;
  const carriedOver   = notYetPlaying && t.status === 1 && !isPastGen;

  const statusName  = STATUS_NAMES[displayStatus] || "Unknown";
  const statusClass = "status-" + statusName.toLowerCase();
  const isETH       = t.escrowToken === "0x0000000000000000000000000000000000000000";
  const principal   = t.escrowAmount.isZero()
    ? ""
    : ` · ${isETH ? fmtETH(t.escrowAmount) : fmtTIMBS(t.escrowAmount)}`;
  const roundsTxt = playRound === lastRound ? `R${playRound}` : `R${playRound}–R${lastRound}`;

  // Raw status drives the action buttons; display status drives the badge.
  const raw = t.status;
  // The contract's cancelEntry accepts ANY raw-Pending ticket regardless of
  // round — once a ticket's play round arrives it's flipped to Active, so
  // raw === 0 already means "hasn't started playing yet." Gating additionally
  // on currentRoundNum hid the Withdraw button whenever the round poll hadn't
  // landed yet (null) or briefly lagged, even though the on-chain cancel would
  // have succeeded. Mirror the contract: raw-Pending ⇒ withdrawable.
  const canCancel = raw === 0 && !isPastGen;
  const expired   = roundNow !== null && roundNow > lastRound;
  // Refundable through the contract's per-ticket forfeitRound — the later of
  // the refund-window end and (for a late winner) the post-claim window (§14).
  const forfeitRound = t.forfeitRound ? t.forfeitRound.toNumber() : lastRound + 4;
  const inWindow  = roundNow !== null && roundNow <= forfeitRound;
  const canRefund = (raw === 0 || raw === 1) && expired && inWindow && !t.escrowAmount.isZero() && !isPastGen;
  // Prior-game leftover with principal still held — reclaim it immediately.
  const canReclaim = isPastGen && (raw === 0 || raw === 1) && !t.escrowAmount.isZero();

  // A ticket past its last eligible round but not yet swept is still raw-Active,
  // yet it's out of play — only its refund remains. Show "Refundable" rather
  // than a misleading "Active", so the badge count matches the round's entries.
  let badgeName  = statusName;
  let badgeClass = statusClass;
  if (canRefund) { badgeName = "Refundable"; badgeClass = "status-refundable"; }
  // Expired and out of play with nothing left to do — either it never held a
  // deposit (a free mint before entry costs were set) or its refund window has
  // closed. Either way it's not "Active" anymore; show it as Expired so it
  // stops reading as a live entry.
  else if (expired && !isPastGen && (raw === 0 || raw === 1)) {
    badgeName = "Expired"; badgeClass = "status-expired";
  }

  let hint = "";
  if (canReclaim)                      hint = ` · from a previous game · reclaim your deposit`;
  else if (canCancel)                  hint = ` · withdrawable until R${playRound} starts`;
  else if (carriedOver)                hint = ` · carried from a prior game · locked in, refundable after R${lastRound}`;
  else if (raw === 1 && !expired)      hint = ` · earning yield for the pool`;
  else if (canRefund)                  hint = ` · principal refundable now`;
  else if ((raw === 0 || raw === 1) && expired && t.escrowAmount.isZero()) hint = ` · expired · no deposit to refund`;
  else if ((raw === 0 || raw === 1) && expired && !inWindow) hint = ` · refund window closed`;

  const row = document.createElement("div");
  row.className = "entry-row-item" + (opts.tethered ? " ticket-conceded" : "");
  row.innerHTML = `
    <div>
      <div class="entry-row-string">${opts.tethered ? '<span class="tether-mark">⤷</span> ' : ""}${bytes6ToStr(t.string6)}</div>
      <div class="entry-row-meta">Ticket #${t.id} · plays ${roundsTxt}${principal}${hint}</div>
    </div>
    <div style="display:flex;align-items:center;gap:6px">
      <span class="entry-status-badge ${badgeClass}">${badgeName}</span>
      ${canReclaim ? `<button class="btn-claim-mini" onclick="handleReclaimPastGame(${t.id})">Reclaim principal</button>` : ""}
      ${canRefund ? `<button class="btn-claim-mini" onclick="handleClaimRefund(${t.id})">Refund principal</button>` : ""}
      ${canCancel ? `<button class="btn-claim-mini" onclick="handleCancelEntry()">Withdraw</button>` : ""}
    </div>`;
  return row;
}

// Opt-in Telegram reminders: deep-link the connected wallet to the bot
// (t.me/SettlerTimbBot?start=<wallet>). The bot stores the wallet↔chat link and
// the workers DM first-letter matches + pre-forfeit refund reminders. Shown only
// while connected; a wallet address is public, so the raw address in the link is
// fine (it's within Telegram's start-param charset + length).
function updateRemindButton() {
  const btn  = document.getElementById("tg-remind-btn");
  const note = document.getElementById("tg-remind-note");
  if (!btn) return;
  if (userAddress) {
    btn.href = `https://t.me/SettlerTimbBot?start=${userAddress.toLowerCase()}`;
    btn.classList.remove("hidden");
    if (note) note.classList.remove("hidden");
  } else {
    btn.removeAttribute("href");
    btn.classList.add("hidden");
    if (note) note.classList.add("hidden");
  }
}

async function loadMyEntries() {
  const list = document.getElementById("my-entries-list");
  updateRemindButton();
  hasPlayEntry = false;
  if (!userAddress) {
    myActiveTicketStr = null;
    list.innerHTML = '<div class="empty-state">Your tickets live here once you connect.</div>';
    updateEntryButton();
    return;
  }
  try {
    const registry = new ethers.Contract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI, readProv());
    // Anchor for the relevance filter. currentRoundNum is set by pollRoundState,
    // but init/connect run these in parallel, so it can still be null here —
    // fall back to the registry's own round so old closed tickets are hidden
    // instead of the filter short-circuiting and showing everything.
    let relRound = currentRoundNum;
    const [res, roundFallback, genRead] = await Promise.all([
      registry.getTicketsOf(userAddress),
      relRound === null ? registry.currentRound().catch(() => null) : Promise.resolve(null),
      registry.generation().catch(() => null)
    ]);
    if (relRound === null && roundFallback !== null) relRound = roundFallback.toNumber();
    if (genRead !== null) currentGen = genRead.toNumber();
    const ticketList = res.list ?? res[0];
    const displays   = res.displayStatuses ?? res[1];
    DebugHub.logCheckpoint("Compete:Tickets Loaded", "pass");
    if (!ticketList.length) {
      list.innerHTML = '<div class="empty-state">No tickets yet. Pick your six and you\'re in.</div>';
      updateEntryButton();
      return;
    }

    // Index by id; find chain heads (not superseded by anything).
    const byId = new Map();
    const displayById = new Map();
    ticketList.forEach((t, i) => {
      byId.set(t.id.toString(), t);
      displayById.set(t.id.toString(), displays[i]);
    });

    // A ticket only counts toward the current game if it belongs to the current
    // generation. Prior-generation tickets are inert (reclaimable), never the
    // wallet's live entry — mirrors the contract's _isLive gen guard.
    const isCurGen = (t) => currentGen === null || t.generation.toNumber() === currentGen;

    // One eligible live ticket per wallet — determines Submit vs Update.
    hasPlayEntry = ticketList.some(t =>
      isCurGen(t) && (
        t.status === 0 ||
        (t.status === 1 && relRound !== null && relRound <= t.lastEligibleRound.toNumber())
      )
    );

    // The ticket actually playing THIS round drives the gold-streak meter.
    myActiveTicketStr = null;
    if (relRound !== null) {
      const playing = ticketList.find(t =>
        isCurGen(t) &&
        t.status === 1 &&
        t.playRound.toNumber() <= relRound &&
        relRound <= t.lastEligibleRound.toNumber()
      );
      if (playing) myActiveTicketStr = bytes6ToStr(playing.string6);
    }

    // Hide history clutter: once a ticket is past its forfeitRound (the §14
    // per-ticket refund deadline — LER+4, or LER+6 for a late winner) it can't
    // be played or refunded, so drop those heads. Live/pending and
    // still-refundable tickets stay.
    const withinRelevance = (t) => {
      // A prior-epoch ticket is governed EXCLUSIVELY by whether it still holds
      // reclaimable principal — never by a round comparison. Its round numbers
      // live in a retired generation, so comparing them against the live round
      // (which resets to 1 on a new game) would keep every stale ticket forever
      // (1 <= forfeitRound≈205 is always true). Keep it only if there's a
      // deposit left to reclaim; otherwise it's dead history — drop it.
      if (isPriorEpoch(t, relRound)) {
        return (t.status === 0 || t.status === 1) && !t.escrowAmount.isZero();
      }
      if (relRound === null) return true;
      const fr = t.forfeitRound && !t.forfeitRound.isZero()
        ? t.forfeitRound.toNumber()
        : t.lastEligibleRound.toNumber() + 4;
      return relRound <= fr;
    };

    const heads = ticketList
      .filter(t => t.supersededBy.isZero() && withinRelevance(t))
      .sort((a, b) => b.id.toNumber() - a.id.toNumber())
      .slice(0, 8);

    if (!heads.length) {
      list.innerHTML = '<div class="empty-state">No active tickets</div>';
      updateEntryButton();
      return;
    }

    list.innerHTML = "";
    for (const head of heads) {
      list.appendChild(renderTicketRow(head, displayById.get(head.id.toString()), { tethered: false, round: relRound }));
      // Walk conceded ancestry, newest first, tethered beneath the head.
      let cursor = head.supersedes;
      let depth  = 0;
      while (!cursor.isZero() && depth < 8) {
        const anc = byId.get(cursor.toString());
        if (!anc) break;
        list.appendChild(renderTicketRow(anc, displayById.get(anc.id.toString()), { tethered: true, round: relRound }));
        cursor = anc.supersedes;
        depth++;
      }
    }
    updateEntryButton();
  } catch (e) {
    console.warn("loadMyEntries:", e.message);
    DebugHub.logError("loadMyEntries", e);
    DebugHub.logCheckpoint("Compete:Tickets Loaded", "fail");
    list.innerHTML = '<div class="empty-state">Could not load tickets</div>';
  }
}

async function handleClaimRefund(ticketId) {
  try {
    DebugHub.logCheckpoint("Prize:Refund Requested", "pass");
    const registry = await writeContract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI);
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    await confirmTx(await registry.claimRefund(ticketId, { ...gas, nonce }));
    DebugHub.logCheckpoint("Prize:Refund Confirmed", "pass");
    await loadMyEntries();
  } catch (err) {
    DebugHub.logError("handleClaimRefund", err);
    DebugHub.logCheckpoint("Prize:Refund Failed", "fail");
    alert("Refund failed: " + (err?.reason || err.message));
  }
}

// Reclaim principal from a ticket stranded by a previous game epoch. The
// contract's reclaimFromPastGame is round-agnostic — it only requires the
// ticket be from a prior generation and still hold escrow — so it succeeds the
// instant a new game starts, no refund-window wait.
async function handleReclaimPastGame(ticketId) {
  try {
    DebugHub.logCheckpoint("Prize:Reclaim Requested", "pass");
    const registry = await writeContract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI);
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    await confirmTx(await registry.reclaimFromPastGame(ticketId, { ...gas, nonce }));
    DebugHub.logCheckpoint("Prize:Reclaim Confirmed", "pass");
    await loadMyEntries();
  } catch (err) {
    DebugHub.logError("handleReclaimPastGame", err);
    DebugHub.logCheckpoint("Prize:Reclaim Failed", "fail");
    alert("Reclaim failed: " + (err?.reason || err.message));
  }
}

// ─── Advance Panel (user nudge / batch nudge via router) ──────────────────────
// advanceScroll(count) on the router: count=1 is a single nudge, up to
// MAX_BATCH_NUDGE (20 on-chain) applies that many nudges in one transaction,
// one at a time, in order. The panel's chips/stepper just choose `count`.

const ROUTER_NUDGE_ABI = [
  "function advanceScroll(uint256 count) external",
  "function freeNudgesRemaining(address user) external view returns (uint256)"
];
const ADVANCE_MAX = 20; // mirrors TimbSwapRouter.MAX_BATCH_NUDGE

// Free (gas-only) advanceScroll nudges left for this wallet THIS segment.
// null = not yet known; the router caps the free path per address per segment
// (paid swap-nudges are uncapped). Refreshed each poll and after an advance.
let freeNudgesLeft = null;

function advanceCeiling() {
  // Chosen batch can't exceed the on-chain per-tx cap nor the wallet's
  // remaining free allowance this segment.
  return freeNudgesLeft === null ? ADVANCE_MAX : Math.min(ADVANCE_MAX, freeNudgesLeft);
}

function setAdvanceCount(n) {
  advanceCount = Math.max(1, Math.min(advanceCeiling(), n));
  renderAdvancePreview();
}

// "Max" chip — advance by exactly the remaining free allowance this segment
// (or the per-tx cap when that's unknown). Keeps the label honest as the cap
// is spent or retuned, instead of a fixed "+20" that the 10/segment cap
// silently clamped.
function setAdvanceMax() {
  setAdvanceCount(advanceCeiling());
}
function adjustAdvanceCount(delta) {
  setAdvanceCount(advanceCount + delta);
}

function renderAdvancePreview() {
  const chipsWrap = document.getElementById("advance-chips");
  if (chipsWrap) {
    const ceil = advanceCeiling();
    chipsWrap.querySelectorAll(".adv-chip").forEach(c => {
      if (c.id === "adv-chip-max") {
        // Show the live cap once we know it; plain "Max" when unknown.
        c.textContent = (freeNudgesLeft !== null) ? `Max (${ceil})` : "Max";
        c.classList.toggle("active", ceil > 0 && advanceCount === ceil);
        c.disabled = ceil === 0;
      } else {
        const n = Number(c.dataset.n);
        c.classList.toggle("active", n === advanceCount);
        // Grey out fixed amounts you can't afford within the free cap.
        c.disabled = (freeNudgesLeft !== null && n > ceil);
      }
    });
  }
  const countEl = document.getElementById("advance-count-val");
  if (countEl) countEl.textContent = advanceCount;

  const submitBtn = document.getElementById("advance-submit-btn");
  if (submitBtn) {
    // Game semantics: the 59:45–60:00 intermission belongs to calculations.
    // USER nudges are deactivated during it. The button holds disabled for
    // the first 6 seconds ("calculating") to give the keeper/lazy settle
    // its moment, then re-arms as a direct permissionless settleSegment()
    // push — any player can start the next segment instead of waiting on
    // the keeper cron.
    if (advanceInSettlement) {
      const holding = Date.now() - settlementSeenAt < SETTLE_BTN_HOLD_MS;
      submitBtn.textContent = holding
        ? "Intermission — calculating…"
        : "Settle & start next segment";
      submitBtn.disabled = holding;
    } else if (freeNudgesLeft === 0) {
      // Free (gas-only) allowance spent this segment — the paid path (a swap)
      // still moves the meter, and it's worth more per action.
      submitBtn.textContent = "Free nudges used — swap to move the meter";
      submitBtn.disabled = true;
    } else {
      submitBtn.textContent = (freeNudgesLeft !== null && freeNudgesLeft <= 5)
        ? `Advance ×${advanceCount} · ${freeNudgesLeft} free left`
        : `Advance ×${advanceCount}`;
      submitBtn.disabled = false;
    }
  }

  const previewEl = document.getElementById("advance-preview");
  const fromEl = previewEl?.querySelector(".ap-from");
  const toEl   = previewEl?.querySelector(".ap-to");
  if (!previewEl || !fromEl || !toEl) return;

  if (activeSegIndex < 0 || !activeSegCounter || !userAddress) {
    previewEl.firstChild.textContent = "SEG — · ";
    fromEl.textContent = "·"; toEl.textContent = "·";
    return;
  }
  const from = Number(activeSegCounter) % 36;
  const to   = (from + advanceCount) % 36;
  previewEl.firstChild.textContent = `SEG ${activeSegIndex + 1} · `;
  fromEl.textContent = ALPHABET[from];
  toEl.textContent   = ALPHABET[to];
}

// The settle push holds back for the intermission's first 6 seconds —
// the calculation moment — then the button re-enables itself to push
// into the next segment (see renderAdvancePreview).
let settlementSeenAt = 0;
const SETTLE_BTN_HOLD_MS = 6000;

function updateAdvancePanel(inSettlement) {
  const wasInSettlement = advanceInSettlement;
  advanceInSettlement = !!inSettlement;
  if (advanceInSettlement && !wasInSettlement) {
    settlementSeenAt = Date.now();
    // Re-render right at the 6s mark so the button re-arms itself
    // without waiting for the next 4s poll tick.
    setTimeout(renderAdvancePreview, SETTLE_BTN_HOLD_MS + 100);
  }
  const panel = document.getElementById("advance-panel");
  if (!panel) return;
  panel.classList.toggle("hidden", !userAddress);
  const submitBtn = document.getElementById("advance-submit-btn");
  if (submitBtn && !advanceInSettlement) submitBtn.disabled = false;
  renderAdvancePreview();
}

// Wallets often mask estimation reverts as opaque -32603 errors. Decode the
// custom-error selector so a mis-wired deployment names its own fix.
// GameRegistry submitEntry/replaceEntry custom errors → human messages.
const ENTRY_REVERTS = {
  "0x4cbc5815": "Too many extra rounds — the maximum is 12. Lower the extra-rounds count and try again.", // TooManyExtraRounds(uint256,uint256)
  "0xe450d38c": "Not enough TIMBS for this entry (extra rounds cost TIMBS). Reduce extra rounds or top up TIMBS.", // ERC20InsufficientBalance
  "0xfb8f41b2": "TIMBS spending isn't approved for the full amount — approve, then retry.",                 // ERC20InsufficientAllowance
  // v5 dynamic pricing: the entry cost is computed on-chain and fixed per round,
  // so it can move between the quote you saw and your transaction landing.
  "0x0ee6446f": "The entry price just moved — it's dynamic and floats each round. Refresh the page for the current cost, then re-enter.", // WrongEscrowAmount(uint256,uint256)
  "0x045a8fa9": "You already have a live ticket this round. Use “Update entry” to change it, or wait for it to finish.",           // ActiveTicketExists(uint256)
  "0xf024641d": "No live ticket to act on — submit a fresh entry instead.",                                  // NoLiveTicket(address)
  "0xab35696f": "Entries are paused right now — try again once the game is unpaused.",                       // ContractPaused()
};

const ADVANCE_REVERTS = {
  "0x38a1d6d8": "Router doesn't know the prize contract — call setTimbPrize(<TimbPrize>) on TimbSwapRouter (owner).",   // PrizeNotSet()
  "0x91655201": "TimbPrize doesn't recognize this router — call setRouter(<TimbSwapRouter>) on TimbPrize (owner).",     // NotRouter()
  "0x3a5f7b57": "The game hasn't been started — call startGame() on TimbPrize (owner).",                                // GameNotStarted()
  "0x717824fb": "Settlement is paused — nudges stay blocked until unpauseSettlement().",                                // InSettlementWindow()
  "0x57b4f0b1": "You've used all your free nudges for this segment. Swap an eligible token to keep moving the meter, or wait for the next segment.", // FreeNudgeCapReached(uint256,uint256)
  "0xf451af97": "Nudge count out of range — pick a smaller batch (max 20 per transaction).",                            // InvalidNudgeCount(uint256,uint256)
};

function advanceRevertSelector(err) {
  const d = err?.data?.originalError?.data ?? err?.error?.data?.data ??
            err?.error?.data ?? err?.data;
  const hex = typeof d === "string" ? d
    : (typeof d?.data === "string" ? d.data : null);
  if (hex && hex.startsWith("0x") && hex.length >= 10) return hex.slice(0, 10).toLowerCase();
  // Structured fields only — message-text matching false-positived on
  // addresses and fee values in production.
  return null;
}

// During the settlement window the Advance button routes here instead:
// settleSegment() is permissionless on TimbPrize v3.1, so any connected
// player can land the settle and start the next segment. If the keeper
// (or another player) wins the race, the estimate reverts — re-poll and
// report "already settled" instead of an error.
const PRIZE_SETTLE_ABI = ["function settleSegment() external"];

async function handleSettleNow() {
  const btn = document.getElementById("advance-submit-btn");
  try {
    if (btn) { btn.disabled = true; btn.textContent = "Settling…"; }
    DebugHub.logCheckpoint("Prize:Settle Requested", "pass");
    const prize = await writeContract(ADDRESSES.TimbPrize, PRIZE_SETTLE_ABI);
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    await confirmTx(await prize.settleSegment({ ...gas, nonce }));
    DebugHub.logCheckpoint("Prize:Settle Confirmed", "pass");
    if (btn) btn.textContent = "Settled ✓ — next segment live";
    await pollRoundState();
    setTimeout(() => { if (btn) { btn.disabled = false; renderAdvancePreview(); } }, 1500);
  } catch (err) {
    await pollRoundState();
    if (!advanceInSettlement) {
      // Someone else's settle landed first — that's a win, not a failure.
      DebugHub.logCheckpoint("Prize:Settle Raced", "pass");
      if (btn) { btn.textContent = "Already settled ✓"; setTimeout(() => { btn.disabled = false; renderAdvancePreview(); }, 1500); }
      return;
    }
    const sel = advanceRevertSelector(err);
    if (sel) DebugHub.logError("handleSettleNow.revertSelector", new Error("selector " + sel));
    DebugHub.logError("handleSettleNow", err);
    DebugHub.logCheckpoint("Prize:Settle Failed", "fail");
    if (btn) { btn.textContent = "Failed — try again"; setTimeout(() => { btn.disabled = false; renderAdvancePreview(); }, 2000); }
  }
}

async function handleAdvance() {
  if (!userAddress) return;
  if (advanceInSettlement) return handleSettleNow();
  const btn = document.getElementById("advance-submit-btn");
  const count = advanceCount;
  const orig = btn ? btn.textContent : "";
  try {
    if (btn) { btn.disabled = true; btn.textContent = count > 1 ? `Advancing ×${count}…` : "Advancing…"; }
    DebugHub.logCheckpoint("Prize:Advance Requested", "pass");
    const router = await writeContract(ADDRESSES.TimbSwapRouter, ROUTER_NUDGE_ABI);
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    await confirmTx(await router.advanceScroll(count, { ...gas, nonce }));
    DebugHub.logCheckpoint("Prize:Advance Confirmed", "pass");
    if (btn) btn.textContent = "Advanced ✓";
    await pollRoundState();
    setTimeout(() => { if (btn) { btn.disabled = false; renderAdvancePreview(); } }, 1500);
  } catch (err) {
    const sel = advanceRevertSelector(err);
    if (sel) DebugHub.logError("handleAdvance.revertSelector", new Error("selector " + sel));
    DebugHub.logError("handleAdvance", err);
    DebugHub.logCheckpoint("Prize:Advance Failed", "fail");
    if (sel && ADVANCE_REVERTS[sel]) alert(ADVANCE_REVERTS[sel]);
    if (btn) { btn.textContent = "Failed — try again"; setTimeout(() => { btn.disabled = false; renderAdvancePreview(); }, 2000); }
  }
}

// ─── Cancel Pending Entry (pre-round withdraw) ────────────────────────────────

async function handleCancelEntry() {
  try {
    DebugHub.logCheckpoint("Prize:Cancel Requested", "pass");
    const registry = await writeContract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI);
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    // v2: cancels the wallet's live Pending ticket (pre-round) — no args.
    await confirmTx(await registry.cancelEntry({ ...gas, nonce }));
    DebugHub.logCheckpoint("Prize:Cancel Confirmed", "pass");
    await loadMyEntries(); // also refreshes hasPlayEntry / the entry button
  } catch (err) {
    DebugHub.logError("handleCancelEntry", err);
    DebugHub.logCheckpoint("Prize:Cancel Failed", "fail");
    alert("Withdraw failed: " + (err?.reason || err.message));
  }
}

// ─── Claim Winnings ───────────────────────────────────────────────────────────

async function handleClaimWinnings(round) {
  const btn = document.getElementById("claim-btn-" + round);
  if (btn) { btn.disabled = true; btn.textContent = "Claiming…"; }
  try {
    DebugHub.logCheckpoint("Prize:Claim Requested", "pass");
    const prize = await writeContract(ADDRESSES.TimbPrize, TIMBPRIZE_ABI);
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    await confirmTx(await prize.claimWinnings(round, { ...gas, nonce }));
    DebugHub.logCheckpoint("Prize:Claim Confirmed", "pass");
    if (btn) btn.textContent = "Claimed ✓";
    await loadPastRounds();
  } catch (err) {
    DebugHub.logError("handleClaimWinnings", err);
    DebugHub.logCheckpoint("Prize:Claim Failed", "fail");
    if (btn) { btn.textContent = "Failed"; btn.disabled = false; }
  }
}

// ─── Past Rounds ──────────────────────────────────────────────────────────────

// Recent Rounds — settled rounds newest-first, shown 8 to a table. The table
// flips (no internal scroll): page 0 is the newest 8, and the pager walks back
// up to 128 rounds. pastRoundsPage is the current table index (0 = newest).
const PAST_ROUNDS_PER_PAGE = 8;
const PAST_ROUNDS_LOOKBACK = 128;
let pastRoundsPage = 0;

// Flip a table. dir -1 = newer (toward page 0), +1 = older. Clamped in
// loadPastRounds against how many rounds actually exist.
function pastRoundsFlip(dir) {
  const next = pastRoundsPage + dir;
  if (next < 0) return;
  pastRoundsPage = next;
  loadPastRounds();
}

async function loadPastRounds() {
  const list = document.getElementById("past-rounds-list");
  const pager = document.getElementById("past-rounds-pager");
  const hasRows = () => !!list.querySelector(".past-round-row");
  const hidePager = () => pager && pager.classList.add("hidden");
  try {
    const prize = new ethers.Contract(ADDRESSES.TimbPrize, TIMBPRIZE_ABI, readProv());

    // Anchor round: currentRoundNum is set by pollRoundState, but init runs
    // these in parallel so it can still be null here — read the on-chain round
    // as a fallback so the section doesn't wrongly show "No completed rounds".
    let round = currentRoundNum;
    if (!round) { try { round = (await prize.getRoundState()).round.toNumber(); } catch {} }
    if (!round || round <= 1) {
      if (!hasRows()) list.innerHTML = '<div class="empty-state">No completed rounds yet</div>';
      hidePager();
      return;
    }

    // Round-id window: newest settled candidate down to at most 128 rounds back.
    const newest = round - 1;
    const oldest = Math.max(1, round - PAST_ROUNDS_LOOKBACK);
    const totalPages = Math.max(1, Math.ceil((newest - oldest + 1) / PAST_ROUNDS_PER_PAGE));
    // Clamp the page in case rounds have advanced/settled since the last flip.
    if (pastRoundsPage > totalPages - 1) pastRoundsPage = totalPages - 1;
    if (pastRoundsPage < 0) pastRoundsPage = 0;

    // Round ids for the current table (up to 8), newest-first.
    const pageTop = newest - pastRoundsPage * PAST_ROUNDS_PER_PAGE;
    const pageBottom = Math.max(oldest, pageTop - PAST_ROUNDS_PER_PAGE + 1);
    const ids = [];
    for (let r = pageTop; r >= pageBottom; r--) ids.push(r);
    const results = await Promise.all(ids.map(r =>
      prize.getRoundResult(r).then(res => ({ r, res })).catch(() => null)
    ));
    const settled = results.filter(x => {
      if (!x) return false;
      const ws = bytes6ToStr(x.res.winningString);
      return ws && ws !== "——";
    });

    // Entries at the end of each round — getRoundEntrants(r).length is exactly
    // what the contract snapshots as RoundSettled.totalEntries (and it isn't
    // pruned after settlement), so it's the canonical per-round entry count.
    const registry = new ethers.Contract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI, readProv());
    const entries = {};
    await Promise.all(settled.map(async ({ r }) => {
      entries[r] = (await registry.getRoundEntrants(r).catch(() => [])).length;
    }));

    // Claim state for rounds THIS wallet won (parallel).
    const claimed = {};
    if (userAddress) {
      await Promise.all(settled.map(async ({ r, res }) => {
        if (res.winners.map(w => w.toLowerCase()).includes(userAddress.toLowerCase())) {
          claimed[r] = await prize.hasClaimed(r, userAddress).catch(() => true);
        }
      }));
    }

    // Show/enable the pager once there's more than one table's worth of history.
    const renderPager = () => {
      if (!pager) return;
      if (totalPages <= 1) { pager.classList.add("hidden"); return; }
      pager.classList.remove("hidden");
      document.getElementById("past-page-label").textContent = `Page ${pastRoundsPage + 1} / ${totalPages}`;
      document.getElementById("past-newer-btn").disabled = pastRoundsPage <= 0;
      document.getElementById("past-older-btn").disabled = pastRoundsPage >= totalPages - 1;
    };

    if (!settled.length) {
      // A newer page with nothing settled shouldn't wipe an already-shown table,
      // but page 0 with no settled rounds genuinely means no history yet.
      if (!hasRows() || pastRoundsPage === 0) {
        list.innerHTML = '<div class="empty-state">No completed rounds on this page</div>';
      }
      renderPager();
      return;
    }

    list.innerHTML = settled.map(({ r, res }) => {
      const ws = bytes6ToStr(res.winningString);
      let claimHtml = "";
      if (userAddress && res.winners.length > 0 &&
          res.winners.map(w => w.toLowerCase()).includes(userAddress.toLowerCase())) {
        // Prize claim: 2 rounds flat from the match (TimbPrize v4 dropped the
        // old +1 grace) — claimable while currentRound <= settledRound + 2.
        const inWindow = round <= r + 2;
        if (!claimed[r] && inWindow) {
          claimHtml = `<span class="won-note">You called it.</span><button id="claim-btn-${r}" class="btn-claim-round" onclick="handleClaimWinnings(${r})">Claim your cut · ${fmt(res.perWinner)} ETH</button>`;
        } else if (claimed[r]) {
          claimHtml = `<span class="claimed-badge">Claimed ✓</span>`;
        } else {
          claimHtml = `<span class="expired-badge">Window closed</span>`;
        }
      }
      const winnerCls = claimHtml.includes("btn-claim") ? " past-round-winner" : "";
      return `<div class="past-round-row${winnerCls}">
          <div class="past-round-left">
            <span class="past-round-num">Round ${r}</span>
            <span class="past-round-string${res.winners.length > 0 ? " gold-string" : ""}">${ws}</span>
          </div>
          <div class="past-round-right">
            <span class="past-round-meta">${entries[r] ?? 0} entr${(entries[r] ?? 0) === 1 ? "y" : "ies"} · ${res.winners.length} winner${res.winners.length !== 1 ? "s" : ""} · ${fmt(res.potAmount)} ETH</span>
            ${claimHtml}
          </div>
        </div>`;
    }).join("");
    renderPager();
  } catch (e) {
    DebugHub.logError("loadPastRounds", e); // keep whatever's shown on a transient failure
  }
}

// ─── Wallet Connect ───────────────────────────────────────────────────────────

async function handleConnect() {
  DebugHub.logCheckpoint("Wallet Connect Requested", "pass");
  const ok = await connectWallet();
  if (!ok) { DebugHub.logCheckpoint("Wallet Connect Failed", "fail"); return; }

  DebugHub.startSession(userAddress);
  DebugHub.logSecurity("Chain Check", "pass");
  DebugHub.logCheckpoint("Wallet Connected", "pass");

  document.getElementById("connect-btn").classList.add("hidden");
  document.getElementById("wallet-info").classList.remove("hidden");
  document.getElementById("network-badge").classList.remove("hidden");
  document.getElementById("wallet-addr").textContent = fmtAddr(userAddress);

  updateEntryButton();
  await Promise.all([loadMyEntries(), loadPastRounds(), pollRoundState()]);
  refreshEntryBalance();

  listenForAccountChanges(async (newAddr) => {
    if (!newAddr) { handleDisconnect(); return; }
    document.getElementById("wallet-addr").textContent = fmtAddr(newAddr);
    updateEntryButton();
    await Promise.all([loadMyEntries(), loadPastRounds(), pollRoundState()]);
    refreshEntryBalance();
  });
}

function handleDisconnect() {
  DebugHub.endSession();
  disconnectWallet();
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
  updateEntryButton();
  loadMyEntries();
  pollRoundState(); // re-render to hide active digit
  refreshEntryBalance(); // clears the balance line while disconnected
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  DebugHub.logCheckpoint("Compete:Page Loaded", "pass");
  initBannerRotation();

  // Wallet auto-reconnect runs INDEPENDENTLY of the game load. Init used to do
  // `await autoReconnect()` here, so a stalled injected wallet on a refresh
  // (Brave, saved session) froze the page BEFORE the first pollRoundState —
  // leaving round/pot/tickets stuck on "Loading" until a full site-data wipe.
  // Now the round state always loads; the wallet UI fills in when (or if) the
  // reconnect resolves. autoReconnect() is also timeout-bounded in config.js.
  autoReconnect().then((_reconnected) => {
    if (_reconnected) {
      document.getElementById("connect-btn")?.classList.add("hidden");
      document.getElementById("wallet-info")?.classList.remove("hidden");
      document.getElementById("network-badge")?.classList.remove("hidden");
      const _el = document.getElementById("wallet-addr");
      if (_el) _el.textContent = fmtAddr(_reconnected);
      DebugHub.startSession(_reconnected);
      DebugHub.logCheckpoint("Wallet Auto-Reconnected", "pass");
      updateEntryButton();
      refreshEntryBalance();
      loadMyEntries(); // refresh tickets now that the wallet is known
      // Reconcile the gated view NOW rather than waiting for the next 4s poll:
      // re-render the digit track un-gated and hide the CONNECT-WALLET marquee /
      // newcomer banner the moment the reconnect lands.
      pollRoundState();
      listenForAccountChanges(async (newAddr) => {
        if (!newAddr) { handleDisconnect(); return; }
        const _addrEl = document.getElementById("wallet-addr");
        if (_addrEl) _addrEl.textContent = fmtAddr(newAddr);
        updateEntryButton();
        await Promise.all([loadMyEntries(), loadPastRounds(), pollRoundState()]);
        refreshEntryBalance();
      });
    } else {
      // Not connected — run the CONNECT WALLET marquee and show the newcomer
      // banner (its live stats fill in from the poll already in flight).
      startGateMask();
      document.getElementById("newcomer-banner")?.classList.remove("hidden");
      updateEntryButton();
    }
  }).catch(() => {
    startGateMask();
    document.getElementById("newcomer-banner")?.classList.remove("hidden");
    updateEntryButton();
  });

  // These five loaders hit the RPC independently — fire them in parallel so
  // the page paints on the slowest single round-trip instead of the sum of
  // all five. (Order between them doesn't matter; each renders on resolve.)
  await Promise.all([
    loadEntryCosts(),
    buildTokenDropdown(),
    pollRoundState(),
    loadMyEntries(),
    loadPastRounds(),
  ]);
  refreshEntryBalance(); // show the entry-token balance on load, not just after a tap

  // Timer tick every second, full state every 4s
  setInterval(() => {
    // Decrement the cached timer value (not the DOM) so the countdown keeps
    // ticking even while the banner is showing "How to play".
    if (_liveTimerText.includes(":")) {
      const [mm, ss] = _liveTimerText.split(":").map(p => parseInt(p));
      if (!isNaN(mm) && !isNaN(ss)) {
        const total = mm * 60 + ss;
        if (total > 0) {
          const nm = String(Math.floor((total-1)/60)).padStart(2,"0");
          const ns = String((total-1) % 60).padStart(2,"0");
          setBannerTimer(`${nm}:${ns} left in segment`);
        }
      }
    }
  }, 1000);

  // Skip the RPC polls while the tab is hidden — no point (and no battery/
  // data cost) refreshing state nobody is looking at. On return to the tab,
  // catch up immediately instead of waiting for the next interval.
  const whenVisible = (fn) => () => { if (!document.hidden) fn(); };
  setInterval(whenVisible(pollRoundState), 8000);
  setInterval(whenVisible(loadPastRounds), 30000);
  // Keep the entry-token balance current (drops after an entry, rises after a
  // faucet/transfer) without the user having to touch the selector.
  setInterval(whenVisible(refreshEntryBalance), 12000);
  // v5 prices float with entries and re-fix per round, so a load-time read goes
  // stale as soon as anyone enters — the extras note (a live read) then shows a
  // different price than the Entry cost box. Keep the base cost live too.
  setInterval(whenVisible(loadEntryCosts), 12000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { pollRoundState(); refreshEntryBalance(); }
  });
})();
