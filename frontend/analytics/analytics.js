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
  "event WinningsClaimed(address indexed winner, uint256 indexed round, uint256 amount)"
];

const TIMBS_ABI  = ["function totalSupply() external view returns (uint256)"];
const STAKING_ABI = ["function totalStaked() external view returns (uint256)"];
const FARM_ABI    = ["function totalStaked() external view returns (uint256)"];
const VAULT_ABI   = ["function totalLocks() external view returns (uint256)"];

const BLOCK_RANGE = 50000; // ~7 days on Arb Sepolia

function readProv() {
  return provider || new ethers.providers.JsonRpcProvider(RPC_URL);
}

// ─── Live Metrics ─────────────────────────────────────────────────────────────

async function loadLiveMetrics() {
  const prov = readProv();

  try {
    const pair    = new ethers.Contract(ADDRESSES.TimbsEthPair, PAIR_ABI, prov);
    const timbs   = new ethers.Contract(ADDRESSES.TIMBSToken, TIMBS_ABI, prov);
    const staking = new ethers.Contract(ADDRESSES.TimbStaking, STAKING_ABI, prov);
    const farm    = new ethers.Contract(ADDRESSES.TimbFarm, FARM_ABI, prov);
    const vault   = new ethers.Contract(ADDRESSES.TimbLockVault, VAULT_ABI, prov);
    const prize   = new ethers.Contract(ADDRESSES.TimbPrize, PRIZE_ABI, prov);

    const [
      reserves, token0,
      supply, staked, lpStaked, locks,
      round, segment, pot, counter
    ] = await Promise.all([
      pair.getReserves(),
      pair.token0(),
      timbs.totalSupply(),
      staking.totalStaked(),
      farm.totalStaked(),
      vault.totalLocks(),
      prize.currentRound(),
      prize.currentSegment(),
      prize.currentAccumulatedRewards(),
      prize.positionCounter()
    ]);

    // Sort reserves by token direction
    const timbsIsToken0 = token0.toLowerCase() === ADDRESSES.TIMBSToken.toLowerCase();
    const timbsReserve  = timbsIsToken0 ? reserves.reserve0 : reserves.reserve1;
    const wethReserve   = timbsIsToken0 ? reserves.reserve1 : reserves.reserve0;

    // Price: ETH per TIMBS (how much ETH 1 TIMBS costs)
    const timbsFloat = parseFloat(ethers.utils.formatUnits(timbsReserve, 18));
    const wethFloat  = parseFloat(ethers.utils.formatUnits(wethReserve, 18));
    const priceETH   = timbsFloat > 0 ? (wethFloat / timbsFloat).toFixed(8) : "—";

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

    set("m-price",        priceETH + " ETH");
    set("m-price-sub",    "per TIMBS");
    set("m-timbs-reserve", fmt(timbsReserve, 18, 0) + " TIMBS");
    set("m-weth-reserve",  fmt(wethReserve, 18, 4)  + " WETH");
    set("m-pot",          fmt(pot, 18, 4) + " ETH");
    set("m-pot-sub",      `Round ${round} · Seg ${segment}/6`);
    set("m-scroll",       counter.toString());
    set("m-staked",       fmt(staked, 18, 0) + " TIMBS");
    set("m-lp-staked",    fmt(lpStaked, 18, 4) + " LP");
    set("m-supply",       fmt(supply, 18, 0) + " TIMBS");
    set("m-locks",        locks.toString());

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

async function loadRoundHistory() {
  const tbody    = document.getElementById("rounds-tbody");
  const statusEl = document.getElementById("rounds-status");
  const prize    = new ethers.Contract(ADDRESSES.TimbPrize, PRIZE_ABI, readProv());

  try {
    const currentRound = (await prize.currentRound()).toNumber();
    if (currentRound <= 1) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No completed rounds yet</td></tr>';
      statusEl.textContent = "No rounds settled";
      return;
    }

    tbody.innerHTML = "";
    const start = Math.max(1, currentRound - 20);
    let count = 0;

    for (let r = currentRound - 1; r >= start; r--) {
      try {
        const result = await prize.getRoundResult(r);
        if (result.winningString === "0x000000000000") continue;

        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>#${r}</td>
          <td class="td-string">${bytes6ToStr(result.winningString)}</td>
          <td>${fmt(result.potAmount, 18, 4)} ETH</td>
          <td>${result.winners.length}</td>
          <td>${fmt(result.remainder, 18, 4)} ETH</td>
          <td>—</td>
        `;
        tbody.appendChild(tr);
        count++;
      } catch {}
    }

    if (count === 0) tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No completed rounds yet</td></tr>';
    statusEl.textContent = `${count} rounds`;
    DebugHub.logCheckpoint("Analytics:Rounds Loaded", "pass");
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Could not load round history</td></tr>';
    statusEl.textContent = "Error";
    DebugHub.logError("loadRoundHistory", e);
  }
}

// ─── Recent Swaps ─────────────────────────────────────────────────────────────

async function loadRecentSwaps() {
  const tbody    = document.getElementById("swaps-tbody");
  const statusEl = document.getElementById("swaps-status");
  const prov     = readProv();

  try {
    const pair       = new ethers.Contract(ADDRESSES.TimbsEthPair, PAIR_ABI, prov);
    const token0Addr = await pair.token0();
    const timbsIs0   = token0Addr.toLowerCase() === ADDRESSES.TIMBSToken.toLowerCase();

    const currentBlock = await prov.getBlockNumber();
    const fromBlock    = Math.max(0, currentBlock - BLOCK_RANGE);

    const filter = pair.filters.Swap();
    const events = await pair.queryFilter(filter, fromBlock, currentBlock);
    const recent  = events.slice(-50).reverse();

    if (recent.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No swaps in the last 50,000 blocks</td></tr>';
      statusEl.textContent = "0 swaps";
      return;
    }

    tbody.innerHTML = "";
    for (const ev of recent) {
      const { amount0In, amount1In, amount0Out, amount1Out, sender } = ev.args;

      // Determine direction
      const buyingTIMBS = timbsIs0 ? amount0Out.gt(0) : amount1Out.gt(0);
      const amtIn  = timbsIs0
        ? (amount1In.gt(0)  ? fmt(amount1In, 18, 4)  + " WETH"  : fmt(amount0In, 18, 2)  + " TIMBS")
        : (amount0In.gt(0)  ? fmt(amount0In, 18, 4)  + " WETH"  : fmt(amount1In, 18, 2)  + " TIMBS");
      const amtOut = timbsIs0
        ? (amount0Out.gt(0) ? fmt(amount0Out, 18, 2) + " TIMBS" : fmt(amount1Out, 18, 4) + " WETH")
        : (amount1Out.gt(0) ? fmt(amount1Out, 18, 2) + " TIMBS" : fmt(amount0Out, 18, 4) + " WETH");
      const direction = buyingTIMBS ? "Buy TIMBS" : "Sell TIMBS";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${ev.blockNumber}</td>
        <td class="td-addr" onclick="window.open('https://sepolia.arbiscan.io/address/${sender}','_blank')">${fmtAddr(sender)}</td>
        <td class="${buyingTIMBS ? 'td-in' : 'td-out'}">${direction}</td>
        <td>${amtIn}</td>
        <td>${amtOut}</td>
      `;
      tbody.appendChild(tr);
    }

    statusEl.textContent = `${recent.length} swaps`;
    DebugHub.logCheckpoint("Analytics:Swaps Loaded", "pass");
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty">Could not load swap history</td></tr>';
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
    const currentBlock = await prov.getBlockNumber();
    const fromBlock    = Math.max(0, currentBlock - BLOCK_RANGE);

    const filter = prize.filters.WinningsClaimed();
    const events  = await prize.queryFilter(filter, fromBlock, currentBlock);
    const recent  = events.slice(-30).reverse();

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
        <td class="td-addr" onclick="window.open('https://sepolia.arbiscan.io/address/${winner}','_blank')">${fmtAddr(winner)}</td>
        <td class="td-in">${fmt(amount, 18, 4)} ETH</td>
      `;
      tbody.appendChild(tr);
    }

    statusEl.textContent = `${recent.length} claims`;
    DebugHub.logCheckpoint("Analytics:Claims Loaded", "pass");
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="3" class="table-empty">Could not load claims</td></tr>';
    statusEl.textContent = "Error";
    DebugHub.logError("loadClaims", e);
  }
}

// ─── Wallet Connect (minimal — analytics is mostly read-only) ─────────────────

async function handleConnect() {
  const ok = await connectWallet();
  if (!ok) return;
  DebugHub.startSession();
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
  provider = null; signer = null; userAddress = null;
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  const _reconnected = await autoReconnect();
  if (_reconnected) {
    document.getElementById("connect-btn")?.classList.add("hidden");
    document.getElementById("wallet-info")?.classList.remove("hidden");
    document.getElementById("network-badge")?.classList.remove("hidden");
    const _el = document.getElementById("wallet-addr");
    if (_el) _el.textContent = fmtAddr(_reconnected);
    DebugHub.startSession();
  }

  await Promise.all([
    loadLiveMetrics(),
    loadRoundHistory(),
    loadRecentSwaps(),
    loadClaims()
  ]);

  // Refresh live metrics every 15s, events every 60s
  setInterval(loadLiveMetrics, 15000);
  setInterval(() => {
    loadRecentSwaps();
    loadClaims();
  }, 60000);
})();
