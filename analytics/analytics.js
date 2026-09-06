// analytics.js — live metrics, round history, recent swaps, claims

const PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
  "function totalSupply() external view returns (uint256)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"
];

const PRIZE_ABI = [
  "function currentRound() external view returns (uint256)",
  "function currentSegment() external view returns (uint256)",
  "function currentAccumulatedRewards() external view returns (uint256)",
  "function positionCounter() external view returns (uint256)",
  "function getRoundResult(uint256 round) external view returns (bytes6 winningString, uint256 potAmount, address[] winners, uint256 perWinner, uint256 remainder)",
  "event RoundSettled(uint256 indexed round, bytes6 winningString, uint256 potAmount, uint256 numWinners, uint256 remainderR, uint256 totalEntries, uint256 timestamp)",
  "event WinningsClaimed(address indexed winner, uint256 indexed round, uint256 amount)",
  // Per-round yield swept from the vault into that round's pot at settlement.
  "event YieldHarvested(uint256 indexed round, uint256 amount)"
];

const TIMBS_ABI  = ["function totalSupply() external view returns (uint256)"];
const STAKING_ABI = ["function totalStaked() external view returns (uint256)"];
const FARM_ABI    = ["function totalStaked() external view returns (uint256)"];
const REGISTRY_ABI = [
  "function getRoundEntrants(uint256 round) external view returns (address[])",
  "function verifyEntryValid(address player, uint256 round) external view returns (bool valid, bytes6 string6)"
];
const FACTORY_MIN_ABI = ["function getPairAddress(address tokenA, address tokenB) external view returns (address)"];

// Best-effort ETH→USD from the USDC/WETH pool, cached module-wide so any table
// (not just the metrics grid) can value ETH-denominated rows. Returns null when
// the pool doesn't exist / is empty.
// This used to read the USDC/WETH pool itself — a private third copy of the
// anchor, alongside config.js's oracle and landing/compete's ETH_USD_PRICE.
// Unarbitraged, that pool had drifted to ~$700/ETH, so analytics valued the
// same TIMBS differently from the swap card AND from the landing pot. Defer to
// the shared oracle so the whole site quotes one dollar.
async function ethUsdPrice(_prov) {
  return usdPriceOf(ADDRESSES.WETH);
}
function fmtUsd2(v) {
  if (v === null || v === undefined) return "—";
  if (v === 0) return "$0";
  if (v < 0.01) return "$" + v.toPrecision(2);
  return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// The Swap event's `sender` is the router, not the human. The tx initiator
// (tx.from) is the real trader. Resolve + cache per tx hash (immutable).
const _txFrom = {};
async function txFrom(hash) {
  if (_txFrom[hash]) return _txFrom[hash];
  try {
    const tx = await readProv().getTransaction(hash);
    if (tx && tx.from) return (_txFrom[hash] = tx.from);
  } catch {}
  return null;
}

// TimbYieldVault — ticket capital earns yield for the prize pot.
const YV_ABI = [
  "function previewAccrued() external view returns (uint256)",
  "function reserve() external view returns (uint256)",
  "function totalWeight() external view returns (uint256)",
  "function ratePerSecond1e18() external view returns (uint256)",
  "function lastAccrual() external view returns (uint256)",
  "event Funded(address indexed from, uint256 amount)",
  "event Harvested(uint256 amount, address indexed to)",
  "event WeightRegistered(uint256 indexed ticketId, uint256 weight, uint256 totalWeight)",
  "event WeightRemoved(uint256 indexed ticketId, uint256 weight, uint256 totalWeight)"
];

// PrizeEscrow — physical ETH backing the pot; Deposited fires on each top-up.
const ESCROW_ABI = ["event Deposited(address indexed from, uint256 amount)"];

// Event-scan lookback. Converted to blocks at runtime via blocksForDays
// (config.js) — Arb Sepolia block numbers advance ~270k/day, so a hard-coded
// block count drifts badly as a time window.
const WINDOW_DAYS = 7;
async function scanRange(prov) {
  const currentBlock = await prov.getBlockNumber();
  const windowBlocks = await blocksForDays(prov, WINDOW_DAYS);
  return { currentBlock, windowBlocks };
}

// Every activity table shows a fixed number of newest rows — no scrolling
// walls. The status chip stays accurate: "6 of 19 events" when truncated,
// plain "19 events" when everything fits.
const TABLE_CAPS = { swaps: 15, vault: 6, weights: 12, claims: 12 };
function shownOf(shown, total, noun) {
  return shown < total ? `${shown} of ${total} ${noun}` : `${total} ${noun}`;
}

// Read-only queries go through the shared read provider (config.js): the
// connected wallet's own RPC once it is verified on the right chain — that
// endpoint isn't the shared public one, so polling can't trip a per-IP rate
// limit, which is what keeps pages responsive in Brave — otherwise the
// resilient public FallbackProvider. The _walletChainOk gate prevents a
// wrong-network wallet from serving stale/zero reads.
function readProv() {
  return sharedReadProvider();
}

// ─── Live Metrics ─────────────────────────────────────────────────────────────

async function loadLiveMetrics() {
  const prov = readProv();

  try {
    const pair    = new ethers.Contract(ADDRESSES.TimbsEthPair, PAIR_ABI, prov);
    const timbs   = new ethers.Contract(ADDRESSES.TIMBSToken, TIMBS_ABI, prov);
    const staking = new ethers.Contract(ADDRESSES.TimbStaking, STAKING_ABI, prov);
    const farm    = new ethers.Contract(ADDRESSES.TimbFarm, FARM_ABI, prov);
    const prize   = new ethers.Contract(ADDRESSES.TimbPrize, PRIZE_ABI, prov);

    const registry = new ethers.Contract(ADDRESSES.GameRegistry, REGISTRY_ABI, prov);
    const yvault   = new ethers.Contract(ADDRESSES.TimbYieldVault, YV_ABI, prov);

    const [
      reserves, token0,
      supply, staked, lpStaked,
      round, segment, pot, counter, escrowBal
    ] = await Promise.all([
      pair.getReserves(),
      pair.token0(),
      timbs.totalSupply(),
      staking.totalStaked(),
      farm.totalStaked(),
      prize.currentRound(),
      prize.currentSegment(),
      prize.currentAccumulatedRewards(),
      prize.positionCounter(),
      // Physical ETH held by PrizeEscrow — the pot's backing. Only the
      // accounted pot (currentAccumulatedRewards) is winnable; the escrow
      // can hold more (e.g. a direct seed), so we surface it for context.
      prov.getBalance(ADDRESSES.PrizeEscrow).catch(() => null)
    ]);

    // Active entries vs earning capital — deliberately two numbers. A
    // replaced ticket's escrow keeps its vault weight through its last
    // eligible round while the pending replacement isn't counted until
    // activation, so tickets and ETH-equivalent weight can diverge.
    const [entrants, earningWeight, accrued] = await Promise.all([
      registry.getRoundEntrants(round).catch(() => []),
      yvault.totalWeight().catch(() => null),
      yvault.previewAccrued().catch(() => null)
    ]);

    // Sort reserves by token direction
    const timbsIsToken0 = token0.toLowerCase() === ADDRESSES.TIMBSToken.toLowerCase();
    const timbsReserve  = timbsIsToken0 ? reserves.reserve0 : reserves.reserve1;
    const wethReserve   = timbsIsToken0 ? reserves.reserve1 : reserves.reserve0;

    // Price: ETH per TIMBS (how much ETH 1 TIMBS costs)
    const timbsFloat = parseFloat(ethers.utils.formatUnits(timbsReserve, 18));
    const wethFloat  = parseFloat(ethers.utils.formatUnits(wethReserve, 18));
    const priceETH   = timbsFloat > 0 ? (wethFloat / timbsFloat).toFixed(8) : "—";

    // USD anchor: the USDC/WETH pool prices ETH in dollars, and every
    // native pair derives its USD value through it (TIMBS→ETH→USD).
    // No pool yet (or empty) → USD readouts simply don't render.
    let usdPerEth = null;
    try {
      const factory  = new ethers.Contract(ADDRESSES.TimbSwapFactory, FACTORY_MIN_ABI, prov);
      const usdcPair = await factory.getPairAddress(ADDRESSES.USDC, ADDRESSES.WETH);
      if (usdcPair !== ethers.constants.AddressZero) {
        const pc = new ethers.Contract(usdcPair, PAIR_ABI, prov);
        const [ur, ut0] = await Promise.all([pc.getReserves(), pc.token0()]);
        const usdcIs0 = ut0.toLowerCase() === ADDRESSES.USDC.toLowerCase();
        const usdc = parseFloat(ethers.utils.formatUnits(usdcIs0 ? ur.reserve0 : ur.reserve1, 6));
        const weth = parseFloat(ethers.utils.formatUnits(usdcIs0 ? ur.reserve1 : ur.reserve0, 18));
        if (usdc > 0 && weth > 0) usdPerEth = usdc / weth;
      }
    } catch {}
    const usd = (eth) => {
      if (usdPerEth === null) return null;
      const v = eth * usdPerEth;
      if (v === 0) return "0";
      // Sub-cent values (a single TIMBS) keep two significant digits
      // instead of rounding to $0.
      if (v < 0.01) return v.toPrecision(2);
      return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
    };

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

    set("m-price",        priceETH + " ETH");
    const priceUsd = priceETH !== "—" ? usd(parseFloat(priceETH)) : null;
    set("m-price-sub",    priceUsd ? `per TIMBS · ≈ $${priceUsd}` : "per TIMBS");
    set("m-timbs-reserve", fmt(timbsReserve, 18, 0) + " TIMBS");
    set("m-weth-reserve",  fmt(wethReserve, 18, 4)  + " WETH");
    // Pot to 5 decimals max (trailing zeros trimmed).
    set("m-pot", Number(ethers.utils.formatUnits(pot, 18))
      .toLocaleString("en-US", { maximumFractionDigits: 5 }) + " ETH");
    const potUsd = usd(parseFloat(ethers.utils.formatUnits(pot, 18)));
    // Sub-line: USD value + the live vault yield accruing into the pot.
    const accruedStr = accrued ? fmt(accrued, 18, 6) + " ETH" : "—";
    set("m-pot-sub",  (potUsd ? `≈ $${potUsd} · ` : "") + `yield ${accruedStr}`);

    // Escrow Backing card — physical ETH securing the pot, with when it was
    // last topped up (latest PrizeEscrow Deposited event) and by how much.
    set("m-escrow", escrowBal
      ? Number(ethers.utils.formatUnits(escrowBal, 18)).toLocaleString("en-US", { maximumFractionDigits: 5 }) + " ETH"
      : "—");
    try {
      const escrow = new ethers.Contract(ADDRESSES.PrizeEscrow, ESCROW_ABI, prov);
      const { currentBlock, windowBlocks } = await scanRange(prov);
      const bps = await blocksPerSecond(prov);
      const deps = await queryFilterWindow(escrow, escrow.filters.Deposited(), currentBlock, windowBlocks);
      if (deps.length) {
        const last = deps.reduce((a, b) => (b.blockNumber > a.blockNumber ? b : a));
        set("m-escrow-sub", `last funded ${blockAge(last.blockNumber, currentBlock, bps)} · +${fmt(last.args.amount, 18, 5)} ETH`);
      } else {
        set("m-escrow-sub", "no deposits in 7d");
      }
    } catch { set("m-escrow-sub", "last funded —"); }

    set("m-scroll",       counter.toString());
    set("m-staked",       fmt(staked, 18, 0) + " TIMBS");
    set("m-lp-staked",    fmt(lpStaked, 18, 4) + " LP");
    set("m-supply",       fmt(supply, 18, 0) + " TIMBS");
    // "Active Entries" = wallets with a genuinely VALID ticket this round.
    // getRoundEntrants is append-only and round-scoped, but can still list a
    // wallet whose ticket for the round is conceded/cancelled — so filter each
    // through the contract's verifyEntryValid (the same check settlement uses).
    let activeCount = entrants.length;
    try {
      const valid = await Promise.all(entrants.map(a =>
        registry.verifyEntryValid(a, round).then(r => !!(r.valid ?? r[0])).catch(() => true)
      ));
      activeCount = valid.filter(Boolean).length;
    } catch {}
    set("m-entries",      `${activeCount} ticket${activeCount === 1 ? "" : "s"}`);
    // Yield-farming = the vault's live registrations (ETH-eq weight), the
    // authoritative measure — NOT the round-entrant count. A conceded ticket
    // stops yielding (its vault registration is removed), but its principal
    // carries onto the replacement and keeps farming there, so there's always
    // exactly one yielding principal per wallet.
    if (earningWeight) set("m-entries-sub", `${fmt(earningWeight, 18, 4)} ETH-eq yield farming`);

    DebugHub.logCheckpoint("Analytics:Metrics Loaded", "pass");
  } catch (e) {
    console.warn("loadLiveMetrics:", e.message);
    DebugHub.logError("loadLiveMetrics", e);
  }
}

// ─── Round History ────────────────────────────────────────────────────────────

function bytes6ToStr(b6) {
  if (!b6 || b6 === "0x000000000000") return "—";
  const hex = b6.replace("0x", "");
  let s = "";
  for (let i = 0; i < 6; i++) {
    const code = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (code > 0) s += String.fromCharCode(code);
  }
  return s;
}

// Round history is paginated: max 12 rows per page, extras behind Prev/Next.
const ROUNDS_PER_PAGE = 12;
const ROUNDS_LOOKBACK = 60; // how far back to pull (5 pages) — bounds RPC load
let _allRounds = [];        // settled rounds, newest first: [{ r, res }]
let _roundPage = 0;

async function loadRoundHistory() {
  const tbody    = document.getElementById("rounds-tbody");
  const statusEl = document.getElementById("rounds-status");
  const prize    = new ethers.Contract(ADDRESSES.TimbPrize, PRIZE_ABI, readProv());

  try {
    const currentRound = (await prize.currentRound()).toNumber();
    if (currentRound <= 1) {
      _allRounds = [];
      tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No completed rounds yet</td></tr>';
      statusEl.textContent = "No rounds settled";
      renderRoundsPager();
      return;
    }

    // Fetch the lookback window concurrently; keep only settled rounds.
    const ids = [];
    for (let r = currentRound - 1; r >= Math.max(1, currentRound - ROUNDS_LOOKBACK); r--) ids.push(r);
    const results = await Promise.all(ids.map(r =>
      prize.getRoundResult(r).then(res => ({ r, res })).catch(() => null)
    ));
    const settled = results.filter(x => x && x.res.winningString !== "0x000000000000");

    // Entries at end of round = getRoundEntrants(r).length (== the contract's
    // RoundSettled.totalEntries; the array isn't pruned after settlement).
    const registry = new ethers.Contract(ADDRESSES.GameRegistry, REGISTRY_ABI, readProv());
    await Promise.all(settled.map(async (x) => {
      x.entries = (await registry.getRoundEntrants(x.r).catch(() => [])).length;
    }));

    // Per-round yield swept into that round's pot at settlement. The pot amount
    // already includes it; YieldHarvested breaks out how much came from vault
    // yield. Windowed like the vault table — rounds older than the scan window
    // show "—" rather than a wrong zero.
    try {
      const { currentBlock, windowBlocks } = await scanRange(readProv());
      const yh = await queryFilterWindow(prize, prize.filters.YieldHarvested(), currentBlock, windowBlocks);
      const yieldByRound = new Map();
      yh.forEach(ev => yieldByRound.set(ev.args.round.toNumber(), ev.args.amount));
      settled.forEach(x => { x.yieldAmt = yieldByRound.has(x.r) ? yieldByRound.get(x.r) : null; });
    } catch { /* leave yieldAmt undefined → renders as — */ }

    // Non-destructive: if a refresh came back empty but we already have rows,
    // keep the last good page rather than blanking the table.
    if (settled.length === 0) {
      if (_allRounds.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No completed rounds yet</td></tr>';
        statusEl.textContent = "No rounds settled";
      }
      return;
    }

    _allRounds = settled;
    renderRoundsPage();
    DebugHub.logCheckpoint("Analytics:Rounds Loaded", "pass");
  } catch (e) {
    if (_allRounds.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="table-empty">Could not load round history</td></tr>';
      statusEl.textContent = "Error";
    }
    DebugHub.logError("loadRoundHistory", e);
  }
}

function renderRoundsPage() {
  const tbody    = document.getElementById("rounds-tbody");
  const statusEl = document.getElementById("rounds-status");
  const total    = _allRounds.length;
  const pages    = Math.max(1, Math.ceil(total / ROUNDS_PER_PAGE));
  _roundPage     = Math.min(Math.max(0, _roundPage), pages - 1);

  const rows = _allRounds.slice(_roundPage * ROUNDS_PER_PAGE, (_roundPage + 1) * ROUNDS_PER_PAGE);
  tbody.innerHTML = rows.map(({ r, res, entries, yieldAmt }) => `
    <tr>
      <td>#${r}</td>
      <td class="td-string${res.winners.length > 0 ? " gold" : ""}">${bytes6ToStr(res.winningString)}</td>
      <td>${fmt(res.potAmount, 18, 4)} ETH</td>
      <td class="${yieldAmt != null && !yieldAmt.isZero() ? "td-in" : ""}">${yieldAmt != null ? "+" + fmt(yieldAmt, 18, 6) + " ETH" : "—"}</td>
      <td>${res.winners.length}</td>
      <td>${fmt(res.remainder, 18, 4)} ETH</td>
      <td>${entries ?? "—"}</td>
    </tr>`).join("");

  if (statusEl) statusEl.textContent = `${total} round${total === 1 ? "" : "s"}`;
  renderRoundsPager();
}

function renderRoundsPager() {
  const pager = document.getElementById("rounds-pager");
  if (!pager) return;
  const pages = Math.max(1, Math.ceil(_allRounds.length / ROUNDS_PER_PAGE));
  pager.classList.toggle("hidden", pages <= 1);
  const label = document.getElementById("rounds-page-label");
  const prev  = document.getElementById("rounds-prev");
  const next  = document.getElementById("rounds-next");
  if (label) label.textContent = `Page ${_roundPage + 1} / ${pages}`;
  if (prev)  prev.disabled = _roundPage === 0;
  if (next)  next.disabled = _roundPage >= pages - 1;
}

function roundsPrevPage() { if (_roundPage > 0) { _roundPage--; renderRoundsPage(); } }
function roundsNextPage() { _roundPage++; renderRoundsPage(); } // renderRoundsPage clamps

// ─── Recent Swaps ─────────────────────────────────────────────────────────────

async function loadRecentSwaps() {
  const tbody    = document.getElementById("swaps-tbody");
  const statusEl = document.getElementById("swaps-status");
  const prov     = readProv();

  try {
    const pair       = new ethers.Contract(ADDRESSES.TimbsEthPair, PAIR_ABI, prov);
    const token0Addr = await pair.token0();
    const timbsIs0   = token0Addr.toLowerCase() === ADDRESSES.TIMBSToken.toLowerCase();

    const { currentBlock, windowBlocks } = await scanRange(prov);
    const bps = await blocksPerSecond(prov); // cached; for "time ago" labels
    const px  = await ethUsdPrice(prov);     // ETH→USD for the value column
    const events = await queryFilterWindow(pair, pair.filters.Swap(), currentBlock, windowBlocks);
    const recent  = events.slice(-TABLE_CAPS.swaps).reverse();

    if (recent.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No swaps in the last 7 days</td></tr>';
      statusEl.textContent = "0 swaps";
      return;
    }

    // Resolve the real trader (tx initiator) for each row — the event's own
    // `sender` is the router. Cached, so refreshes don't re-fetch.
    const froms = await Promise.all(recent.map(ev => txFrom(ev.transactionHash)));

    tbody.innerHTML = "";
    for (let i = 0; i < recent.length; i++) {
      const ev = recent[i];
      const { amount0In, amount1In, amount0Out, amount1Out, sender } = ev.args;
      const trader = froms[i] || sender; // tx.from, else fall back to event sender

      // Determine direction
      const buyingTIMBS = timbsIs0 ? amount0Out.gt(0) : amount1Out.gt(0);
      const amtIn  = timbsIs0
        ? (amount1In.gt(0)  ? fmt(amount1In, 18, 4)  + " WETH"  : fmt(amount0In, 18, 2)  + " TIMBS")
        : (amount0In.gt(0)  ? fmt(amount0In, 18, 4)  + " WETH"  : fmt(amount1In, 18, 2)  + " TIMBS");
      const amtOut = timbsIs0
        ? (amount0Out.gt(0) ? fmt(amount0Out, 18, 2) + " TIMBS" : fmt(amount1Out, 18, 4) + " WETH")
        : (amount1Out.gt(0) ? fmt(amount1Out, 18, 2) + " TIMBS" : fmt(amount0Out, 18, 4) + " WETH");
      const direction = buyingTIMBS ? "Buy TIMBS" : "Sell TIMBS";

      // Value = the WETH leg (always one side of this pair) priced in USD.
      const wethWei = timbsIs0
        ? (amount1In.gt(0) ? amount1In : amount1Out)
        : (amount0In.gt(0) ? amount0In : amount0Out);
      const usdVal = px !== null ? parseFloat(ethers.utils.formatUnits(wethWei, 18)) * px : null;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${ev.blockNumber}<div class="td-age">${blockAge(ev.blockNumber, currentBlock, bps)}</div></td>
        <td class="td-addr" onclick="window.open('https://arbiscan.io/address/${trader}','_blank')">${fmtAddr(trader)}</td>
        <td class="${buyingTIMBS ? 'td-in' : 'td-out'}">${direction}</td>
        <td>${amtIn}</td>
        <td>${amtOut}</td>
        <td>${fmtUsd2(usdVal)}</td>
      `;
      tbody.appendChild(tr);
    }

    statusEl.textContent = shownOf(recent.length, events.length, "swaps");
    DebugHub.logCheckpoint("Analytics:Swaps Loaded", "pass");
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Could not load swap history</td></tr>';
    statusEl.textContent = "Error";
    DebugHub.logError("loadRecentSwaps", e);
  }
}

// ─── Claims History ───────────────────────────────────────────────────────────

async function loadClaims() {
  const tbody    = document.getElementById("claims-tbody");
  const statusEl = document.getElementById("claims-status");
  const prov     = readProv();

  try {
    const prize        = new ethers.Contract(ADDRESSES.TimbPrize, PRIZE_ABI, prov);
    const { currentBlock, windowBlocks } = await scanRange(prov);
    const events = await queryFilterWindow(prize, prize.filters.WinningsClaimed(), currentBlock, windowBlocks);
    const recent  = events.slice(-TABLE_CAPS.claims).reverse();

    if (recent.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="table-empty">No claims yet</td></tr>';
      statusEl.textContent = "No claims";
      return;
    }

    tbody.innerHTML = "";
    for (const ev of recent) {
      const { winner, round, amount } = ev.args;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>#${round}</td>
        <td class="td-addr" onclick="window.open('https://arbiscan.io/address/${winner}','_blank')">${fmtAddr(winner)}</td>
        <td class="td-in">${fmt(amount, 18, 4)} ETH</td>
      `;
      tbody.appendChild(tr);
    }

    statusEl.textContent = shownOf(recent.length, events.length, "claims");
    DebugHub.logCheckpoint("Analytics:Claims Loaded", "pass");
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="3" class="table-empty">Could not load claims</td></tr>';
    statusEl.textContent = "Error";
    DebugHub.logError("loadClaims", e);
  }
}

// ─── Yield Vault ──────────────────────────────────────────────────────────────
// Public: yield accrued for the pot (metric card) + the money-flow events
// (Funded in, Harvested out to TimbPrize). Wallet-gated: the internals that
// aren't on the dashboard — total weight, yield rate, reserve, last accrual,
// and per-ticket weight registrations.

async function loadVault() {
  const prov  = readProv();
  const vault = new ethers.Contract(ADDRESSES.TimbYieldVault, YV_ABI, prov);
  const set   = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

  // ── Public top-line + activity table ──
  try {
    const [accrued, reserve] = await Promise.all([
      vault.previewAccrued(),
      vault.reserve()
    ]);
    set("m-yield", fmt(accrued, 18, 6) + " ETH");
    // Reserve attached, to 5 decimals max (trimmed) for an accurate read.
    const reserveStr = Number(ethers.utils.formatUnits(reserve, 18))
      .toLocaleString("en-US", { maximumFractionDigits: 5 });
    set("m-yield-sub", `reserve ${reserveStr} ETH`);
  } catch (e) {
    console.warn("loadVault metrics:", e.message);
  }

  const tbody    = document.getElementById("vault-tbody");
  const statusEl = document.getElementById("vault-status");
  try {
    const prize = new ethers.Contract(ADDRESSES.TimbPrize, PRIZE_ABI, prov);
    const { currentBlock, windowBlocks } = await scanRange(prov);
    const bps = await blocksPerSecond(prov);
    // Funded = treasury topping up the vault reserve (in). For the harvest-out
    // rows, read TimbPrize's YieldHarvested(round, amount) rather than the
    // vault's round-less Harvested — so each sweep shows which round it fed.
    const [funded, harvested] = await Promise.all([
      queryFilterWindow(vault, vault.filters.Funded(),         currentBlock, windowBlocks),
      queryFilterWindow(prize, prize.filters.YieldHarvested(), currentBlock, windowBlocks)
    ]);
    const all = [
      ...funded.map(ev => ({
        block: ev.blockNumber, type: "Funded", cls: "td-in",
        amount: ev.args.amount, who: ev.args.from
      })),
      ...harvested.map(ev => ({
        block: ev.blockNumber, type: `Yield → Pot · R${ev.args.round}`, cls: "td-out",
        amount: ev.args.amount, who: ADDRESSES.TimbPrize
      }))
    ].sort((a, b) => b.block - a.block);
    const rows = all.slice(0, TABLE_CAPS.vault);

    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="table-empty">No vault activity in the last 7 days</td></tr>';
      statusEl.textContent = "0 events";
    } else {
      tbody.innerHTML = "";
      for (const r of rows) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="${r.cls}">${r.type}</td>
          <td>${fmt(r.amount, 18, 6)} ETH</td>
          <td class="td-addr" onclick="window.open('https://arbiscan.io/address/${r.who}','_blank')">${fmtAddr(r.who)}</td>
          <td>${r.block}<div class="td-age">${blockAge(r.block, currentBlock, bps)}</div></td>
        `;
        tbody.appendChild(tr);
      }
      statusEl.textContent = shownOf(rows.length, all.length, "events");
    }
    DebugHub.logCheckpoint("Analytics:Vault Loaded", "pass");
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="4" class="table-empty">Could not load vault activity</td></tr>';
    statusEl.textContent = "Error";
    DebugHub.logError("loadVault", e);
  }

  // ── Wallet-gated internals ──
  const note   = document.getElementById("vault-gated-note");
  const detail = document.getElementById("vault-detail");
  if (!userAddress) {
    note?.classList.remove("hidden");
    detail?.classList.add("hidden");
    return;
  }
  note?.classList.add("hidden");
  detail?.classList.remove("hidden");

  try {
    const { currentBlock, windowBlocks } = await scanRange(prov);
    const bps = await blocksPerSecond(prov);
    const [weight, rate, lastTs, regs, rems] = await Promise.all([
      vault.totalWeight(),
      vault.ratePerSecond1e18(),
      vault.lastAccrual(),
      queryFilterWindow(vault, vault.filters.WeightRegistered(), currentBlock, windowBlocks),
      queryFilterWindow(vault, vault.filters.WeightRemoved(),    currentBlock, windowBlocks)
    ]);

    // Daily yield at the current weight: totalWeight × rate/sec × 86400
    const perDay = weight.mul(rate).div(ethers.constants.WeiPerEther).mul(86400);
    set("v-weight",  fmt(weight, 18, 6) + " ETH-eq");
    // 7-day net change in total weight: every WeightRegistered adds its weight,
    // every WeightRemoved subtracts it, so the sum of deltas in the window is
    // the change over the last 7 days. Green ▲ up, red ▼ down.
    let net7d = ethers.constants.Zero;
    for (const ev of regs) net7d = net7d.add(ev.args.weight);
    for (const ev of rems) net7d = net7d.sub(ev.args.weight);
    const wSub = document.getElementById("v-weight-sub");
    if (wSub) {
      if (net7d.isZero()) {
        wSub.innerHTML = "no change · 7d";
      } else {
        const up = net7d.gt(0);
        wSub.innerHTML = `<span class="${up ? "td-in" : "td-out"}">`
          + `${up ? "▲ +" : "▼ −"}${fmt(net7d.abs(), 18, 6)} ETH-eq</span> · 7d`;
      }
    }
    set("v-rate",    fmt(perDay, 18, 8) + " ETH");
    // The Vault Yield card (m-yield / m-yield-sub) — yield value + reserve — is
    // populated by loadVault's top-line read above; it replaced the Reserve card.
    const ts = lastTs.toNumber();
    set("v-accrual", ts ? new Date(ts * 1000).toLocaleTimeString() : "—");
    set("v-accrual-sub", ts ? new Date(ts * 1000).toLocaleDateString() : "on-chain touch");

    const wTbody = document.getElementById("vault-weights-tbody");
    const wAll = [
      ...regs.map(ev => ({ block: ev.blockNumber, dir: "+ Registered", cls: "td-in",
                           id: ev.args.ticketId, w: ev.args.weight, total: ev.args.totalWeight })),
      ...rems.map(ev => ({ block: ev.blockNumber, dir: "− Removed", cls: "td-out",
                           id: ev.args.ticketId, w: ev.args.weight, total: ev.args.totalWeight }))
    ].sort((a, b) => b.block - a.block);
    const wRows = wAll.slice(0, TABLE_CAPS.weights);

    if (wRows.length === 0) {
      wTbody.innerHTML = '<tr><td colspan="5" class="table-empty">No ticket weight changes in the last 7 days</td></tr>';
      set("vault-detail-status", "0 changes");
    } else {
      wTbody.innerHTML = "";
      for (const r of wRows) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>#${r.id}</td>
          <td class="${r.cls}">${r.dir}</td>
          <td>${fmt(r.w, 18, 6)}</td>
          <td>${fmt(r.total, 18, 6)}</td>
          <td>${r.block}<div class="td-age">${blockAge(r.block, currentBlock, bps)}</div></td>
        `;
        wTbody.appendChild(tr);
      }
      set("vault-detail-status", shownOf(wRows.length, wAll.length, "changes"));
    }
  } catch (e) {
    console.warn("loadVault internals:", e.message);
    set("vault-detail-status", "Error");
    DebugHub.logError("loadVault.internals", e);
  }
}

// ─── Metric filter (wallet-gated) ─────────────────────────────────────────────
// Connected wallets get a pill row that slices the live-metrics grid by
// category (data-cat on each card). Disconnecting hides the row and always
// restores the full grid, so visitors never see a partial view.

function setMetricFilter(cat) {
  document.querySelectorAll("#metric-filter .mf-btn").forEach(b =>
    b.classList.toggle("mf-active", b.dataset.cat === cat));
  document.querySelectorAll("#live-metrics-grid .metric-card").forEach(c =>
    c.classList.toggle("hidden", cat !== "all" && c.dataset.cat !== cat));
}

function updateMetricFilterGate() {
  const bar = document.getElementById("metric-filter");
  if (!bar) return;
  const connected = !!userAddress;
  bar.classList.toggle("hidden", !connected);
  // Restore the full grid before re-gating so the filter and the connect
  // gate never fight over a card's hidden state.
  const active = document.querySelector("#metric-filter .mf-active")?.dataset.cat || "all";
  setMetricFilter(connected ? active : "all");
  applyDisconnectGate();
}

// Disconnected visitors keep only the market top-line (price, pool reserves,
// circulating supply — cards marked data-public). Everything else — the
// protocol internals cards and the round/vault/swaps sections — unlocks on
// connect, replaced by a single connect prompt while disconnected.
function applyDisconnectGate() {
  const connected = !!userAddress;
  if (!connected) {
    document.querySelectorAll("#live-metrics-grid .metric-card").forEach(card => {
      if (card.dataset.public !== "1") card.classList.add("hidden");
    });
  }
  document.querySelectorAll("[data-gated]").forEach(el =>
    el.classList.toggle("hidden", !connected));
  document.getElementById("analytics-gate")?.classList.toggle("hidden", connected);
}

// ─── Wallet Connect (minimal — analytics is mostly read-only) ─────────────────

async function handleConnect() {
  const ok = await connectWallet();
  if (!ok) return;
  DebugHub.startSession(userAddress);
  document.getElementById("connect-btn").classList.add("hidden");
  document.getElementById("wallet-info").classList.remove("hidden");
  document.getElementById("network-badge").classList.remove("hidden");
  document.getElementById("wallet-addr").textContent = fmtAddr(userAddress);
  listenForAccountChanges((newAddr) => {
    if (!newAddr) { handleDisconnect(); return; }
    document.getElementById("wallet-addr").textContent = fmtAddr(newAddr);
  });
  loadVault(); // unlock the gated internals
  updateMetricFilterGate();
}

function handleDisconnect() {
  DebugHub.endSession();
  disconnectWallet();
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
  loadVault(); // re-gate the internals
  updateMetricFilterGate();
}

// ─── Collapsible tables ────────────────────────────────────────────────────────

// Click a table card's header to fold/unfold its table. State persists per
// title in localStorage. Works for the nested Vault Internals header too (its
// table-wrap follows a metrics grid, so we scan forward for it).
function setupCollapsibleTables() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("timbswap_analytics_collapsed") || "{}"); } catch (e) {}

  document.querySelectorAll(".data-card-header").forEach(header => {
    let wrap = header.nextElementSibling;
    while (wrap && !wrap.classList.contains("table-wrap")) wrap = wrap.nextElementSibling;
    if (!wrap) return; // header with no table below it — skip

    const titleEl = header.querySelector(".data-card-title");
    const key = (titleEl ? titleEl.textContent : "").trim();
    if (titleEl && !titleEl.querySelector(".card-caret")) {
      const caret = document.createElement("span");
      caret.className = "card-caret";
      caret.textContent = "▾";
      titleEl.insertBefore(caret, titleEl.firstChild);
    }
    header.classList.add("collapsible");

    const apply = (collapsed) => {
      header.classList.toggle("collapsed", collapsed);
      wrap.classList.toggle("collapsed", collapsed);
    };
    if (saved[key]) apply(true);

    header.addEventListener("click", () => {
      const collapsed = !wrap.classList.contains("collapsed");
      apply(collapsed);
      saved[key] = collapsed;
      try { localStorage.setItem("timbswap_analytics_collapsed", JSON.stringify(saved)); } catch (e) {}
    });
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
    DebugHub.logCheckpoint("Analytics:Page Loaded", "pass");
  setupCollapsibleTables();
  const _reconnected = await autoReconnect();
  if (_reconnected) {
    document.getElementById("connect-btn")?.classList.add("hidden");
    document.getElementById("wallet-info")?.classList.remove("hidden");
    document.getElementById("network-badge")?.classList.remove("hidden");
    const _el = document.getElementById("wallet-addr");
    if (_el) _el.textContent = fmtAddr(_reconnected);
    DebugHub.startSession(_reconnected);
    updateMetricFilterGate();
  }

  // Apply the connect gate for the current state (reconnect branch already
  // ran it; this covers the plain disconnected load).
  updateMetricFilterGate();

  await Promise.all([
    loadLiveMetrics(),
    loadRoundHistory(),
    loadRecentSwaps(),
    loadClaims(),
    loadVault()
  ]);

  // Refresh live metrics every 15s, events every 60s — but only while the tab
  // is visible; catch up on return so a backgrounded dashboard costs nothing.
  const whenVisible = (fn) => () => { if (!document.hidden) fn(); };
  const loadEvents = () => { loadRecentSwaps(); loadClaims(); loadVault(); };
  setInterval(whenVisible(loadLiveMetrics), 15000);
  setInterval(whenVisible(loadEvents), 60000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { loadLiveMetrics(); loadEvents(); }
  });
})();
