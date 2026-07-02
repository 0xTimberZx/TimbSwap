// swap.js — TimbSwap swap page logic

const ROUTER_ABI   = [
  "function getReserves(address tokenA, address tokenB) external view returns (uint256 reserveA, uint256 reserveB)",
  "function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) external pure returns (uint256)",
  "function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) external pure returns (uint256)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address tokenIn, address tokenOut, address to, uint256 deadline, bool influencePrize) external returns (uint256 amountOut)"
];
const ERC20_ABI     = [
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)"
];
const ELIGIBLE_ABI  = ["function isEligible(address token) external view returns (bool)"];

// ─── State ────────────────────────────────────────────────────────────────────

let tokenIn   = null;
let tokenOut  = null;
let pickerTarget = null;
let slippagePct  = 1;
let isEligiblePair = false;
let lastEditedSide = "in"; // "in" | "out" — tracks which field user typed in

// ─── Init ─────────────────────────────────────────────────────────────────────

function renderTokenList() {
  const list = document.getElementById("token-list");
  list.innerHTML = "";
  DEFAULT_TOKENS.forEach(t => {
    const row = document.createElement("div");
    row.className = "token-row";
    row.onclick = () => selectToken(t);
    row.innerHTML = `
      <div class="token-logo">${t.logoChar}</div>
      <div class="token-info">
        <div class="token-symbol">${t.symbol}</div>
        <div class="token-name">${t.name}</div>
      </div>
      <div class="token-bal-right" data-addr="${t.address}">—</div>
    `;
    list.appendChild(row);
  });
}

function filterTokens() {
  const q = document.getElementById("token-search").value.toLowerCase();
  document.querySelectorAll(".token-row").forEach(row => {
    const txt = row.textContent.toLowerCase();
    row.style.display = txt.includes(q) ? "flex" : "none";
  });
}

function openTokenPicker(target) {
  pickerTarget = target;
  document.getElementById("token-picker-modal").classList.remove("hidden");
  document.getElementById("token-search").value = "";
  renderTokenList();
  refreshPickerBalances();
}

function closeTokenPicker(e) {
  if (e.target.id === "token-picker-modal") closeTokenPickerDirect();
}
function closeTokenPickerDirect() {
  document.getElementById("token-picker-modal").classList.add("hidden");
}

async function refreshPickerBalances() {
  if (!userAddress) return;
  for (const t of DEFAULT_TOKENS) {
    try {
      const c = new ethers.Contract(t.address, ERC20_ABI, provider);
      const bal = await c.balanceOf(userAddress);
      const el = document.querySelector(`.token-bal-right[data-addr="${t.address}"]`);
      if (el) el.textContent = fmt(bal, t.decimals, 4);
    } catch {}
  }
}

async function selectToken(token) {
  if (pickerTarget === "in") {
    tokenIn = token;
    document.getElementById("token-in-symbol").textContent = token.symbol;
  } else {
    tokenOut = token;
    document.getElementById("token-out-symbol").textContent = token.symbol;
  }
  closeTokenPickerDirect();
  await checkEligibility();
  await refreshBalances();
  await recalcQuote();
}

function flipTokens() {
  [tokenIn, tokenOut] = [tokenOut, tokenIn];
  document.getElementById("token-in-symbol").textContent  = tokenIn  ? tokenIn.symbol  : "Select";
  document.getElementById("token-out-symbol").textContent = tokenOut ? tokenOut.symbol : "Select";
  const inputIn  = document.getElementById("amount-in");
  const inputOut = document.getElementById("amount-out");
  [inputIn.value, inputOut.value] = [inputOut.value, inputIn.value];
  checkEligibility();
  refreshBalances();
  recalcQuote();
}

// ─── Eligibility check — shows/hides influence row + prize panel ────────────

async function checkEligibility() {
  const row   = document.getElementById("influence-row");
  const panel = document.getElementById("prize-panel");

  if (!tokenIn || !tokenOut) {
    row.classList.add("hidden");
    panel.style.display = "none";
    isEligiblePair = false;
    if (window.renderPrizeIndicators) window.renderPrizeIndicators(false);
    return;
  }

  try {
    const registry = new ethers.Contract(ADDRESSES.EligibleTokenRegistry, ELIGIBLE_ABI, readProviderForEligibility());
    const eligible = await registry.isEligible(tokenIn.address);
    isEligiblePair = eligible;
    row.classList.toggle("hidden", !eligible);
    panel.style.display = eligible ? "block" : "none";
    if (window.renderPrizeIndicators) window.renderPrizeIndicators(eligible);
  } catch (e) {
    console.warn("checkEligibility:", e.message);
    row.classList.add("hidden");
    panel.style.display = "none";
  }
}

function readProviderForEligibility() {
  return provider || new ethers.providers.JsonRpcProvider(RPC_URL);
}

// ─── Balances ─────────────────────────────────────────────────────────────────

async function refreshBalances() {
  const balIn  = document.getElementById("bal-in");
  const balOut = document.getElementById("bal-out");

  if (!userAddress) {
    balIn.textContent  = "Balance: —";
    balOut.textContent = "Balance: —";
    return;
  }

  try {
    if (tokenIn) {
      const c = new ethers.Contract(tokenIn.address, ERC20_ABI, provider);
      const bal = await c.balanceOf(userAddress);
      balIn.textContent = `Balance: ${fmt(bal, tokenIn.decimals, 4)}`;
    }
    if (tokenOut) {
      const c = new ethers.Contract(tokenOut.address, ERC20_ABI, provider);
      const bal = await c.balanceOf(userAddress);
      balOut.textContent = `Balance: ${fmt(bal, tokenOut.decimals, 4)}`;
    }
  } catch (e) {
    console.warn("refreshBalances:", e.message);
  }
}

// ─── Quote ────────────────────────────────────────────────────────────────────

async function onAmountInChange() {
  lastEditedSide = "in";
  await recalcQuote();
}
async function onAmountOutChange() {
  lastEditedSide = "out";
  await recalcQuote();
}

async function recalcQuote() {
  const infoBox = document.getElementById("swap-info");
  const swapBtn = document.getElementById("swap-btn");

  if (!tokenIn || !tokenOut) {
    infoBox.classList.add("hidden");
    return;
  }

  const inputIn  = document.getElementById("amount-in");
  const inputOut = document.getElementById("amount-out");
  const readProv = readProviderForEligibility();
  const router   = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_ABI, readProv);

  try {
    const [reserveIn, reserveOut] = await router.getReserves(tokenIn.address, tokenOut.address);

    if (reserveIn.eq(0) || reserveOut.eq(0)) {
      infoBox.classList.add("hidden");
      updateSwapButton("No liquidity for this pair");
      return;
    }

    if (lastEditedSide === "in") {
      const amtIn = inputIn.value;
      if (!amtIn || parseFloat(amtIn) <= 0) {
        inputOut.value = "";
        infoBox.classList.add("hidden");
        updateSwapButton("Enter an amount");
        return;
      }
      const amountInWei = ethers.utils.parseUnits(amtIn, tokenIn.decimals);
      const amountOutWei = await router.getAmountOut(amountInWei, reserveIn, reserveOut);
      inputOut.value = ethers.utils.formatUnits(amountOutWei, tokenOut.decimals);
      renderSwapInfo(amountInWei, amountOutWei, reserveIn, reserveOut);
    } else {
      const amtOut = inputOut.value;
      if (!amtOut || parseFloat(amtOut) <= 0) {
        inputIn.value = "";
        infoBox.classList.add("hidden");
        updateSwapButton("Enter an amount");
        return;
      }
      const amountOutWei = ethers.utils.parseUnits(amtOut, tokenOut.decimals);
      const amountInWei  = await router.getAmountIn(amountOutWei, reserveIn, reserveOut);
      inputIn.value = ethers.utils.formatUnits(amountInWei, tokenIn.decimals);
      renderSwapInfo(amountInWei, amountOutWei, reserveIn, reserveOut);
    }

    updateSwapButton(userAddress ? "Swap" : "Connect wallet to swap");

  } catch (e) {
    console.warn("recalcQuote:", e.message);
    infoBox.classList.add("hidden");
    updateSwapButton("Enter an amount");
  }
}

function renderSwapInfo(amountInWei, amountOutWei, reserveIn, reserveOut) {
  const infoBox = document.getElementById("swap-info");
  infoBox.classList.remove("hidden");

  const rate = parseFloat(ethers.utils.formatUnits(amountOutWei, tokenOut.decimals)) /
               parseFloat(ethers.utils.formatUnits(amountInWei, tokenIn.decimals));
  document.getElementById("info-rate").textContent =
    `1 ${tokenIn.symbol} = ${rate.toFixed(6)} ${tokenOut.symbol}`;

  // Price impact estimate: compare execution price to current spot price
  const spotPrice = parseFloat(ethers.utils.formatUnits(reserveOut, tokenOut.decimals)) /
                     parseFloat(ethers.utils.formatUnits(reserveIn, tokenIn.decimals));
  const impact = Math.abs((rate - spotPrice) / spotPrice) * 100;
  const impactEl = document.getElementById("info-impact");
  impactEl.textContent = impact.toFixed(2) + "%";
  impactEl.className = "info-val" + (impact > 5 ? " danger" : impact > 2 ? " warn" : "");

  const feeAmt = amountInWei.mul(5).div(10000);
  document.getElementById("info-fee").textContent =
    fmt(feeAmt, tokenIn.decimals, 6) + " " + tokenIn.symbol;

  const minReceived = amountOutWei.mul(Math.floor((100 - slippagePct) * 100)).div(10000);
  document.getElementById("info-min").textContent =
    fmt(minReceived, tokenOut.decimals, 6) + " " + tokenOut.symbol;
}

function updateSwapButton(text) {
  const btn = document.getElementById("swap-btn");
  btn.textContent = text;
  btn.disabled = !userAddress || !tokenIn || !tokenOut ||
                 text === "Enter an amount" || text === "No liquidity for this pair";
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function toggleSettings() {
  document.getElementById("settings-panel").classList.toggle("hidden");
}

function setSlippage(pct) {
  slippagePct = pct;
  document.querySelectorAll(".slip-btn").forEach(b => b.classList.remove("slip-active"));
  event.target.classList.add("slip-active");
  document.getElementById("slip-custom").value = "";
  recalcQuote();
}

document.getElementById("slip-custom")?.addEventListener("input", (e) => {
  const val = parseFloat(e.target.value);
  if (val > 0 && val <= 50) {
    slippagePct = val;
    document.querySelectorAll(".slip-btn").forEach(b => b.classList.remove("slip-active"));
    recalcQuote();
  }
});

// ─── Swap Execution ───────────────────────────────────────────────────────────

async function handleSwap() {
  if (!userAddress || !tokenIn || !tokenOut) return;

  const amtIn = document.getElementById("amount-in").value;
  if (!amtIn || parseFloat(amtIn) <= 0) return;

  const btn = document.getElementById("swap-btn");
  const originalText = btn.textContent;

  try {
    const amountInWei = ethers.utils.parseUnits(amtIn, tokenIn.decimals);
    const tokenContract = new ethers.Contract(tokenIn.address, ERC20_ABI, signer);

    // Check allowance
    const allowance = await tokenContract.allowance(userAddress, ADDRESSES.TimbSwapRouter);
    if (allowance.lt(amountInWei)) {
      btn.disabled = true;
      btn.textContent = "Approving…";
      DebugHub.logCheckpoint("Approve Requested", "pass");

      const gas = await getGasParams();
      const nonce = await getPendingNonce();
      const approveTx = await tokenContract.approve(ADDRESSES.TimbSwapRouter, ethers.constants.MaxUint256, { ...gas, nonce });

      DebugHub.logCheckpoint("Approve Submitted", "pass");
      await approveTx.wait();
      DebugHub.logCheckpoint("Approve Confirmed", "pass");
    }

    // Execute swap
    btn.textContent = "Swapping…";
    DebugHub.logCheckpoint("Swap Requested", "pass");

    const router = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_ABI, signer);
    const amountOutWei = ethers.utils.parseUnits(document.getElementById("amount-out").value, tokenOut.decimals);
    const minOut = amountOutWei.mul(Math.floor((100 - slippagePct) * 100)).div(10000);
    const deadline = Math.floor(Date.now() / 1000) + 1200; // 20 min
    const influencePrize = isEligiblePair && document.getElementById("influence-toggle").checked;

    const gas = await getGasParams();
    const nonce = await getPendingNonce();

    const tx = await router.swapExactTokensForTokens(
      amountInWei, minOut, tokenIn.address, tokenOut.address, userAddress, deadline, influencePrize,
      { ...gas, nonce }
    );

    DebugHub.logCheckpoint("Swap Submitted", "pass");
    await tx.wait();
    DebugHub.logCheckpoint("Swap Confirmed", "pass");

    document.getElementById("amount-in").value = "";
    document.getElementById("amount-out").value = "";
    await refreshBalances();
    btn.textContent = "Swap successful ✓";
    setTimeout(() => updateSwapButton("Swap"), 2000);

  } catch (err) {
    const msg = err?.reason || err?.message || String(err);
    console.error("Swap failed:", msg);
    DebugHub.logError("handleSwap", err);
    DebugHub.logCheckpoint("Swap Failed", "fail");
    btn.textContent = "Swap failed — try again";
    setTimeout(() => updateSwapButton(originalText), 2000);
  } finally {
    btn.disabled = false;
  }
}

// ─── Wallet Connect (page-specific wiring) ────────────────────────────────────

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

  await refreshBalances();
  updateSwapButton(tokenIn && tokenOut ? "Swap" : "Select tokens");

  listenForAccountChanges(async (newAddr) => {
    if (!newAddr) { handleDisconnect(); return; }
    document.getElementById("wallet-addr").textContent = fmtAddr(newAddr);
    await refreshBalances();
  });
}

function handleDisconnect() {
  DebugHub.endSession();
  provider = null; signer = null; userAddress = null;
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
  updateSwapButton("Connect wallet to swap");
  refreshBalances();
  const liqAddBtn = document.getElementById("liq-add-btn");
  const liqRemBtn = document.getElementById("liq-remove-btn");
  if (liqAddBtn) { liqAddBtn.disabled = true; liqAddBtn.textContent = "Connect wallet"; }
  if (liqRemBtn) { liqRemBtn.disabled = true; liqRemBtn.textContent = "Connect wallet"; }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  // Default to TIMBS in / WETH out
  tokenIn  = DEFAULT_TOKENS.find(t => t.symbol === "TIMBS");
  tokenOut = DEFAULT_TOKENS.find(t => t.symbol === "WETH");
  document.getElementById("token-in-symbol").textContent  = tokenIn.symbol;
  document.getElementById("token-out-symbol").textContent = tokenOut.symbol;
  checkEligibility();
  recalcQuote();

  // Auto-reconnect if wallet was connected before navigation
  const _reconnected = await autoReconnect();
  if (_reconnected) {
    document.getElementById("connect-btn")?.classList.add("hidden");
    document.getElementById("wallet-info")?.classList.remove("hidden");
    document.getElementById("network-badge")?.classList.remove("hidden");
    const _addrEl = document.getElementById("wallet-addr");
    if (_addrEl) _addrEl.textContent = fmtAddr(_reconnected);
    await refreshBalances();
    updateSwapButton(tokenIn && tokenOut ? "Swap" : "Select tokens");
    DebugHub.startSession();
    DebugHub.logCheckpoint("Wallet Auto-Reconnected", "pass");
    listenForAccountChanges(async (newAddr) => {
      if (!newAddr) { handleDisconnect(); return; }
      const _el = document.getElementById("wallet-addr");
      if (_el) _el.textContent = fmtAddr(newAddr);
      await refreshBalances();
    });
  }
})();

// ─── Liquidity Tab ────────────────────────────────────────────────────────────

const ROUTER_LIQ_ABI = [
  "function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) external returns (uint256 amountA, uint256 amountB, uint256 liquidity)",
  "function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)",
  "function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) external returns (uint256 amountA, uint256 amountB)",
  "function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) external returns (uint256 amountToken, uint256 amountETH)",
  "function getReserves(address tokenA, address tokenB) external view returns (uint256 reserveA, uint256 reserveB)",
  "function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) external pure returns (uint256)"
];

const PAIR_LP_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function totalSupply() external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)"
];

const ERC20_LIQ_ABI = [
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)"
];

// ─── Tab Switcher ─────────────────────────────────────────────────────────────

let activeTab = "swap"; // "swap" | "add" | "remove"

function switchTab(tab) {
  activeTab = tab;
  ["swap", "add", "remove"].forEach(t => {
    document.getElementById("tab-" + t)?.classList.toggle("tab-active", t === tab);
    document.getElementById("panel-" + t)?.classList.toggle("hidden", t !== tab);
  });
}

// ─── Add Liquidity ────────────────────────────────────────────────────────────

async function onAddTokenAChange() {
  const amtA = document.getElementById("liq-amount-a").value;
  if (!amtA || parseFloat(amtA) <= 0) {
    document.getElementById("liq-amount-b").value = "";
    return;
  }
  try {
    const router = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_LIQ_ABI,
      provider || new ethers.providers.JsonRpcProvider(RPC_URL));
    const [resA, resB] = await router.getReserves(ADDRESSES.TIMBSToken, ADDRESSES.WETH);
    if (resA.eq(0) || resB.eq(0)) return;
    const amtAWei  = ethers.utils.parseUnits(amtA, 18);
    const amtBWei  = await router.quote(amtAWei, resA, resB);
    document.getElementById("liq-amount-b").value = ethers.utils.formatUnits(amtBWei, 18);
    updateLiquidityInfo(amtAWei, amtBWei, resA, resB);
  } catch (e) { console.warn("onAddTokenAChange:", e.message); }
}

function updateLiquidityInfo(amtA, amtB, resA, resB) {
  const infoEl = document.getElementById("liq-info");
  if (!infoEl) return;
  const tShare = resA.gt(0) ? (parseFloat(ethers.utils.formatUnits(amtA, 18)) /
    (parseFloat(ethers.utils.formatUnits(resA, 18)) + parseFloat(ethers.utils.formatUnits(amtA, 18))) * 100).toFixed(2) : "100.00";
  infoEl.innerHTML = `
    <div class="info-row"><span class="info-label">Pool share</span><span class="info-val">${tShare}%</span></div>
    <div class="info-row"><span class="info-label">Rate</span><span class="info-val">1 TIMBS = ${(parseFloat(ethers.utils.formatUnits(resB,18))/parseFloat(ethers.utils.formatUnits(resA,18))).toFixed(6)} WETH</span></div>
  `;
  infoEl.classList.remove("hidden");
}

async function handleAddLiquidity() {
  if (!userAddress) return;
  const amtA = document.getElementById("liq-amount-a").value;
  const amtB = document.getElementById("liq-amount-b").value;
  if (!amtA || !amtB || parseFloat(amtA) <= 0 || parseFloat(amtB) <= 0) return;

  const btn    = document.getElementById("liq-add-btn");
  const amtAWei = ethers.utils.parseUnits(amtA, 18);
  const amtBWei = ethers.utils.parseUnits(amtB, 18);
  const slip    = 0.98; // 2% slippage
  const minA    = amtAWei.mul(98).div(100);
  const minB    = amtBWei.mul(98).div(100);
  const deadline = Math.floor(Date.now() / 1000) + 1200;

  try {
    // Approve TIMBS
    const timbs = new ethers.Contract(ADDRESSES.TIMBSToken, ERC20_LIQ_ABI, signer);
    const allow = await timbs.allowance(userAddress, ADDRESSES.TimbSwapRouter);
    if (allow.lt(amtAWei)) {
      btn.disabled = true; btn.textContent = "Approving TIMBS…";
      DebugHub.logCheckpoint("Swap:AddLiq Approve Requested", "pass");
      const gas = await getGasParams(); const nonce = await getPendingNonce();
      await (await timbs.approve(ADDRESSES.TimbSwapRouter, ethers.constants.MaxUint256, { ...gas, nonce })).wait();
      DebugHub.logCheckpoint("Swap:AddLiq Approve Confirmed", "pass");
    }
    // Approve WETH
    const weth = new ethers.Contract(ADDRESSES.WETH, ERC20_LIQ_ABI, signer);
    const allowW = await weth.allowance(userAddress, ADDRESSES.TimbSwapRouter);
    if (allowW.lt(amtBWei)) {
      btn.textContent = "Approving WETH…";
      const gas = await getGasParams(); const nonce = await getPendingNonce();
      await (await weth.approve(ADDRESSES.TimbSwapRouter, ethers.constants.MaxUint256, { ...gas, nonce })).wait();
      DebugHub.logCheckpoint("Swap:AddLiq WETH Approve Confirmed", "pass");
    }

    btn.textContent = "Adding liquidity…";
    DebugHub.logCheckpoint("Swap:AddLiquidity Requested", "pass");
    const router = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_LIQ_ABI, signer);
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    const tx = await router.addLiquidity(
      ADDRESSES.TIMBSToken, ADDRESSES.WETH,
      amtAWei, amtBWei, minA, minB,
      userAddress, deadline, { ...gas, nonce }
    );
    DebugHub.logCheckpoint("Swap:AddLiquidity Submitted", "pass");
    await tx.wait();
    DebugHub.logCheckpoint("Swap:AddLiquidity Confirmed", "pass");

    document.getElementById("liq-amount-a").value = "";
    document.getElementById("liq-amount-b").value = "";
    btn.textContent = "Added ✓";
    await refreshLpBalance();
    setTimeout(() => { btn.textContent = "Add Liquidity"; btn.disabled = false; }, 2000);

  } catch (err) {
    const msg = err?.reason || err?.message || String(err);
    console.error("addLiquidity failed:", msg);
    DebugHub.logError("handleAddLiquidity", err);
    DebugHub.logCheckpoint("Swap:AddLiquidity Failed", "fail");
    btn.textContent = "Failed — retry"; btn.disabled = false;
    setTimeout(() => { btn.textContent = "Add Liquidity"; }, 2000);
  }
}

// ─── Remove Liquidity ─────────────────────────────────────────────────────────

async function refreshLpBalance() {
  const el = document.getElementById("lp-balance-display");
  if (!el || !userAddress) return;
  try {
    const lp = new ethers.Contract(ADDRESSES.TimbsEthPair, PAIR_LP_ABI,
      provider || new ethers.providers.JsonRpcProvider(RPC_URL));
    const bal = await lp.balanceOf(userAddress);
    el.textContent = "Balance: " + fmt(bal, 18, 6) + " LP";
    document.getElementById("remove-pct-display").textContent = "0%";
    document.getElementById("lp-remove-amount").dataset.total = bal.toString();
  } catch (e) { el.textContent = "Balance: —"; }
}

function onRemoveSlider() {
  const pct = document.getElementById("remove-slider").value;
  document.getElementById("remove-pct-display").textContent = pct + "%";
}

async function handleRemoveLiquidity() {
  if (!userAddress) return;
  const pct = parseInt(document.getElementById("remove-slider").value);
  if (pct === 0) return;

  const btn = document.getElementById("liq-remove-btn");
  const totalStr = document.getElementById("lp-remove-amount").dataset.total || "0";
  const total    = ethers.BigNumber.from(totalStr);
  if (total.eq(0)) { btn.textContent = "No LP tokens"; return; }

  const lpAmt   = total.mul(pct).div(100);
  const deadline = Math.floor(Date.now() / 1000) + 1200;

  try {
    // Approve LP
    const lp = new ethers.Contract(ADDRESSES.TimbsEthPair, PAIR_LP_ABI, signer);
    const allow = await lp.allowance(userAddress, ADDRESSES.TimbSwapRouter);
    if (allow.lt(lpAmt)) {
      btn.disabled = true; btn.textContent = "Approving LP…";
      DebugHub.logCheckpoint("Swap:RemoveLiq Approve Requested", "pass");
      const gas = await getGasParams(); const nonce = await getPendingNonce();
      await (await lp.approve(ADDRESSES.TimbSwapRouter, ethers.constants.MaxUint256, { ...gas, nonce })).wait();
      DebugHub.logCheckpoint("Swap:RemoveLiq Approve Confirmed", "pass");
    }

    btn.textContent = "Removing…";
    DebugHub.logCheckpoint("Swap:RemoveLiquidity Requested", "pass");
    const router = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_LIQ_ABI, signer);
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    const tx = await router.removeLiquidity(
      ADDRESSES.TIMBSToken, ADDRESSES.WETH,
      lpAmt, 0, 0, userAddress, deadline, { ...gas, nonce }
    );
    DebugHub.logCheckpoint("Swap:RemoveLiquidity Submitted", "pass");
    await tx.wait();
    DebugHub.logCheckpoint("Swap:RemoveLiquidity Confirmed", "pass");

    btn.textContent = "Removed ✓";
    await refreshLpBalance();
    setTimeout(() => { btn.textContent = "Remove Liquidity"; btn.disabled = false; }, 2000);

  } catch (err) {
    const msg = err?.reason || err?.message || String(err);
    console.error("removeLiquidity failed:", msg);
    DebugHub.logError("handleRemoveLiquidity", err);
    DebugHub.logCheckpoint("Swap:RemoveLiquidity Failed", "fail");
    btn.textContent = "Failed — retry"; btn.disabled = false;
    setTimeout(() => { btn.textContent = "Remove Liquidity"; }, 2000);
  }
}
