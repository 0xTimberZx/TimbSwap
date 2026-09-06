// explore.js — TimbSwap exchange info: pools, TVL, trade & liquidity activity.
// Zero-infra: everything is read client-side from the canonical public RPC
// (factory pair enumeration + pair reserves + Swap/Mint/Burn event scanning
// over a bounded block window). No wallet needed — this page has no game state.

const FACTORY_ABI = [
  "function allPairsLength() external view returns (uint256)",
  "function allPairs(uint256) external view returns (address)",
  "function getPairAddress(address tokenA, address tokenB) external view returns (address)"
];

const PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function totalSupply() external view returns (uint256)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Mint(address indexed sender, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)"
];

const ERC20_META_ABI = [
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)"
];

// Activity feed lookback. Converted to a block count at runtime via
// blocksForDays (config.js) — Arb Sepolia block numbers advance ~270k/day, so
// hard-coded block windows drift badly. 24h volume is a slice of this window.
const WINDOW_DAYS = 7;
const ZERO = "0x0000000000000000000000000000000000000000";

// Read-only queries go through the shared read provider (config.js): the
// connected wallet's own RPC when verified on-chain (avoids public-RPC per-IP
// rate limits, especially in Brave), else the resilient public
// FallbackProvider — so this page works with or without a wallet.
function readProv() {
  return sharedReadProvider();
}

// Read-only contracts bound to the stable provider — cache by address.
const _roContracts = {};
function contractRO(address, abi) {
  return _roContracts[address] || (_roContracts[address] = new ethers.Contract(address, abi, readProv()));
}

// The `sender`/`to` on Swap/Mint/Burn is usually the router (or, on a multi-hop
// leg, the next pool) — not the human. The transaction initiator (tx.from) is
// always the real user. Resolve + cache it per tx hash (a tx is immutable).
const _txFrom = {};
async function txFrom(hash) {
  if (_txFrom[hash]) return _txFrom[hash];
  try {
    const tx = await readProv().getTransaction(hash);
    if (tx && tx.from) return (_txFrom[hash] = tx.from);
  } catch {}
  return null;
}

// ─── Token metadata (symbol + decimals), cached ────────────────────────────────

const _tokenMeta = {}; // lowercased address -> { symbol, decimals }
for (const t of (typeof DEFAULT_TOKENS !== "undefined" ? DEFAULT_TOKENS : [])) {
  _tokenMeta[t.address.toLowerCase()] = { symbol: t.symbol, decimals: t.decimals };
}
async function tokenMeta(addr) {
  const lc = addr.toLowerCase();
  if (_tokenMeta[lc]) return _tokenMeta[lc];
  try {
    const c = contractRO(addr, ERC20_META_ABI);
    const [symbol, decimals] = await Promise.all([
      c.symbol().catch(() => addr.slice(0, 6)),
      c.decimals().catch(() => 18)
    ]);
    return (_tokenMeta[lc] = { symbol, decimals: Number(decimals) });
  } catch {
    return (_tokenMeta[lc] = { symbol: addr.slice(0, 6) + "…", decimals: 18 });
  }
}

// ─── USD pricing (best-effort) ─────────────────────────────────────────────────
// We can price the known quote assets: WETH (via USDC/WETH), stables ($1), and
// TIMBS (via TIMBS/WETH). A constant-product pool holds equal value on both
// sides, so if we can price EITHER side we can value the whole pool. Pairs of
// two unknown tokens simply show no USD (reserves still render).

let _usdPerEth   = null;
let _usdPerTimbs = null;

async function refreshPrices() {
  const factory = contractRO(ADDRESSES.TimbSwapFactory, FACTORY_ABI);

  // USDC/WETH → USD per ETH
  try {
    const p = await factory.getPairAddress(ADDRESSES.USDC, ADDRESSES.WETH);
    if (p && p !== ZERO) {
      const pair = contractRO(p, PAIR_ABI);
      const [r, t0] = await Promise.all([pair.getReserves(), pair.token0()]);
      const usdcIs0 = t0.toLowerCase() === ADDRESSES.USDC.toLowerCase();
      const usdc = parseFloat(ethers.utils.formatUnits(usdcIs0 ? r.reserve0 : r.reserve1, 6));
      const weth = parseFloat(ethers.utils.formatUnits(usdcIs0 ? r.reserve1 : r.reserve0, 18));
      if (usdc > 0 && weth > 0) _usdPerEth = usdc / weth;
    }
  } catch {}

  // TIMBS/WETH → ETH per TIMBS → USD per TIMBS
  try {
    const p = await factory.getPairAddress(ADDRESSES.TIMBSToken, ADDRESSES.WETH);
    if (p && p !== ZERO && _usdPerEth !== null) {
      const pair = contractRO(p, PAIR_ABI);
      const [r, t0] = await Promise.all([pair.getReserves(), pair.token0()]);
      const timbsIs0 = t0.toLowerCase() === ADDRESSES.TIMBSToken.toLowerCase();
      const timbs = parseFloat(ethers.utils.formatUnits(timbsIs0 ? r.reserve0 : r.reserve1, 18));
      const weth  = parseFloat(ethers.utils.formatUnits(timbsIs0 ? r.reserve1 : r.reserve0, 18));
      if (timbs > 0 && weth > 0) _usdPerTimbs = (weth / timbs) * _usdPerEth;
    }
  } catch {}
}

// USD value of `amtFloat` of a token, or null if we can't price it.
function usdOf(addrLc, amtFloat) {
  if (addrLc === ADDRESSES.WETH.toLowerCase())  return _usdPerEth  !== null ? amtFloat * _usdPerEth  : null;
  if (addrLc === ADDRESSES.USDC.toLowerCase())  return amtFloat;                       // $1
  if (ADDRESSES.USDT && addrLc === ADDRESSES.USDT.toLowerCase()) return amtFloat;      // $1
  if (addrLc === ADDRESSES.TIMBSToken.toLowerCase()) return _usdPerTimbs !== null ? amtFloat * _usdPerTimbs : null;
  return null;
}

function fmtUsd(v) {
  if (v === null || v === undefined) return "—";
  if (v === 0) return "$0";
  if (v < 0.01) return "$" + v.toPrecision(2);
  return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
function fmtNum(x, dp = 4) {
  if (!isFinite(x)) return "0";
  return x.toLocaleString("en-US", { maximumFractionDigits: dp });
}

// ─── Pool discovery + overview ─────────────────────────────────────────────────

let _pools = [];      // [{ address, t0, t1, sym0, sym1, dec0, dec1, r0, r1, tvl }]
let _lastTrades = []; // cached rows so the search box can re-filter without refetching
let _lastLiq = [];
let _curBlock = null; // head block + calibrated block rate, for "time ago" labels
let _bps = null;
const _vol24h = {};   // pair address (lowercased) -> USD swap volume in the last ~24h
let _poolsLoaded = false;    // true once we've rendered pools at least once
let _activityLoaded = false; // true once we've rendered activity at least once
// token0/token1 (and their metadata) never change for a pair — read once and
// reuse across refreshes so each poll only re-reads reserves, not identities.
const _pairTokens = {};      // pair address -> { t0, t1, m0, m1 }

async function loadPools() {
  const statusEl = document.getElementById("pools-status");
  try {
    const factory = contractRO(ADDRESSES.TimbSwapFactory, FACTORY_ABI);
    const n = (await factory.allPairsLength()).toNumber();

    if (n === 0) {
      document.getElementById("pools-tbody").innerHTML =
        '<tr><td colspan="5" class="table-empty">No pools yet — create one on the Swap → Liquidity tab</td></tr>';
      if (statusEl) statusEl.textContent = "0 pools";
      setOverview(0, 0, null);
      return;
    }

    // Enumerate all pair addresses concurrently.
    const addrs = await Promise.all(
      Array.from({ length: n }, (_, i) => factory.allPairs(i).catch(() => null))
    );

    await refreshPrices();

    // Pool count is reliable straight from the factory — set it even if some
    // per-pair reads below fail this cycle.
    setOverview(n, null, null);

    // Load each pool's reserves concurrently. token0/token1 + metadata are
    // immutable, so read them once per pair and cache; only reserves refresh.
    const pools = await Promise.all(addrs.filter(Boolean).map(async (addr) => {
      try {
        const pair = contractRO(addr, PAIR_ABI);
        let pt = _pairTokens[addr];
        if (!pt) {
          const [t0, t1] = await Promise.all([pair.token0(), pair.token1()]);
          const [m0, m1] = await Promise.all([tokenMeta(t0), tokenMeta(t1)]);
          pt = _pairTokens[addr] = { t0, t1, m0, m1 };
        }
        const r = await pair.getReserves();
        const r0 = parseFloat(ethers.utils.formatUnits(r.reserve0, pt.m0.decimals));
        const r1 = parseFloat(ethers.utils.formatUnits(r.reserve1, pt.m1.decimals));
        // Value either side; a balanced pool's TVL is twice the priced side.
        const v0 = usdOf(pt.t0.toLowerCase(), r0);
        const v1 = usdOf(pt.t1.toLowerCase(), r1);
        let tvl = null;
        if (v0 !== null && v1 !== null) tvl = v0 + v1;
        else if (v0 !== null) tvl = v0 * 2;
        else if (v1 !== null) tvl = v1 * 2;
        return {
          address: addr, t0: pt.t0, t1: pt.t1,
          sym0: pt.m0.symbol, sym1: pt.m1.symbol, dec0: pt.m0.decimals, dec1: pt.m1.decimals,
          r0, r1, tvl
        };
      } catch { return null; }
    }));

    const fresh = pools.filter(Boolean).sort((a, b) => (b.tvl || 0) - (a.tvl || 0));

    // Non-destructive: if this cycle came back empty (transient RPC failure on
    // every pair) but there ARE pairs and we already have data, keep showing
    // the last good snapshot instead of blanking the table.
    if (fresh.length === 0 && n > 0 && _pools.length > 0) {
      if (statusEl) statusEl.textContent = `${_pools.length} pools`;
      return;
    }

    _pools = fresh;
    renderPools();
    _poolsLoaded = true;
    const totalTvl = _pools.reduce((s, p) => s + (p.tvl || 0), 0);
    setOverview(n, null, totalTvl);
    if (statusEl) statusEl.textContent = `${_pools.length} pool${_pools.length === 1 ? "" : "s"}`;
    DebugHub.logCheckpoint("Explore:Pools Loaded", "pass");
  } catch (e) {
    // Only surface an error on the very first load — never wipe a table that's
    // already showing good data because one refresh cycle hiccupped.
    if (!_poolsLoaded) {
      document.getElementById("pools-tbody").innerHTML =
        '<tr><td colspan="5" class="table-empty">Could not load pools</td></tr>';
      if (statusEl) statusEl.textContent = "Error";
    } else if (statusEl) {
      statusEl.textContent = `${_pools.length} pools`;
    }
    DebugHub.logError("loadPools", e);
  }
}

// Base/quote orientation uses the SHARED convention in config.js
// (pairQuoteRank: stables > native > others → quote shown second), so pair
// labels match the farm and analytics pages exactly. orient() also carries the
// reserves so pricing follows the same base/quote choice.
function orient(p) {
  const flip = pairQuoteRank(p.t0) > pairQuoteRank(p.t1); // t0 outranks t1 → t0 is quote
  return flip
    ? { baseSym: p.sym1, quoteSym: p.sym0, baseR: p.r1, quoteR: p.r0 }
    : { baseSym: p.sym0, quoteSym: p.sym1, baseR: p.r0, quoteR: p.r1 };
}
function pairLabel(p) { return pairLabelFor(p.t0, p.sym0, p.t1, p.sym1); }

function renderPools() {
  const tbody = document.getElementById("pools-tbody");
  const q = (document.getElementById("pool-search")?.value || "").trim().toLowerCase();
  const rows = _pools.filter(p => !q || matchesPool(p, q));

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="table-empty">${q ? "No pools match “" + q + "”" : "No pools"}</td></tr>`;
    return;
  }
  tbody.innerHTML = "";
  for (const p of rows) {
    const o = orient(p);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="td-pair">${o.baseSym}/${o.quoteSym}</td>
      <td>${fmtNum(o.baseR, 4)} ${o.baseSym} · ${fmtNum(o.quoteR, 4)} ${o.quoteSym}</td>
      <td>${fmtUsd(p.tvl)}</td>
      <td>${vol24hOf(p)}</td>
      <td class="td-addr" onclick="window.open('https://arbiscan.io/address/${p.address}','_blank')">${fmtAddr(p.address)}</td>
    `;
    tbody.appendChild(tr);
  }
}

// 24h volume comes from the activity scan (loadActivity), which runs after the
// pools first render — show "—" until it lands, then the USD figure (incl. $0).
function vol24hOf(p) {
  const v = _vol24h[p.address.toLowerCase()];
  return v === undefined ? "—" : fmtUsd(v);
}

function matchesPool(p, q) {
  return p.sym0.toLowerCase().includes(q) || p.sym1.toLowerCase().includes(q) ||
         pairLabel(p).toLowerCase().includes(q) ||
         p.address.toLowerCase() === q || p.t0.toLowerCase() === q || p.t1.toLowerCase() === q;
}

// Each metric updates only when its own value is provided this call — passing
// null leaves the last shown number in place (never blanks it to "—").
function setOverview(pools, tradesWindow, totalTvl) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  if (totalTvl !== null && totalTvl !== undefined)     set("ov-tvl", fmtUsd(totalTvl));
  if (pools !== null && pools !== undefined)           set("ov-pools", String(pools));
  if (tradesWindow !== null && tradesWindow !== undefined) set("ov-trades", String(tradesWindow));
}

// ─── Activity: recent trades (Swap) and liquidity (Mint/Burn) ───────────────────

async function loadActivity() {
  const swapStatus = document.getElementById("trades-status");
  const liqStatus  = document.getElementById("liq-status");
  try {
    const prov = readProv();
    const currentBlock = await prov.getBlockNumber();
    const blocks24h    = await blocksForDays(prov, 1);
    _curBlock = currentBlock;
    _bps = await blocksPerSecond(prov); // cached after blocksForDays above
    const windowBlocks = blocks24h * WINDOW_DAYS;

    // Make sure we know the pools (and their token metadata) first.
    if (_pools.length === 0) await loadPools();

    // Scan Swap/Mint/Burn on every pool concurrently. queryFilterWindow steps
    // the range down if the RPC balks at a full multi-day getLogs.
    const perPool = await Promise.all(_pools.map(async (p) => {
      const pair = contractRO(p.address, PAIR_ABI);
      const [swaps, mints, burns] = await Promise.all([
        queryFilterWindow(pair, pair.filters.Swap(), currentBlock, windowBlocks).catch(() => []),
        queryFilterWindow(pair, pair.filters.Mint(), currentBlock, windowBlocks).catch(() => []),
        queryFilterWindow(pair, pair.filters.Burn(), currentBlock, windowBlocks).catch(() => [])
      ]);
      return { p, swaps, mints, burns };
    }));

    // ── Recent trades ──
    const vol24hFrom = currentBlock - blocks24h;
    // Router-initiated swaps emit sender = router; the human is the `to`
    // recipient — unless `to` is another pool (the intermediate leg of a
    // multi-hop swap pays straight into the next pair).
    const poolAddrs = new Set(_pools.map(x => x.address.toLowerCase()));
    const trades = [];
    for (const { p, swaps } of perPool) {
      let vol = 0; // USD swap volume for this pool over the last ~24h
      for (const ev of swaps) {
        const { amount0In, amount1In, amount0Out, amount1Out, sender, to } = ev.args;
        const zeroToOne = amount0In.gt(0); // token0 in → token1 out
        const inSym  = zeroToOne ? p.sym0 : p.sym1;
        const outSym = zeroToOne ? p.sym1 : p.sym0;
        const inAmt  = zeroToOne ? ethers.utils.formatUnits(amount0In,  p.dec0) : ethers.utils.formatUnits(amount1In,  p.dec1);
        const outAmt = zeroToOne ? ethers.utils.formatUnits(amount1Out, p.dec1) : ethers.utils.formatUnits(amount0Out, p.dec0);
        // Value each swap by whichever side we can price (in first, then out) —
        // a constant-product trade is worth ~the same on both legs. null when
        // neither token is priceable (shows "—").
        const inAddr  = zeroToOne ? p.t0 : p.t1;
        const outAddr = zeroToOne ? p.t1 : p.t0;
        let usd = usdOf(inAddr.toLowerCase(), parseFloat(inAmt));
        if (usd === null) usd = usdOf(outAddr.toLowerCase(), parseFloat(outAmt));
        trades.push({
          block: ev.blockNumber, pair: pairLabel(p), txHash: ev.transactionHash,
          // Fallback only; overridden by the tx initiator below.
          trader: poolAddrs.has(to.toLowerCase()) ? sender : to,
          detail: `${fmtNum(parseFloat(inAmt), 4)} ${inSym} → ${fmtNum(parseFloat(outAmt), 4)} ${outSym}`,
          usd
        });
        if (usd !== null && ev.blockNumber >= vol24hFrom) vol += usd;
      }
      _vol24h[p.address.toLowerCase()] = vol;
    }
    // Volume lives on the pools table — refresh it now that we have fresh numbers.
    if (_poolsLoaded) renderPools();
    trades.sort((a, b) => b.block - a.block);
    _lastTrades = trades.slice(0, 15);
    // Show the human who sent the tx, not the router/pool from the event.
    await Promise.all(_lastTrades.map(async t => { const f = await txFrom(t.txHash); if (f) t.trader = f; }));
    renderTrades(_lastTrades);
    if (swapStatus) swapStatus.textContent = `${trades.length} trade${trades.length === 1 ? "" : "s"}`;
    setOverview(null, trades.length, null);

    // ── Recent liquidity ──
    const liq = [];
    for (const { p, mints, burns } of perPool) {
      for (const ev of mints) {
        liq.push({
          block: ev.blockNumber, type: "Add", pair: pairLabel(p), txHash: ev.transactionHash, who: ev.args.sender,
          detail: `${fmtNum(parseFloat(ethers.utils.formatUnits(ev.args.amount0, p.dec0)), 4)} ${p.sym0} + ${fmtNum(parseFloat(ethers.utils.formatUnits(ev.args.amount1, p.dec1)), 4)} ${p.sym1}`
        });
      }
      for (const ev of burns) {
        liq.push({
          block: ev.blockNumber, type: "Remove", pair: pairLabel(p), txHash: ev.transactionHash, who: ev.args.to,
          detail: `${fmtNum(parseFloat(ethers.utils.formatUnits(ev.args.amount0, p.dec0)), 4)} ${p.sym0} + ${fmtNum(parseFloat(ethers.utils.formatUnits(ev.args.amount1, p.dec1)), 4)} ${p.sym1}`
        });
      }
    }
    liq.sort((a, b) => b.block - a.block);
    _lastLiq = liq.slice(0, 15);
    // Provider = the human who sent the tx (the Mint event's sender is the router).
    await Promise.all(_lastLiq.map(async r => { const f = await txFrom(r.txHash); if (f) r.who = f; }));
    renderLiquidity(_lastLiq);
    if (liqStatus) liqStatus.textContent = `${liq.length} event${liq.length === 1 ? "" : "s"}`;

    _activityLoaded = true;
    DebugHub.logCheckpoint("Explore:Activity Loaded", "pass");
  } catch (e) {
    // Keep the last good activity rather than blanking to "Error" on a
    // transient RPC/rate-limit hiccup once we've loaded successfully.
    if (!_activityLoaded) {
      if (swapStatus) swapStatus.textContent = "Error";
      if (liqStatus) liqStatus.textContent = "Error";
    }
    DebugHub.logError("loadActivity", e);
  }
}

function renderTrades(rows) {
  const tbody = document.getElementById("trades-tbody");
  const q = (document.getElementById("pool-search")?.value || "").trim().toLowerCase();
  const filtered = rows.filter(r => !q || r.pair.toLowerCase().includes(q));
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No trades in the last 7 days</td></tr>';
    return;
  }
  tbody.innerHTML = "";
  for (const r of filtered) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.block}<div class="td-age">${blockAge(r.block, _curBlock, _bps)}</div></td>
      <td class="td-pair">${r.pair}</td>
      <td>${r.detail}</td>
      <td>${fmtUsd(r.usd)}</td>
      <td class="td-addr" onclick="window.open('https://arbiscan.io/address/${r.trader}','_blank')">${fmtAddr(r.trader)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderLiquidity(rows) {
  const tbody = document.getElementById("liq-tbody");
  const q = (document.getElementById("pool-search")?.value || "").trim().toLowerCase();
  const filtered = rows.filter(r => !q || r.pair.toLowerCase().includes(q));
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No liquidity changes in the last 7 days</td></tr>';
    return;
  }
  tbody.innerHTML = "";
  for (const r of filtered) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.block}<div class="td-age">${blockAge(r.block, _curBlock, _bps)}</div></td>
      <td class="${r.type === "Add" ? "td-in" : "td-out"}">${r.type}</td>
      <td class="td-pair">${r.pair}</td>
      <td>${r.detail}</td>
      <td class="td-addr" onclick="window.open('https://arbiscan.io/address/${r.who}','_blank')">${fmtAddr(r.who)}</td>
    `;
    tbody.appendChild(tr);
  }
}

// Re-filter every already-loaded table as the user types — pure client-side,
// no re-fetch (rows are cached in _pools / _lastTrades / _lastLiq).
function onPoolSearch() {
  renderPools();
  renderTrades(_lastTrades);
  renderLiquidity(_lastLiq);
}

// ─── Wallet (optional — nav parity only; the page has no gated content) ─────────

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
}

function handleDisconnect() {
  DebugHub.endSession();
  disconnectWallet();
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
}

// ─── Init ───────────────────────────────────────────────────────────────────────

(async () => {
  DebugHub.logCheckpoint("Explore:Page Loaded", "pass");

  // Wallet is optional here — reflect a saved connection if present, but the
  // whole page works disconnected (no game state on this surface).
  try {
    const addr = await autoReconnect();
    if (addr) {
      document.getElementById("connect-btn")?.classList.add("hidden");
      document.getElementById("wallet-info")?.classList.remove("hidden");
      document.getElementById("network-badge")?.classList.remove("hidden");
      const el = document.getElementById("wallet-addr");
      if (el) el.textContent = fmtAddr(addr);
      DebugHub.startSession(addr);
    }
  } catch {}

  await loadPools();
  await loadActivity();

  // Refresh only while the tab is visible; catch up on return.
  const whenVisible = (fn) => () => { if (!document.hidden) fn(); };
  setInterval(whenVisible(loadPools), 30000);
  setInterval(whenVisible(loadActivity), 45000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { loadPools(); loadActivity(); }
  });
})();
