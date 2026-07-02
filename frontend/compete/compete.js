// compete.js — TimbSwap Prize Game v2 (digit-locking mechanic)

const TIMBPRIZE_ABI = [
  "function getRoundState() external view returns (uint256 round, uint256 segment, uint256 segmentStart, uint256 counter, bytes6 currentWindow, uint256 pot, uint256 unclaimedPool, bool inSettlement, uint256[6] digitCounters, bool[6] digitLocked)",
  "function getRoundResult(uint256 round) external view returns (bytes6 winningString, uint256 potAmount, address[] winners, uint256 perWinner, uint256 remainder)",
  "function hasClaimed(uint256 round, address winner) external view returns (bool)",
  "function claimWinnings(uint256 round) external",
  "function gameStarted() external view returns (bool)"
];

const GAME_REGISTRY_ABI = [
  "function currentRound() external view returns (uint256)",
  "function entryCostTIMBS() external view returns (uint256)",
  "function entryCostETH() external view returns (uint256)",
  "function getPlayerRounds(address player) external view returns (uint256[])",
  "function getEntry(address player, uint256 round) external view returns (bytes6 string6, uint256 entryRound, uint256 lastEligibleRound, uint256 escrowAmount, address escrowToken, uint8 status, bool exists)",
  "function additionalRoundCost(uint256 extraRounds) external view returns (uint256)",
  "function submitEntry(bytes6 string6, bool useETH, uint256 extraRounds) external payable",
  "function claimRefund(uint256 round) external"
];

const TIMBS_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)"
];

const ELIGIBLE_REGISTRY_ABI = [
  "function getEligibleTokens() external view returns (address[])"
];

const ERC20_SYMBOL_ABI = ["function symbol() external view returns (string)"];

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const STATUS_NAMES = ["Pending", "Active", "Expired", "Claimed", "Inactive"];

// ─── State ────────────────────────────────────────────────────────────────────

let selectedToken      = { address: "native", symbol: "ETH", isNative: true };
let eligibleTokens     = [];
let extraRounds        = 0;
let entryCostETH_wei   = null;
let entryCostTIMBS_wei = null;
let currentRoundNum    = null;
let lastDigitCounters  = null;

function readProv() {
  return provider || new ethers.providers.JsonRpcProvider(RPC_URL);
}

// ─── Digit Track Display ──────────────────────────────────────────────────────

function renderDigitTrack(segment, digitCounters, digitLocked, inSettlement) {
  const isWalletConnected = !!userAddress;

  for (let i = 0; i < 6; i++) {
    const seg = i + 1;
    const cell    = document.getElementById("dc" + i);
    const charEl  = document.getElementById("dchar" + i);
    if (!cell || !charEl) continue;

    // Remove all state classes
    cell.classList.remove("locked", "active", "future", "gated");

    if (seg < segment || (seg === segment && digitLocked[i])) {
      // Locked digit — always visible
      const char = ALPHABET[Number(digitCounters[i]) % 36];
      charEl.textContent = char;
      cell.classList.add("locked");

    } else if (seg === segment) {
      // Active digit — wallet-gate the revealed character
      if (isWalletConnected) {
        const char = ALPHABET[Number(digitCounters[i]) % 36];
        charEl.textContent = char;
        cell.classList.add("active");
        if (inSettlement) {
          cell.classList.remove("active");
          cell.classList.add("locked");
        }
      } else {
        charEl.textContent = "?";
        cell.classList.add("active", "gated");
      }

    } else {
      // Future digit
      charEl.textContent = "·";
      cell.classList.add("future");
    }
  }
}

// ─── Poll Round State ─────────────────────────────────────────────────────────

async function pollRoundState() {
  try {
    const prize   = new ethers.Contract(ADDRESSES.TimbPrize, TIMBPRIZE_ABI, readProv());
    const started = await prize.gameStarted();

    if (!started) {
      document.getElementById("hdr-round").textContent   = "—";
      document.getElementById("sub-timer").textContent   = "Game not started";
      return;
    }

    const s = await prize.getRoundState();
    currentRoundNum = s.round.toNumber();

    document.getElementById("hdr-round").textContent   = "#" + s.round.toString();
    document.getElementById("hdr-segment").textContent = `${s.segment}/6`;
    document.getElementById("sub-pot").textContent     = "Pot: " + fmt(s.pot) + " ETH";

    const timerEl = document.getElementById("sub-timer");
    if (s.inSettlement) {
      timerEl.textContent = "Settling segment…";
    } else {
      const elapsed    = Math.floor(Date.now() / 1000) - s.segmentStart.toNumber();
      const remaining  = Math.max(0, (59 * 60 + 45) - elapsed);
      const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
      const ss = String(remaining % 60).padStart(2, "0");
      timerEl.textContent = `${mm}:${ss} left in segment`;
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
      s.inSettlement
    );

    // Show/hide gated notice
    const notice = document.getElementById("gated-notice");
    if (notice) notice.classList.toggle("hidden", !!userAddress);

  } catch (e) {
    console.warn("pollRoundState:", e.message);
    DebugHub.logError("pollRoundState", e);
  }
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

  const noteEl = document.getElementById("extra-cost-note");
  if (extraRounds > 0 && noteEl) {
    try {
      const registry = new ethers.Contract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI, readProv());
      const extra = await registry.additionalRoundCost(extraRounds);
      noteEl.textContent = `+ ${fmtTIMBS(extra)} TIMBS · non-refundable`;
      noteEl.classList.remove("hidden");
    } catch { noteEl.classList.add("hidden"); }
  } else if (noteEl) {
    noteEl.classList.add("hidden");
  }
}

// ─── Token Dropdown ───────────────────────────────────────────────────────────

async function buildTokenDropdown() {
  try {
    const registry = new ethers.Contract(ADDRESSES.EligibleTokenRegistry, ELIGIBLE_REGISTRY_ABI, readProv());
    const addrs    = await registry.getEligibleTokens();

    eligibleTokens = [{ address: "native", symbol: "ETH", isNative: true }];

    for (const addr of addrs) {
      if (addr.toLowerCase() === ADDRESSES.WETH.toLowerCase()) continue;
      if (addr.toLowerCase() === ADDRESSES.DAPP.toLowerCase()) continue;
      try {
        const erc    = new ethers.Contract(addr, ERC20_SYMBOL_ABI, readProv());
        const symbol = await erc.symbol();
        eligibleTokens.push({ address: addr, symbol, isNative: false });
      } catch {}
    }
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

function adjustExtraRounds(delta) {
  extraRounds = Math.max(0, extraRounds + delta);
  document.getElementById("extra-rounds-val").textContent = extraRounds;
  updateCostDisplay();
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

function updateEntryButton() {
  const btn = document.getElementById("entry-btn");
  if (!userAddress) { btn.textContent = "Connect wallet to enter"; btn.disabled = true; return; }
  if (!isEntryValid()) { btn.textContent = "Enter a valid 6-character string"; btn.disabled = true; return; }
  btn.textContent = "Submit Entry";
  btn.disabled    = false;
}

// ─── Submit Entry ─────────────────────────────────────────────────────────────

function stringToBytes6(str) {
  let hex = "0x";
  for (let i = 0; i < 6; i++) hex += str.charCodeAt(i).toString(16).padStart(2, "0");
  return hex;
}

async function handleSubmitEntry() {
  if (!userAddress || !isEntryValid()) return;
  const btn      = document.getElementById("entry-btn");
  const entryStr = document.getElementById("entry-string").value;
  const string6  = stringToBytes6(entryStr);

  try {
    btn.disabled = true;
    const registry = new ethers.Contract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI, signer);
    const useETH   = selectedToken.isNative;

    let timbsNeeded = ethers.BigNumber.from(0);
    if (!useETH) timbsNeeded = timbsNeeded.add(entryCostTIMBS_wei);
    if (extraRounds > 0) {
      const extra = await registry.additionalRoundCost(extraRounds);
      timbsNeeded = timbsNeeded.add(extra);
    }

    if (timbsNeeded.gt(0)) {
      const timbs = new ethers.Contract(ADDRESSES.TIMBSToken, TIMBS_ABI, signer);
      const allow = await timbs.allowance(userAddress, ADDRESSES.GameRegistry);
      if (allow.lt(timbsNeeded)) {
        btn.textContent = "Approving TIMBS…";
        DebugHub.logCheckpoint("Prize:Approve Requested", "pass");
        const gas = await getGasParams(); const nonce = await getPendingNonce();
        await (await timbs.approve(ADDRESSES.GameRegistry, ethers.constants.MaxUint256, { ...gas, nonce })).wait();
        DebugHub.logCheckpoint("Prize:Approve Confirmed", "pass");
      }
    }

    btn.textContent = "Submitting…";
    DebugHub.logCheckpoint("Prize:Entry Requested", "pass");
    const gas   = await getGasParams();
    const nonce = await getPendingNonce();
    const value = useETH ? entryCostETH_wei : ethers.BigNumber.from(0);
    const tx    = await registry.submitEntry(string6, useETH, extraRounds, { ...gas, nonce, value });
    DebugHub.logCheckpoint("Prize:Entry Submitted", "pass");
    await tx.wait();
    DebugHub.logCheckpoint("Prize:Entry Confirmed", "pass");

    btn.textContent = "Entry submitted ✓";
    document.getElementById("entry-string").value = "";
    extraRounds = 0;
    document.getElementById("extra-rounds-val").textContent = "0";
    await loadMyEntries();
    setTimeout(() => { btn.textContent = "Submit Entry"; btn.disabled = false; }, 2000);

  } catch (err) {
    console.error("Entry failed:", err.message);
    DebugHub.logError("handleSubmitEntry", err);
    DebugHub.logCheckpoint("Prize:Entry Failed", "fail");
    btn.textContent = "Failed — try again";
    setTimeout(() => { btn.textContent = "Submit Entry"; btn.disabled = false; }, 2500);
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

async function loadMyEntries() {
  const list = document.getElementById("my-entries-list");
  if (!userAddress) {
    list.innerHTML = '<div class="empty-state">Connect wallet to view entries</div>';
    return;
  }
  try {
    const registry = new ethers.Contract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI, readProv());
    const rounds   = await registry.getPlayerRounds(userAddress);
    if (!rounds.length) { list.innerHTML = '<div class="empty-state">No entries yet</div>'; return; }

    list.innerHTML = "";
    for (const round of [...rounds].reverse().slice(0, 6)) {
      const entry = await registry.getEntry(userAddress, round);
      if (!entry.exists) continue;

      const statusName  = STATUS_NAMES[entry.status] || "Unknown";
      const statusClass = "status-" + statusName.toLowerCase();
      const canRefund   = statusName === "Expired" && currentRoundNum !== null
                          && currentRoundNum <= entry.lastEligibleRound.toNumber() + 2;

      const row = document.createElement("div");
      row.className = "entry-row-item";
      row.innerHTML = `
        <div>
          <div class="entry-row-string">${bytes6ToStr(entry.string6)}</div>
          <div class="entry-row-meta">Round ${round} · expires R${entry.lastEligibleRound}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span class="entry-status-badge ${statusClass}">${statusName}</span>
          ${canRefund ? `<button class="btn-claim-mini" onclick="handleClaimRefund(${round})">Refund</button>` : ""}
        </div>`;
      list.appendChild(row);
    }
  } catch (e) {
    console.warn("loadMyEntries:", e.message);
    list.innerHTML = '<div class="empty-state">Could not load entries</div>';
  }
}

async function handleClaimRefund(round) {
  try {
    DebugHub.logCheckpoint("Prize:Refund Requested", "pass");
    const registry = new ethers.Contract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI, signer);
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    await (await registry.claimRefund(round, { ...gas, nonce })).wait();
    DebugHub.logCheckpoint("Prize:Refund Confirmed", "pass");
    await loadMyEntries();
  } catch (err) {
    DebugHub.logError("handleClaimRefund", err);
    DebugHub.logCheckpoint("Prize:Refund Failed", "fail");
    alert("Refund failed: " + (err?.reason || err.message));
  }
}

// ─── Claim Winnings ───────────────────────────────────────────────────────────

async function handleClaimWinnings(round) {
  const btn = document.getElementById("claim-btn-" + round);
  if (btn) { btn.disabled = true; btn.textContent = "Claiming…"; }
  try {
    DebugHub.logCheckpoint("Prize:Claim Requested", "pass");
    const prize = new ethers.Contract(ADDRESSES.TimbPrize, TIMBPRIZE_ABI, signer);
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    await (await prize.claimWinnings(round, { ...gas, nonce })).wait();
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

async function loadPastRounds() {
  const list = document.getElementById("past-rounds-list");
  if (!currentRoundNum || currentRoundNum <= 1) {
    list.innerHTML = '<div class="empty-state">No completed rounds yet</div>';
    return;
  }
  try {
    const prize = new ethers.Contract(ADDRESSES.TimbPrize, TIMBPRIZE_ABI, readProv());
    list.innerHTML = "";
    const start = Math.max(1, currentRoundNum - 10);
    let count   = 0;

    for (let r = currentRoundNum - 1; r >= start; r--) {
      try {
        const result = await prize.getRoundResult(r);
        const ws     = bytes6ToStr(result.winningString);
        if (!ws || ws === "——") continue;

        let claimHtml = "";
        if (userAddress && result.winners.length > 0) {
          const isWinner = result.winners.map(w => w.toLowerCase()).includes(userAddress.toLowerCase());
          if (isWinner) {
            const claimed  = await prize.hasClaimed(r, userAddress).catch(() => true);
            const inWindow = currentRoundNum <= r + 3;
            if (!claimed && inWindow) {
              claimHtml = `<button id="claim-btn-${r}" class="btn-claim-round" onclick="handleClaimWinnings(${r})">Claim ${fmt(result.perWinner)} ETH</button>`;
            } else if (claimed) {
              claimHtml = `<span class="claimed-badge">Claimed ✓</span>`;
            } else {
              claimHtml = `<span class="expired-badge">Window closed</span>`;
            }
          }
        }

        const row = document.createElement("div");
        row.className = "past-round-row" + (claimHtml.includes("btn-claim") ? " past-round-winner" : "");
        row.innerHTML = `
          <div class="past-round-left">
            <span class="past-round-num">Round ${r}</span>
            <span class="past-round-string">${ws}</span>
          </div>
          <div class="past-round-right">
            <span class="past-round-meta">${result.winners.length} winner${result.winners.length !== 1 ? "s" : ""} · ${fmt(result.potAmount)} ETH</span>
            ${claimHtml}
          </div>`;
        list.appendChild(row);
        count++;
      } catch {}
    }

    if (!count) list.innerHTML = '<div class="empty-state">No completed rounds yet</div>';
  } catch (e) {
    DebugHub.logError("loadPastRounds", e);
  }
}

// ─── Wallet Connect ───────────────────────────────────────────────────────────

async function handleConnect() {
  DebugHub.logCheckpoint("Wallet Connect Requested", "pass");
  const ok = await connectWallet();
  if (!ok) { DebugHub.logCheckpoint("Wallet Connect Failed", "fail"); return; }

  DebugHub.startSession();
  DebugHub.logSecurity("Chain Check", "pass");
  DebugHub.logCheckpoint("Wallet Connected", "pass");

  document.getElementById("connect-btn").classList.add("hidden");
  document.getElementById("wallet-info").classList.remove("hidden");
  document.getElementById("network-badge").classList.remove("hidden");
  document.getElementById("wallet-addr").textContent = fmtAddr(userAddress);

  updateEntryButton();
  await Promise.all([loadMyEntries(), loadPastRounds(), pollRoundState()]);

  listenForAccountChanges(async (newAddr) => {
    if (!newAddr) { handleDisconnect(); return; }
    document.getElementById("wallet-addr").textContent = fmtAddr(newAddr);
    updateEntryButton();
    await Promise.all([loadMyEntries(), loadPastRounds(), pollRoundState()]);
  });
}

function handleDisconnect() {
  DebugHub.endSession();
  provider = null; signer = null; userAddress = null;
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
  updateEntryButton();
  loadMyEntries();
  pollRoundState(); // re-render to hide active digit
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  DebugHub.logCheckpoint("Compete:Page Loaded", "pass");

  const _reconnected = await autoReconnect();
  if (_reconnected) {
    document.getElementById("connect-btn")?.classList.add("hidden");
    document.getElementById("wallet-info")?.classList.remove("hidden");
    document.getElementById("network-badge")?.classList.remove("hidden");
    const _el = document.getElementById("wallet-addr");
    if (_el) _el.textContent = fmtAddr(_reconnected);
    DebugHub.startSession();
    DebugHub.logCheckpoint("Wallet Auto-Reconnected", "pass");
    listenForAccountChanges(async (newAddr) => {
      if (!newAddr) { handleDisconnect(); return; }
      const _addrEl = document.getElementById("wallet-addr");
      if (_addrEl) _addrEl.textContent = fmtAddr(newAddr);
      updateEntryButton();
      await Promise.all([loadMyEntries(), loadPastRounds(), pollRoundState()]);
    });
  }

  await loadEntryCosts();
  await buildTokenDropdown();
  await pollRoundState();
  await loadMyEntries();
  await loadPastRounds();

  // Timer tick every second, full state every 4s
  setInterval(async () => {
    const timerEl = document.getElementById("sub-timer");
    if (timerEl && timerEl.textContent.includes(":")) {
      const [mm, ss] = timerEl.textContent.split(":").map(p => parseInt(p));
      if (!isNaN(mm) && !isNaN(ss)) {
        const total = mm * 60 + ss;
        if (total > 0) {
          const nm = String(Math.floor((total-1)/60)).padStart(2,"0");
          const ns = String((total-1) % 60).padStart(2,"0");
          const updatedText = `${nm}:${ns} left in segment`;
          timerEl.textContent = updatedText;
        }
      }
    }
  }, 1000);

  setInterval(pollRoundState, 4000);
  setInterval(loadPastRounds, 30000);
})();
