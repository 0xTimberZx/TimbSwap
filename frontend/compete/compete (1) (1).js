// compete.js — TimbSwap prize game entry, status, claim logic

const TIMBPRIZE_ABI = [
  "function getRoundState() external view returns (uint256 round, uint256 segment, uint256 segmentStart, uint256 counter, bytes6 currentWindow, uint256 pot, uint256 unclaimedPool, bool inSettlement)",
  "function gameStarted() external view returns (bool)",
  "function getRoundResult(uint256 round) external view returns (bytes6 winningString, uint256 potAmount, address[] winners, uint256 perWinner, uint256 remainder)",
  "function claimWinnings(uint256 round) external"
];
const GAME_REGISTRY_ABI = [
  "function currentRound() external view returns (uint256)",
  "function entryCostTIMBS() external view returns (uint256)",
  "function entryCostETH() external view returns (uint256)",
  "function getPlayerRounds(address player) external view returns (uint256[])",
  "function getEntry(address player, uint256 round) external view returns (bytes6 string6, uint256 entryRound, uint256 lastEligibleRound, uint256 escrowAmount, address escrowToken, uint8 status, bool exists)",
  "function validateString(bytes6 s) external pure returns (bool valid, string reason)",
  "function additionalRoundCost(uint256 extraRounds) external view returns (uint256)",
  "function submitEntry(bytes6 string6, bool useETH, uint256 extraRounds) external payable",
  "function claimRefund(uint256 round) external"
];
const TIMBS_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)"
];

const STATUS_NAMES = ["Pending", "Active", "Expired", "Claimed", "Inactive"];

const ELIGIBLE_REGISTRY_ABI = [
  "function getEligibleTokens() external view returns (address[])",
  "function isEligible(address token) external view returns (bool)"
];
const ERC20_SYMBOL_ABI = [
  "function symbol() external view returns (string)"
];

// ─── State ────────────────────────────────────────────────────────────────────

// selectedToken: { address, symbol, isNative }
// isNative = true means pay with native ETH (address = WETH under the hood)
let selectedToken = { address: "native", symbol: "ETH", isNative: true };
let eligibleTokens = []; // [{ address, symbol, isNative }]
let extraRounds = 0;
let entryCostETH_wei = null;
let entryCostTIMBS_wei = null;
let currentRoundNum = null;

function readProv() {
  return provider || new ethers.providers.JsonRpcProvider(RPC_URL);
}

// ─── Round State Polling ──────────────────────────────────────────────────────

function bytes6ToChars(b6) {
  const hex = b6.replace("0x", "");
  const chars = [];
  for (let i = 0; i < 6; i++) {
    const code = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    chars.push(code > 0 ? String.fromCharCode(code) : "·");
  }
  return chars;
}

async function pollRoundState() {
  try {
    const prize = new ethers.Contract(ADDRESSES.TimbPrize, TIMBPRIZE_ABI, readProv());
    const started = await prize.gameStarted();

    if (!started) {
      document.getElementById("hdr-round").textContent = "—";
      document.getElementById("sub-timer").textContent = "Game not started";
      return;
    }

    const s = await prize.getRoundState();
    currentRoundNum = s.round.toNumber();

    document.getElementById("hdr-round").textContent = "#" + s.round.toString();
    document.getElementById("hdr-segment").textContent = `${s.segment}/6`;
    document.getElementById("sub-pot").textContent = "Pot: " + fmt(s.pot) + " ETH";

    const chars = bytes6ToChars(s.currentWindow);
    chars.forEach((c, i) => {
      const el = document.getElementById("lc" + i);
      if (el) {
        el.textContent = c;
        el.classList.toggle("dim", c === "·");
      }
    });

    const timerEl = document.getElementById("sub-timer");
    if (s.inSettlement) {
      timerEl.textContent = "Settling round…";
    } else {
      const elapsed = Math.floor(Date.now() / 1000) - s.segmentStart.toNumber();
      const remaining = Math.max(0, (59 * 60 + 45) - elapsed);
      const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
      const ss = String(remaining % 60).padStart(2, "0");
      timerEl.textContent = `${mm}:${ss} left in segment`;
    }

  } catch (e) {
    console.warn("pollRoundState:", e.message);
  }
}

async function loadEntryCosts() {
  try {
    const registry = new ethers.Contract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI, readProv());
    entryCostETH_wei   = await registry.entryCostETH();
    entryCostTIMBS_wei = await registry.entryCostTIMBS();
    updateCostDisplay();
  } catch (e) {
    console.warn("loadEntryCosts:", e.message);
  }
}

async function updateCostDisplay() {
  if (entryCostETH_wei === null) return;
  const costEl = document.getElementById("entry-cost-val");
  const noteEl = document.getElementById("extra-cost-note");

  // Base cost based on selected token
  let baseCost;
  if (selectedToken.isNative) {
    baseCost = fmt(entryCostETH_wei) + " ETH";
  } else if (selectedToken.symbol === "TIMBS") {
    baseCost = fmtTIMBS(entryCostTIMBS_wei);
  } else {
    baseCost = fmt(entryCostETH_wei) + " " + selectedToken.symbol;
  }
  costEl.textContent = baseCost;

  // Extra rounds note — separate quiet indicator
  if (extraRounds > 0 && noteEl) {
    try {
      const registry = new ethers.Contract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI, readProv());
      const extraCost = await registry.additionalRoundCost(extraRounds);
      noteEl.textContent = `+ ${fmtTIMBS(extraCost)} TIMBS · non-refundable`;
      noteEl.classList.remove("hidden");
    } catch { noteEl.classList.add("hidden"); }
  } else if (noteEl) {
    noteEl.classList.add("hidden");
  }
}

// ─── Entry Input Validation ───────────────────────────────────────────────────

function onEntryInput() {
  const input = document.getElementById("entry-string");
  input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "");

  const val = input.value;
  const validationEl = document.getElementById("entry-validation");

  if (val.length === 0) {
    validationEl.textContent = "";
    validationEl.className = "entry-validation";
    input.classList.remove("valid", "invalid");
    updateEntryButton();
    return;
  }

  if (val.length < 6) {
    validationEl.textContent = `${6 - val.length} more character${6 - val.length > 1 ? "s" : ""} needed`;
    validationEl.className = "entry-validation";
    input.classList.remove("valid", "invalid");
    updateEntryButton();
    return;
  }

  // Check repeats
  const seen = new Set();
  let hasRepeat = false;
  for (const c of val) {
    if (seen.has(c)) { hasRepeat = true; break; }
    seen.add(c);
  }

  if (hasRepeat) {
    validationEl.textContent = "No repeating characters allowed";
    validationEl.className = "entry-validation error";
    input.classList.add("invalid");
    input.classList.remove("valid");
  } else {
    validationEl.textContent = "Valid entry string";
    validationEl.className = "entry-validation ok";
    input.classList.add("valid");
    input.classList.remove("invalid");
  }

  updateEntryButton();
}

function isEntryValid() {
  const val = document.getElementById("entry-string").value;
  if (val.length !== 6) return false;
  const seen = new Set();
  for (const c of val) {
    if (seen.has(c)) return false;
    seen.add(c);
  }
  return true;
}

// ─── Token Dropdown ──────────────────────────────────────────────────────────

async function buildTokenDropdown() {
  try {
    const registry = new ethers.Contract(ADDRESSES.EligibleTokenRegistry, ELIGIBLE_REGISTRY_ABI, readProv());
    const addrs = await registry.getEligibleTokens();

    // Always include native ETH first
    eligibleTokens = [{ address: "native", symbol: "ETH", isNative: true }];

    for (const addr of addrs) {
      // Skip WETH (represented as native ETH) and DAPP (not an accepted entry currency)
      if (addr.toLowerCase() === ADDRESSES.WETH.toLowerCase()) continue;
      if (addr.toLowerCase() === ADDRESSES.DAPP.toLowerCase()) continue;
      try {
        const erc = new ethers.Contract(addr, ERC20_SYMBOL_ABI, readProv());
        const symbol = await erc.symbol();
        eligibleTokens.push({ address: addr, symbol, isNative: false });
      } catch {}
    }

    renderTokenDropdown();
  } catch (e) {
    // Fallback: ETH + TIMBS only
    eligibleTokens = [
      { address: "native", symbol: "ETH", isNative: true },
      { address: ADDRESSES.TIMBSToken, symbol: "TIMBS", isNative: false }
    ];
    renderTokenDropdown();
    console.warn("buildTokenDropdown fallback:", e.message);
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
  // Only show dropdown if more than 2 tokens
  if (eligibleTokens.length <= 2) {
    // Simple toggle between first two
    const idx = eligibleTokens.findIndex(t => t.symbol === selectedToken.symbol);
    const next = eligibleTokens[(idx + 1) % eligibleTokens.length];
    selectEntryToken(next);
    return;
  }
  document.getElementById("token-dropdown").classList.toggle("hidden");
}

// Close dropdown on outside click
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

function updateEntryButton() {
  const btn = document.getElementById("entry-btn");
  if (!userAddress) { btn.textContent = "Connect wallet to enter"; btn.disabled = true; return; }
  if (!isEntryValid()) { btn.textContent = "Enter a valid 6-character string"; btn.disabled = true; return; }
  btn.textContent = "Submit Entry";
  btn.disabled = false;
}

// ─── Submit Entry ─────────────────────────────────────────────────────────────

function stringToBytes6(str) {
  let hex = "0x";
  for (let i = 0; i < 6; i++) {
    hex += str.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return hex;
}

async function handleSubmitEntry() {
  if (!userAddress || !isEntryValid()) return;

  const btn = document.getElementById("entry-btn");
  const entryStr = document.getElementById("entry-string").value;
  const string6 = stringToBytes6(entryStr);

  try {
    btn.disabled = true;
    const registry = new ethers.Contract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI, signer);
    const useETH = selectedToken.isNative;

    let totalTimbsNeeded = ethers.BigNumber.from(0);
    if (!useETH) totalTimbsNeeded = totalTimbsNeeded.add(entryCostTIMBS_wei);
    if (extraRounds > 0) {
      const extraCost = await registry.additionalRoundCost(extraRounds);
      totalTimbsNeeded = totalTimbsNeeded.add(extraCost);
    }

    if (totalTimbsNeeded.gt(0)) {
      const timbsToken = new ethers.Contract(ADDRESSES.TIMBSToken, TIMBS_ABI, signer);
      const allowance = await timbsToken.allowance(userAddress, ADDRESSES.GameRegistry);
      if (allowance.lt(totalTimbsNeeded)) {
        btn.textContent = "Approving TIMBS…";
        DebugHub.logCheckpoint("Approve Requested", "pass");
        const gas = await getGasParams();
        const nonce = await getPendingNonce();
        const approveTx = await timbsToken.approve(ADDRESSES.GameRegistry, ethers.constants.MaxUint256, { ...gas, nonce });
        DebugHub.logCheckpoint("Approve Submitted", "pass");
        await approveTx.wait();
        DebugHub.logCheckpoint("Approve Confirmed", "pass");
      }
    }

    btn.textContent = "Submitting entry…";
    DebugHub.logCheckpoint("Entry Requested", "pass");

    const gas = await getGasParams();
    const nonce = await getPendingNonce();
    const value = useETH ? entryCostETH_wei : ethers.BigNumber.from(0);

    const tx = await registry.submitEntry(string6, useETH, extraRounds, { ...gas, nonce, value });
    DebugHub.logCheckpoint("Entry Submitted", "pass");
    await tx.wait();
    DebugHub.logCheckpoint("Entry Confirmed", "pass");

    btn.textContent = "Entry submitted ✓";
    document.getElementById("entry-string").value = "";
    extraRounds = 0;
    document.getElementById("extra-rounds-val").textContent = "0";
    await loadMyEntries();
    setTimeout(() => { btn.textContent = "Submit Entry"; btn.disabled = false; }, 2000);

  } catch (err) {
    const msg = err?.reason || err?.message || String(err);
    console.error("Entry submission failed:", msg);
    DebugHub.logError("handleSubmitEntry", err);
    DebugHub.logCheckpoint("Entry Failed", "fail");
    btn.textContent = "Entry failed — try again";
    setTimeout(() => { btn.textContent = "Submit Entry"; btn.disabled = false; }, 2500);
  }
}

// ─── My Entries ───────────────────────────────────────────────────────────────

async function loadMyEntries() {
  const list = document.getElementById("my-entries-list");

  if (!userAddress) {
    list.innerHTML = '<div class="empty-state">Connect wallet to view your entries</div>';
    return;
  }

  try {
    const registry = new ethers.Contract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI, readProv());
    const rounds = await registry.getPlayerRounds(userAddress);

    if (rounds.length === 0) {
      list.innerHTML = '<div class="empty-state">No entries yet</div>';
      return;
    }

    list.innerHTML = "";
    // Show most recent first, max 6
    const recentRounds = [...rounds].reverse().slice(0, 6);

    for (const round of recentRounds) {
      const entry = await registry.getEntry(userAddress, round);
      if (!entry.exists) continue;

      const chars = bytes6ToChars(entry.string6);
      const statusName = STATUS_NAMES[entry.status] || "Unknown";
      const statusClass = "status-" + statusName.toLowerCase();

      const row = document.createElement("div");
      row.className = "entry-row-item";

      const canClaimRefund = (statusName === "Expired") &&
        currentRoundNum !== null && currentRoundNum <= entry.lastEligibleRound.toNumber() + 2;

      row.innerHTML = `
        <div>
          <div class="entry-row-string">${chars.join("")}</div>
          <div class="entry-row-meta">Round ${round.toString()} · expires R${entry.lastEligibleRound.toString()}</div>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <span class="entry-status-badge ${statusClass}">${statusName}</span>
          ${canClaimRefund ? `<button class="btn-claim-mini" onclick="handleClaimRefund(${round.toString()})">Refund</button>` : ""}
        </div>
      `;
      list.appendChild(row);
    }

  } catch (e) {
    console.warn("loadMyEntries:", e.message);
    list.innerHTML = '<div class="empty-state">Could not load entries</div>';
  }
}

async function handleClaimRefund(round) {
  try {
    DebugHub.logCheckpoint("Claim Requested", "pass");
    const registry = new ethers.Contract(ADDRESSES.GameRegistry, GAME_REGISTRY_ABI, signer);
    const gas = await getGasParams();
    const nonce = await getPendingNonce();
    const tx = await registry.claimRefund(round, { ...gas, nonce });
    DebugHub.logCheckpoint("Claim Submitted", "pass");
    await tx.wait();
    DebugHub.logCheckpoint("Claim Confirmed", "pass");
    await loadMyEntries();
  } catch (err) {
    console.error("Claim refund failed:", err.message);
    DebugHub.logError("handleClaimRefund", err);
    DebugHub.logCheckpoint("Claim Failed", "fail");
    alert("Refund claim failed: " + (err?.reason || err.message));
  }
}

// ─── Past Rounds ──────────────────────────────────────────────────────────────

async function loadPastRounds() {
  const list = document.getElementById("past-rounds-list");
  if (currentRoundNum === null || currentRoundNum <= 1) {
    list.innerHTML = '<div class="empty-state">No completed rounds yet</div>';
    return;
  }

  try {
    const prize = new ethers.Contract(ADDRESSES.TimbPrize, TIMBPRIZE_ABI, readProv());
    list.innerHTML = "";
    const start = Math.max(1, currentRoundNum - 5);

    for (let r = currentRoundNum - 1; r >= start; r--) {
      try {
        const result = await prize.getRoundResult(r);
        if (result.winningString === "0x000000000000") continue;

        const chars = bytes6ToChars(result.winningString);
        const row = document.createElement("div");
        row.className = "past-round-row";
        row.innerHTML = `
          <span class="past-round-num">Round ${r}</span>
          <span class="past-round-string">${chars.join("")}</span>
          <span class="past-round-meta">${result.winners.length} winner${result.winners.length !== 1 ? "s" : ""} · ${fmt(result.potAmount)} ETH pot</span>
        `;
        list.appendChild(row);
      } catch {}
    }

    if (list.children.length === 0) {
      list.innerHTML = '<div class="empty-state">No completed rounds yet</div>';
    }
  } catch (e) {
    console.warn("loadPastRounds:", e.message);
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
  await loadMyEntries();

  listenForAccountChanges(async (newAddr) => {
    if (!newAddr) { handleDisconnect(); return; }
    document.getElementById("wallet-addr").textContent = fmtAddr(newAddr);
    updateEntryButton();
    await loadMyEntries();
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

  await loadEntryCosts();
  await buildTokenDropdown();
  await pollRoundState();
  await loadMyEntries();
  await loadPastRounds();

  setInterval(pollRoundState, 4000);
  setInterval(loadPastRounds, 30000);
})();
