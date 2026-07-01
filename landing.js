// landing.js — chain reads for landing page stats + live scroll display

const TIMBPRIZE_ABI   = [
  "function getRoundState() external view returns (uint256 round, uint256 segment, uint256 segmentStart, uint256 counter, bytes6 currentWindow, uint256 pot, uint256 unclaimedPool, bool inSettlement)",
  "function gameStarted() external view returns (bool)"
];
const TIMBS_ABI       = ["function totalSupply() external view returns (uint256)"];
const STAKING_ABI     = ["function totalStaked() external view returns (uint256)"];
const FARM_ABI        = ["function totalStaked() external view returns (uint256)"];
const LOCKVAULT_ABI   = ["function totalLocks() external view returns (uint256)"];
const ESCROW_ABI      = ["function balance() external view returns (uint256)"];

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// ─── Read-only provider (no wallet needed for stats) ─────────────────────────

const readProvider = new ethers.providers.JsonRpcProvider(RPC_URL);

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

function renderTimer(segmentStart, inSettlement) {
  const elapsed  = Math.floor(Date.now() / 1000) - Number(segmentStart);
  const INTERACT = 59 * 60 + 45; // 59:45
  const el = document.getElementById("scroll-timer");
  if (!el) return;

  if (inSettlement) {
    el.textContent = "SETTLING";
    el.style.color = "var(--blue)";
    return;
  }

  const remaining = Math.max(0, INTERACT - elapsed);
  const m = Math.floor(remaining / 60).toString().padStart(2, "0");
  const s = (remaining % 60).toString().padStart(2, "0");
  el.textContent = `${m}:${s}`;
  el.style.color = remaining < 60 ? "var(--green)" : "var(--text-3)";
}

let lastCounter = null;
let lastSegment = null;

async function updateScroll() {
  try {
    const prize = readContract("TimbPrize", TIMBPRIZE_ABI);
    const started = await prize.gameStarted();
    if (!started) return;

    const state = await prize.getRoundState();
    const { round, segment, segmentStart, counter, currentWindow, pot, inSettlement } = state;

    // Flash chars on counter change
    if (lastCounter !== null && counter.toString() !== lastCounter) {
      document.querySelectorAll(".scroll-char").forEach(el => {
        el.style.borderColor = "var(--green)";
        setTimeout(() => el.style.borderColor = "", 400);
      });
    }
    lastCounter = counter.toString();

    renderWindow(currentWindow);

    const roundEl = document.getElementById("scroll-round");
    const segEl   = document.getElementById("scroll-seg");
    const potEl   = document.getElementById("scroll-pot");

    if (roundEl) roundEl.textContent = `Round ${round}`;
    if (segEl)   segEl.textContent   = `Seg ${segment}/6`;
    if (potEl)   potEl.textContent   = `Prize Pot: ${fmt(pot)} ETH`;

    renderTimer(segmentStart, inSettlement);

    // Also update stats bar pot
    const statPot = document.getElementById("stat-pot");
    if (statPot) statPot.textContent = fmt(pot) + " ETH";

  } catch (e) {
    console.warn("updateScroll:", e.message);
  }
}

// ─── Stats bar ───────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const [supply, staked, lpStaked, locks] = await Promise.all([
      readContract("TIMBSToken", TIMBS_ABI).totalSupply(),
      readContract("TimbStaking", STAKING_ABI).totalStaked(),
      readContract("TimbFarm", FARM_ABI).totalStaked(),
      readContract("TimbLockVault", LOCKVAULT_ABI).totalLocks(),
    ]);

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set("stat-supply", fmtTIMBS(supply, 0));
    set("stat-staked", fmtTIMBS(staked, 2));
    set("stat-lp",     fmt(lpStaked, 18, 4) + " LP");
    set("stat-locks",  locks.toString());
  } catch (e) {
    console.warn("loadStats:", e.message);
  }
}

// ─── Wallet connect ──────────────────────────────────────────────────────────

async function handleConnect() {
  DebugHub.logCheckpoint("Wallet Connect Requested", "pass");
  const ok = await connectWallet();
  if (!ok) {
    DebugHub.logCheckpoint("Wallet Connect Failed", "fail");
    return;
  }

  DebugHub.startSession();
  DebugHub.logSecurity("Chain Check", "pass");
  DebugHub.logCheckpoint("Wallet Connected", "pass");

  document.getElementById("connect-btn").classList.add("hidden");
  document.getElementById("wallet-info").classList.remove("hidden");
  document.getElementById("network-badge").classList.remove("hidden");
  document.getElementById("wallet-addr").textContent = fmtAddr(userAddress);

  listenForAccountChanges((newAddr) => {
    if (!newAddr) {
      handleDisconnect();
    } else {
      document.getElementById("wallet-addr").textContent = fmtAddr(newAddr);
      DebugHub.endSession();
      DebugHub.startSession();
    }
  });
}

function handleDisconnect() {
  DebugHub.endSession();
  provider    = null;
  signer      = null;
  userAddress = null;
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  // Auto-reconnect if wallet was connected before navigation
  const _reconnected = await autoReconnect();
  if (_reconnected) {
    document.getElementById("connect-btn")?.classList.add("hidden");
    document.getElementById("wallet-info")?.classList.remove("hidden");
    document.getElementById("network-badge")?.classList.remove("hidden");
    const _addrEl = document.getElementById("wallet-addr");
    if (_addrEl) _addrEl.textContent = fmtAddr(_reconnected);
    DebugHub.startSession();
    DebugHub.logCheckpoint("Wallet Auto-Reconnected", "pass");
    listenForAccountChanges(async (newAddr) => {
      if (!newAddr) { handleDisconnect(); return; }
      const _el = document.getElementById("wallet-addr");
      if (_el) _el.textContent = fmtAddr(newAddr);
    });
  }

  // Load static stats once
  await loadStats();

  // Start scroll polling immediately — no wallet needed
  await updateScroll();
  setInterval(updateScroll, 3000);  // poll every 3s
  setInterval(() => {               // update timer every second
    const segEl = document.getElementById("scroll-timer");
    if (segEl && segEl.textContent !== "SETTLING") {
      // lightweight timer tick — full state refresh on next 3s poll
      const [m, s] = segEl.textContent.split(":").map(Number);
      if (!isNaN(m) && !isNaN(s)) {
        const total = m * 60 + s;
        if (total > 0) {
          const nm = Math.floor((total - 1) / 60).toString().padStart(2, "0");
          const ns = ((total - 1) % 60).toString().padStart(2, "0");
          segEl.textContent = `${nm}:${ns}`;
          segEl.style.color = (total - 1) < 60 ? "var(--green)" : "var(--text-3)";
        }
      }
    }
  }, 1000);
})();
