// ─── Hero headline rotator ────────────────────────────────────────────────────
// "Trade and Earn" holds 3s, "Play and Win" holds 5s (the gold one lingers).
// CSS cross-fades the swap; both lines share one grid cell so nothing shifts.
(function rotateHero() {
  const a = document.getElementById("rot-a");
  const b = document.getElementById("rot-b");
  if (!a || !b) return;
  let showA = true;
  const tick = () => {
    showA = !showA;
    a.classList.toggle("rot-on", showA);
    b.classList.toggle("rot-on", !showA);
    setTimeout(tick, showA ? 3000 : 5000);
  };
  setTimeout(tick, 3000); // first phrase holds its 3s, then the cycle runs
})();

// landing.js — chain reads for landing page stats + live scroll display

const TIMBPRIZE_ABI   = [
  "function getRoundState() external view returns (uint256 round, uint256 segment, uint256 segmentStart, uint256 counter, bytes6 currentWindow, uint256 pot, uint256 unclaimedPool, bool inSettlement)",
  "function gameStarted() external view returns (bool)"
];
const TIMBS_ABI       = ["function totalSupply() external view returns (uint256)"];
const STAKING_ABI     = ["function totalStaked() external view returns (uint256)"];
const FARM_ABI        = ["function totalStaked() external view returns (uint256)"];
const ESCROW_ABI      = ["function balance() external view returns (uint256)"];
const VAULT_ABI       = ["function previewAccrued() external view returns (uint256)"];

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// ─── Read-only provider (no wallet needed for stats) ─────────────────────────

const readProvider = makeReadProvider();

function readContract(name, abi) {
  return new ethers.Contract(ADDRESSES[name], abi, readProvider);
}

// ─── Scroll display ──────────────────────────────────────────────────────────

function renderWindow(windowBytes6) {
  try {
    const hex = windowBytes6.replace("0x", "");
    for (let i = 0; i < 6; i++) {
      const code = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      const el = document.getElementById("c" + i);
      if (el) {
        el.textContent = code > 0 ? String.fromCharCode(code) : "·";
        el.classList.toggle("dim", code === 0);
      }
    }
  } catch (e) {
    console.warn("renderWindow:", e.message);
  }
}

let maskTimer = null;
let maskIndex = 0;
function startMask() {
  if (maskTimer) return;
  // Seed every cell once so nothing reads as an empty slot while masked.
  for (let i = 0; i < 6; i++) {
    const el = document.getElementById("c" + i);
    if (!el) continue;
    el.textContent = ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    el.classList.remove("dim");
    el.classList.add("masked");
  }
  // Drift one cell at a time on a calmer cadence so the decoy string
  // re-scrambles gently rather than flickering all six positions at once.
  maskTimer = setInterval(() => {
    const el = document.getElementById("c" + maskIndex);
    if (el) {
      el.textContent = ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
      el.classList.add("masked");
    }
    maskIndex = (maskIndex + 1) % 6;
  }, 220);
}
function stopMask() {
  if (maskTimer) { clearInterval(maskTimer); maskTimer = null; }
  for (let i = 0; i < 6; i++) {
    const el = document.getElementById("c" + i);
    if (el) { el.classList.remove("masked"); el.style.opacity = ""; }
  }
}

let lastCounter = null;
let lastSegment = null;

// "Up for Grabs" shows the exact same value as the compete LIVE banner: the
// winnable pot (larger of the accounted pot and the PrizeEscrow balance) plus
// any accruing yield. It revolves between that ETH figure and its USD worth
// at a FIXED real ETH rate (config ETH_USD_PRICE) — testnet ETH has no market
// price, so a testnet pool ratio would be meaningless.
function fmtUsd(v) {
  // Always show cents at/above $1 — the pot includes accruing yield, so a
  // $300.03 pot must not read as a flat "$300" (dropping the yield the deposit
  // is earning). Sub-dollar keeps 4 dp so tiny early pots still move.
  const dp = v >= 1 ? 2 : 4;
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

let _potEth = "reading the pot…", _potUsd = null, _showUsd = false, _potRotTimer = null;

// Render the current phase on both targets. withFade animates the ETH⇄USD swap;
// a plain refresh (same phase) updates the number in place, no blink.
function renderUpForGrabs(withFade) {
  const useUsd = _showUsd && _potUsd !== null;
  const txt = useUsd ? _potUsd : _potEth;
  [document.getElementById("scroll-pot-val"), document.getElementById("stat-pot")].forEach(el => {
    if (!el) return;
    el.classList.add("pot-val");
    const apply = () => {
      el.textContent = txt;
      el.classList.toggle("val-usd", useUsd);
      el.classList.remove("fading");
    };
    if (withFade) { el.classList.add("fading"); setTimeout(apply, 350); }
    else          { apply(); }
  });
}

function setUpForGrabs(weiTotal) {
  _potEth = fmtETH(weiTotal);                                   // e.g. "0.0100 ETH"
  _potUsd = fmtUsd(parseFloat(ethers.utils.formatEther(weiTotal)) * ETH_USD_PRICE);
  renderUpForGrabs(false);                                      // reflect fresh number now
  if (!_potRotTimer) {
    _potRotTimer = setInterval(() => { _showUsd = !_showUsd; renderUpForGrabs(true); }, 4000);
  }
}

async function updateScroll() {
  try {
    const prize = readContract("TimbPrize", TIMBPRIZE_ABI);
    const started = await prize.gameStarted();
    if (!started) return;

    const state = await prize.getRoundState();
    const { round, counter, currentWindow, pot } = state;

    // Flash chars on counter change
    if (!userAddress) {
      startMask();
    } else {
      stopMask();
      if (lastCounter !== null && counter.toString() !== lastCounter) {
        document.querySelectorAll(".scroll-char").forEach(el => {
          el.style.borderColor = "var(--green)";
          setTimeout(() => el.style.borderColor = "", 400);
        });
      }
      lastCounter = counter.toString();
      renderWindow(currentWindow);
    }

    const roundEl = document.getElementById("scroll-round");
    if (roundEl) roundEl.textContent = `Round ${round}`;

    // "Up for Grabs" mirrors the compete LIVE banner: max(pot, escrow balance)
    // plus accruing yield. Each read is best-effort — falls back to the pot.
    let combined = pot;
    try {
      const [escrowBal, accrued] = await Promise.all([
        ADDRESSES.PrizeEscrow ? readProvider.getBalance(ADDRESSES.PrizeEscrow).catch(() => null) : null,
        readContract("TimbYieldVault", VAULT_ABI).previewAccrued().catch(() => null),
      ]);
      if (escrowBal && escrowBal.gt(pot)) combined = escrowBal;
      if (accrued) combined = combined.add(accrued);
    } catch (e) { /* reads unavailable → show pot only */ }

    setUpForGrabs(combined);

  } catch (e) {
    console.warn("updateScroll:", e.message);
  }
}

// ─── Stats bar ───────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const [supply, staked, lpStaked] = await Promise.all([
      readContract("TIMBSToken", TIMBS_ABI).totalSupply(),
      readContract("TimbStaking", STAKING_ABI).totalStaked(),
      readContract("TimbFarm", FARM_ABI).totalStaked(),
    ]);

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set("stat-supply", fmtTIMBS(supply, 0));
    set("stat-staked", fmtTIMBS(staked, 2));
    set("stat-lp",     fmt(lpStaked, 18, 4) + " LP");
  } catch (e) {
    console.warn("loadStats:", e.message);
  }
}

// ─── Wallet connect ──────────────────────────────────────────────────────────

// Dashboard CTAs ("Enter Your Ticket", "Make a Swap") are wallet-gated: with no
// wallet connected, clicking pops the wallet manager instead of navigating, and
// only proceeds to the destination once a connection lands. The folded hamburger
// nav is intentionally NOT gated — it's the deliberate bypass for browsing
// without connecting. When a wallet drops mid-session the app lands back on the
// dashboard, so this is the connect prompt that lets the user reconnect.
function goGated(e, dest) {
  // Already connected → let the link navigate normally.
  if (userAddress) return true;
  // Not connected → intercept, prompt the wallet, and only navigate once a
  // connection lands. The top-nav / hamburger links stay UNGATED (plain <a>), so
  // browsing without connecting is still possible and no one is stranded here —
  // a dropped/flaky wallet simply re-prompts on the next CTA click.
  e.preventDefault();
  connectThenGo(dest);
  return false;
}

// Connect first, then continue to the CTA's destination. On cancel/failure we
// stay on the dashboard (userAddress stays null) — handleConnect surfaces the
// wallet UI / error, so the click isn't silently swallowed.
async function connectThenGo(dest) {
  const ok = await handleConnect();
  if (ok) window.location.href = dest;
}

async function handleConnect() {
  DebugHub.logCheckpoint("Wallet Connect Requested", "pass");
  const ok = await connectWallet();
  if (!ok) {
    DebugHub.logCheckpoint("Wallet Connect Failed", "fail");
    return false;
  }

  DebugHub.startSession(userAddress);
  DebugHub.logSecurity("Chain Check", "pass");
  DebugHub.logCheckpoint("Wallet Connected", "pass");

  document.getElementById("connect-btn").classList.add("hidden");
  document.getElementById("wallet-info").classList.remove("hidden");
  document.getElementById("network-badge").classList.remove("hidden");
  document.getElementById("wallet-addr").textContent = fmtAddr(userAddress);
  stopMask();
  updateScroll();

  listenForAccountChanges((newAddr) => {
    if (!newAddr) {
      handleDisconnect();
    } else {
      document.getElementById("wallet-addr").textContent = fmtAddr(newAddr);
      DebugHub.endSession();
      DebugHub.startSession(newAddr);
    }
  });
  return true;
}

function handleDisconnect() {
  DebugHub.endSession();
  disconnectWallet();
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
  startMask();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  // Auto-reconnect if wallet was connected before navigation
    DebugHub.logCheckpoint("Landing:Page Loaded", "pass");
  const _reconnected = await autoReconnect();
  if (_reconnected) {
    document.getElementById("connect-btn")?.classList.add("hidden");
    document.getElementById("wallet-info")?.classList.remove("hidden");
    document.getElementById("network-badge")?.classList.remove("hidden");
    const _addrEl = document.getElementById("wallet-addr");
    if (_addrEl) _addrEl.textContent = fmtAddr(_reconnected);
    DebugHub.startSession(_reconnected);
    DebugHub.logCheckpoint("Wallet Auto-Reconnected", "pass");
    listenForAccountChanges(async (newAddr) => {
      if (!newAddr) { handleDisconnect(); return; }
      const _el = document.getElementById("wallet-addr");
      if (_el) _el.textContent = fmtAddr(newAddr);
    });
  } else {
    startMask();
  }

  // Load static stats once
  await loadStats();

  // Start scroll polling immediately — no wallet needed. Only poll while the
  // tab is VISIBLE: a backgrounded landing tab polling forever drains the shared
  // public-RPC quota, which throttles the IP and stalls reads on every page
  // ("fine at first, spoils after exploring"). Ease the cadence to 8s too — the
  // landing scroll doesn't need 3s freshness — and re-poll on tab focus.
  await updateScroll();
  setInterval(() => { if (!document.hidden) updateScroll(); }, 8000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) updateScroll(); });
})();
