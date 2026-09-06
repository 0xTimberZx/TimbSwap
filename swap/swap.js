// swap.js — TimbSwap swap page logic

const ROUTER_ABI   = [
  "function getReserves(address tokenA, address tokenB) external view returns (uint256 reserveA, uint256 reserveB)",
  "function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) external pure returns (uint256)",
  "function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) external pure returns (uint256)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address tokenIn, address tokenOut, address to, uint256 deadline, bool influencePrize) external returns (uint256 amountOut)",
  "function getAmountsOutPath(uint256 amountIn, address[] path) external view returns (uint256[] amounts)",
  "function getAmountsInPath(uint256 amountOut, address[] path) external view returns (uint256[] amounts)",
  "function swapExactTokensForTokensPath(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline, bool influencePrize) external returns (uint256 amountOut)",
  "function swapExactETHForTokens(uint256 amountIn, uint256 amountOutMin, address tokenOut, address to, uint256 deadline, bool influencePrize) external payable returns (uint256 amountOut)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address tokenIn, address to, uint256 deadline, bool influencePrize) external returns (uint256 amountOut)",
  "function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) external returns (uint256, uint256, uint256)",
  "function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) external returns (uint256, uint256)"
];
const WETH_ABI = [
  "function deposit() external payable",
  "function withdraw(uint256 amount) external"
];
const FACTORY_ABI = [
  "function getPairAddress(address tokenA, address tokenB) external view returns (address)",
  "function createPair(address tokenA, address tokenB) external returns (address pair)"
];
const ERC20_ABI     = [
  "function balanceOf(address account) external view returns (uint256)",
  "function totalSupply() external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
  "function name() external view returns (string)"
];
const ELIGIBLE_ABI  = ["function isEligible(address token) external view returns (bool)"];

// ─── State ────────────────────────────────────────────────────────────────────

let tokenIn   = null;
let tokenOut  = null;
let pickerTarget = null;
let slippagePct  = 1;
let isEligiblePair = false;
let lastEditedSide = "in"; // "in" | "out" — tracks which field user typed in
let mode          = "swap"; // "swap" | "liquidity"
let removePct     = 0;      // selected % for remove-liquidity
let lpPairAddress = null;   // cached LP pair address for the current pair
let lpBalanceWei  = null;   // cached LP balance for the connected wallet

// LP tokens are 18-decimal, but a pair with a 6-decimal token (USDC/USDT)
// mints LP on the order of 1e-7, so a fixed 6-dp format renders a REAL
// position as "0.000000". Show adaptive precision: normal amounts get up to
// 6 dp; sub-1 amounts get enough decimals to surface the value, trailing
// zeros trimmed — so a tiny-but-real LP balance is visible, never a
// misleading zero. (The Withdrawable row shows the position in token terms.)
function fmtLp(wei) {
  if (!wei || wei.isZero()) return "0";
  const f = parseFloat(ethers.utils.formatUnits(wei, 18));
  if (f >= 1) return f.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return f.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}
// Cached pool state for the remove-liquidity preview so dragging the slider
// recomputes the payout instantly, with no per-move network call.
let lpReserveA    = null;
let lpReserveB    = null;
let lpTotalSupply = null;
// Cached wallet balances (wei) for the two liquidity inputs, refreshed by
// refreshLiquidity(). Drive the "Insufficient balance" button state without
// re-reading the chain on every keystroke. null = unknown (don't block).
let lqBalAWei     = null;
let lqBalBWei     = null;

// Trim a formatUnits string for display: keep the whole part, cap the fraction
// at 8 places, drop trailing zeros. Avoids the ~20-decimal quote readouts.
function trimAmount(weiStr) {
  if (weiStr == null || weiStr === "") return "";
  const [intPart, frac = ""] = String(weiStr).split(".");
  if (!frac) return intPart;
  const trimmed = (intPart + "." + frac.slice(0, 8)).replace(/\.?0+$/, "");
  return trimmed === "" ? "0" : trimmed;
}

// ─── Native ETH support ───────────────────────────────────────────────────────
// ETH is a swap-page-local pseudo-token (not in DEFAULT_TOKENS, so other pages
// never see it). ETH↔WETH is a 1:1 wrap/unwrap on the WETH contract — no pool,
// no fee, no slippage. ETH↔token routes through the WETH pool via the router's
// swapExactETHForTokens / swapExactTokensForETH.

const NATIVE_ETH = {
  symbol: "ETH", name: "Ether (native)", address: "native",
  decimals: 18, logoChar: "Ξ", isNative: true
};

// Known extra tokens on Arbitrum Sepolia beyond the shared DEFAULT_TOKENS.
// LINK address is Chainlink's documented Arbitrum Sepolia token — the picker
// shows live on-chain symbol/balance, so a wrong address is immediately visible.
// USDC + LINK now live in the shared DEFAULT_TOKENS (config.js), so they're
// no longer duplicated here. Keep this array for swap-page-only extras.
// TestUSDT joins here once deployed (contracts/TestUSDT.sol) — 6 decimals.
const EXTRA_TOKENS = [];

// Custom tokens the user imported by pasting an address (persisted per-browser).
const CUSTOM_TOKENS_KEY = "timbswap_custom_tokens";
function loadCustomTokens() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_TOKENS_KEY)) || []; } catch { return []; }
}
function saveCustomTokens() {
  try { localStorage.setItem(CUSTOM_TOKENS_KEY, JSON.stringify(customTokens)); } catch {}
}
let customTokens = loadCustomTokens();

// Dedupe by address (case-insensitive) so a token that's both canonical and
// user-imported shows once. First occurrence wins, so canonical metadata
// (DEFAULT_TOKENS) beats a hand-imported copy of the same address.
function allTokens() {
  const seen = new Set();
  return [NATIVE_ETH, ...DEFAULT_TOKENS, ...EXTRA_TOKENS, ...customTokens].filter(t => {
    const k = (t.address || "").toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function isNative(t)  { return !!(t && t.isNative); }
// Address used for pool math/eligibility — native ETH trades as WETH.
function effAddr(t)   { return isNative(t) ? ADDRESSES.WETH : t.address; }
// ETH↔WETH in either direction is a wrap/unwrap, not a pool trade.
function isWrapPair() {
  if (!tokenIn || !tokenOut) return false;
  return (isNative(tokenIn)  && tokenOut.address === ADDRESSES.WETH) ||
         (isNative(tokenOut) && tokenIn.address  === ADDRESSES.WETH);
}

async function tokenBalance(t) {
  const read = readProviderForEligibility();
  if (isNative(t)) return read.getBalance(userAddress);
  return new ethers.Contract(t.address, ERC20_ABI, read).balanceOf(userAddress);
}

// Tapping the "You pay" balance fills the input with the full balance and
// re-quotes. (Native ETH fills to the whole balance; the pre-flight check
// and requote in handleSwap handle the gas headroom conversation.)
async function fillMaxIn() {
  if (!userAddress || !tokenIn) return;
  try {
    let bal = await tokenBalance(tokenIn);
    // The 0.05% protocol fee is pulled ON TOP of amountIn for every non-wrap
    // swap (see router _collectProtocolFee), so a full-balance MAX would revert
    // on the fee transfer ("transfer amount exceeds balance"). Reserve the fee:
    // largest amountIn with amountIn + 0.05% ≤ balance is balance × 10000/10005.
    if (!isWrapPair()) bal = bal.mul(10000).div(10005);
    document.getElementById("amount-in").value =
      trimAmount(ethers.utils.formatUnits(bal, tokenIn.decimals));
    lastEditedSide = "in";
    onAmountInChange();
  } catch (e) { console.warn("fillMaxIn:", e.message); }
}

// Tapping a Liquidity balance fills that side with the full wallet balance,
// then mirrors the counterpart from the live pool ratio (no-op for a new pool).
async function fillMaxLqA() {
  if (!userAddress || !tokenIn) return;
  try {
    const bal = await tokenBalance(tokenIn);
    document.getElementById("lq-amount-a").value = trimAmount(ethers.utils.formatUnits(bal, tokenIn.decimals));
    onLqAmountA();
  } catch (e) { console.warn("fillMaxLqA:", e.message); }
}
async function fillMaxLqB() {
  if (!userAddress || !tokenOut) return;
  try {
    const bal = await tokenBalance(tokenOut);
    document.getElementById("lq-amount-b").value = trimAmount(ethers.utils.formatUnits(bal, tokenOut.decimals));
    onLqAmountB();
  } catch (e) { console.warn("fillMaxLqB:", e.message); }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function renderTokenList() {
  const list = document.getElementById("token-list");
  list.innerHTML = "";
  allTokens().forEach(t => {
    const row = document.createElement("div");
    row.className = "token-row";
    row.onclick = () => selectToken(t);
    // Fixed-width control slots keep every row's balance column aligned:
    // an "add to wallet" icon (or an equal-width spacer for native ETH, which
    // can't be watched) and a remove ✕ (or spacer for non-imported tokens).
    const addHtml = t.isNative
      ? `<span class="token-ctl-slot"></span>`
      : `<button class="token-ctl-slot token-add-wallet" title="Add ${t.symbol} to your wallet" onclick="event.stopPropagation(); addTokenToWalletByAddr('${t.address}')">＋</button>`;
    const removeHtml = t.isCustom
      ? `<button class="token-ctl-slot token-remove" title="Remove from list" onclick="event.stopPropagation(); removeCustomToken('${t.address}')">✕</button>`
      : `<span class="token-ctl-slot"></span>`;
    row.innerHTML = `
      <div class="token-logo">${t.logoChar}</div>
      <div class="token-info">
        <div class="token-symbol">${t.symbol}</div>
        <div class="token-name">${t.name}</div>
      </div>
      ${addHtml}
      <div class="token-bal-right" data-addr="${t.address}">—</div>
      ${removeHtml}
    `;
    list.appendChild(row);
  });
  // Empty state so the list never looks broken when a filter matches nothing.
  const empty = document.createElement("div");
  empty.id = "token-list-empty";
  empty.className = "token-list-empty hidden";
  empty.textContent = "No matches — paste a token address (0x…) to import it.";
  list.appendChild(empty);
}

async function filterTokens() {
  const q  = document.getElementById("token-search").value.trim();
  const ql = q.toLowerCase();
  let visible = 0;
  document.querySelectorAll(".token-row:not(#token-import-row)").forEach(row => {
    const show = row.textContent.toLowerCase().includes(ql);
    row.style.display = show ? "flex" : "none";
    if (show) visible++;
  });

  removeImportRow();
  const empty  = document.getElementById("token-list-empty");
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(q);
  const known  = allTokens().some(t => t.address.toLowerCase() === ql);
  if (isAddr && !known) {
    if (empty) empty.classList.add("hidden");
    await offerImport(q);
  } else if (empty) {
    empty.classList.toggle("hidden", visible > 0);
  }
}

// ─── Custom token import ──────────────────────────────────────────────────────
// Pasting an unknown ERC-20 address into the search box looks it up on-chain
// and offers a tap-to-import row; imported tokens persist in localStorage.

let _importSeq = 0;

async function offerImport(addr) {
  const list = document.getElementById("token-list");
  if (!list) return;
  const seq = ++_importSeq;
  const row = document.createElement("div");
  row.className = "token-row token-import-row";
  row.id = "token-import-row";
  row.innerHTML = `
    <div class="token-logo">?</div>
    <div class="token-info">
      <div class="token-symbol">Looking up…</div>
      <div class="token-name">${addr.slice(0, 10)}…${addr.slice(-4)}</div>
    </div>`;
  list.appendChild(row);

  try {
    const c = new ethers.Contract(addr, ERC20_ABI, readProviderForEligibility());
    const [sym, dec, name] = await Promise.all([
      c.symbol(),
      c.decimals(),
      c.name().catch(() => "Custom token"),
    ]);
    if (seq !== _importSeq) return; // superseded by a newer lookup
    const t = {
      symbol: sym, name, address: addr, decimals: Number(dec),
      logoChar: (sym[0] || "?").toUpperCase(), isCustom: true
    };
    row.onclick = () => importCustomToken(t);
    row.querySelector(".token-symbol").textContent = sym;
    row.querySelector(".token-name").textContent   = name + " · tap to import";
  } catch {
    if (seq !== _importSeq) return;
    row.querySelector(".token-symbol").textContent = "Not an ERC-20";
    row.querySelector(".token-name").textContent   = "No token found at this address";
  }
}

function removeImportRow() {
  document.getElementById("token-import-row")?.remove();
}

// Look a token up by address in the current list and hand it to the shared
// wallet_watchAsset helper — keeps the row markup free of interpolated symbol
// strings (which could contain quotes on a hostile token).
function addTokenToWalletByAddr(addr) {
  const t = allTokens().find(x => x.address.toLowerCase() === addr.toLowerCase());
  if (t) addTokenToWallet(t);
}

function importCustomToken(t) {
  customTokens.push(t);
  saveCustomTokens();
  selectToken(t); // selects for the active side and closes the picker
}

function removeCustomToken(addr) {
  customTokens = customTokens.filter(t => t.address.toLowerCase() !== addr.toLowerCase());
  saveCustomTokens();
  renderTokenList();
  refreshPickerBalances();
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
  for (const t of allTokens()) {
    try {
      const bal = await tokenBalance(t);
      const el = document.querySelector(`.token-bal-right[data-addr="${t.address}"]`);
      if (el) el.textContent = fmt(bal, t.decimals, 4);
    } catch {}
  }
}

// Receive-side "Add to wallet" chip: visible only when the output token is a
// real (non-native) ERC-20 that EIP-747 wallet_watchAsset can track.
function updateAddOutWalletChip() {
  const btn = document.getElementById("add-out-wallet");
  if (!btn) return;
  if (tokenOut && !isNative(tokenOut)) {
    btn.textContent = `＋ Add ${tokenOut.symbol} to wallet`;
    btn.classList.remove("hidden");
  } else {
    btn.classList.add("hidden");
  }
}
function addOutTokenToWallet() {
  if (tokenOut && !isNative(tokenOut)) addTokenToWallet(tokenOut);
}

async function selectToken(token) {
  // You can't swap/LP a token against itself. If the picked token is already
  // on the OTHER side, flip the pair instead of filling both fields the same.
  const sameAddr = (a, b) => a && b &&
    (a.address || "").toLowerCase() === (b.address || "").toLowerCase();
  const setSym = (id, t) => {
    const el = document.getElementById(id);
    if (el) el.textContent = t ? t.symbol : "--";
  };
  if (pickerTarget === "in") {
    if (sameAddr(token, tokenOut)) { tokenOut = tokenIn; setSym("token-out-symbol", tokenOut); }
    tokenIn = token;
    setSym("token-in-symbol", tokenIn);
  } else {
    if (sameAddr(token, tokenIn)) { tokenIn = tokenOut; setSym("token-in-symbol", tokenIn); }
    tokenOut = token;
    setSym("token-out-symbol", tokenOut);
  }
  closeTokenPickerDirect();
  updateAddOutWalletChip();
  syncLiquidityLabels();
  if (mode === "liquidity") {
    await refreshLiquidity();
  } else {
    await checkEligibility();
    await refreshBalances();
    await recalcQuote();
  }
}

function flipTokens() {
  [tokenIn, tokenOut] = [tokenOut, tokenIn];
  document.getElementById("token-in-symbol").textContent  = tokenIn  ? tokenIn.symbol  : "--";
  document.getElementById("token-out-symbol").textContent = tokenOut ? tokenOut.symbol : "--";
  updateAddOutWalletChip();
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
    // Wrap/unwrap never touches a pool or the router, so no influence/nudge.
    if (isWrapPair()) {
      isEligiblePair = false;
      row.classList.add("hidden");
      panel.style.display = "none";
      if (window.renderPrizeIndicators) window.renderPrizeIndicators(false);
      return;
    }
    const registry = new ethers.Contract(ADDRESSES.EligibleTokenRegistry, ELIGIBLE_ABI, readProviderForEligibility());
    const eligible = await registry.isEligible(effAddr(tokenIn));
    isEligiblePair = eligible;
    // Game UI (influence toggle + live prize indicators) is wallet-gated —
    // don't reveal any game state until the user is connected.
    const showGame = eligible && !!userAddress;
    row.classList.toggle("hidden", !showGame);
    panel.style.display = showGame ? "block" : "none";
    if (window.renderPrizeIndicators) window.renderPrizeIndicators(showGame);
  } catch (e) {
    console.warn("checkEligibility:", e.message);
    row.classList.add("hidden");
    panel.style.display = "none";
  }
}

// Read-only queries go through the shared read provider (config.js): the
// connected wallet's own RPC once it is verified on the right chain — that
// endpoint isn't the shared public one, so polling can't trip a per-IP rate
// limit, which is what keeps pages responsive in Brave — otherwise the
// resilient public FallbackProvider. The _walletChainOk gate prevents a
// wrong-network wallet from serving stale/zero reads.
function readProviderForEligibility() {
  return sharedReadProvider();
}

// ─── Balances ─────────────────────────────────────────────────────────────────

// Cached pay-side balance (wei) so the quote path can flag over-balance
// inputs synchronously. null = unknown (disconnected / not yet read).
let _balInWei = null;

async function refreshBalances() {
  const balIn  = document.getElementById("bal-in");
  const balOut = document.getElementById("bal-out");

  if (!userAddress) {
    _balInWei = null;
    balIn.textContent  = "Balance: —";
    balOut.textContent = "Balance: —";
    return;
  }

  try {
    if (tokenIn) {
      const bal = await tokenBalance(tokenIn);
      _balInWei = bal;
      balIn.textContent = `Balance: ${fmt(bal, tokenIn.decimals, 4)}`;
    }
    if (tokenOut) {
      const bal = await tokenBalance(tokenOut);
      balOut.textContent = `Balance: ${fmt(bal, tokenOut.decimals, 4)}`;
    }
    // A landed balance can flip the button either way (insufficient ↔ Swap) —
    // re-evaluate if the user already has an amount typed.
    if (tokenIn && tokenOut && document.getElementById("amount-in")?.value) {
      recalcQuote();
    }
  } catch (e) {
    console.warn("refreshBalances:", e.message);
  }
}

// "Insufficient <SYM> balance" when the typed pay amount PLUS the 0.05%
// protocol fee exceeds the cached wallet balance; null otherwise. The fee is
// pulled ON TOP of amountIn for every non-wrap swap — native AND ERC20 — via
// the router's _collectProtocolFee (a separate transferFrom to the treasury),
// so the wallet needs amountIn + fee. Unknown balance (still loading) never blocks.
function overBalanceLabel() {
  if (!userAddress || !tokenIn || _balInWei === null) return null;
  const amt = document.getElementById("amount-in")?.value;
  if (!amt || parseFloat(amt) <= 0) return null;
  let needIn;
  try { needIn = ethers.utils.parseUnits(amt, tokenIn.decimals); } catch { return null; }
  if (!isWrapPair()) needIn = needIn.add(needIn.mul(5).div(10000)); // + 0.05% protocol fee (on top)
  return _balInWei.lt(needIn) ? `Insufficient ${tokenIn.symbol} balance` : null;
}

// ─── Quote ────────────────────────────────────────────────────────────────────

async function onAmountInChange() {
  lastEditedSide = "in";
  await recalcQuote();
  updateSwapUsd();
}
async function onAmountOutChange() {
  lastEditedSide = "out";
  await recalcQuote();
  updateSwapUsd();
}

// The pay/receive "≈ $" estimates are GONE, deliberately.
//
// They were priced off the live pools. On this testnet nothing arbitrages
// those pools, so USDC and USDT have drifted well off a dollar and the card
// was rendering "5 USDC ≈ $10.43" — technically what our own liquidity says,
// and useless to a human. Pinning stables back to $1 is worse: a constant next
// to a pool-derived number is how "1 USDT → $0.38 at 0.75% impact" happened in
// the first place.
//
// So the card now shows token amounts and the rate, which are exact, and says
// nothing it can't stand behind. USD survives where it IS anchored — the prize
// pot and analytics, both quoted at ETH_USD_PRICE.
//
// Kept as a no-op so the live tick and the input handlers don't need to know.
// If the pools are ever arbitraged level, restoring this is a small change.
async function updateSwapUsd() {}

// Keep the quote + USD live against pool moves (other wallets' trades). Re-quote
// to current reserves only when the user isn't mid-edit, so it never fights
// typing; the USD lines refresh every tick regardless (prices carry a 12s TTL).
function _swapLiveTick() {
  // Liquidity USD + withdrawal preview (cheap, cached) refresh every tick.
  updateLqUsd();
  renderRemovePreview();
  const a = document.activeElement;
  const editing = a && (a.id === "amount-in" || a.id === "amount-out");
  const inV  = document.getElementById("amount-in")?.value;
  const outV = document.getElementById("amount-out")?.value;
  const hasAmt = (inV && parseFloat(inV) > 0) || (outV && parseFloat(outV) > 0);
  if (!editing && tokenIn && tokenOut && hasAmt) {
    recalcQuote().then(updateSwapUsd).catch(() => {});
  } else {
    updateSwapUsd();
  }
}
// Only tick while the tab is visible — _swapLiveTick runs recalcQuote()/price
// reads, so a backgrounded swap tab would keep hitting the RPC. Refresh on focus.
setInterval(() => { if (!document.hidden) _swapLiveTick(); }, 4000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) _swapLiveTick(); });

// Active multi-hop route (effective addresses, e.g. [USDT, WETH, TIMBS]) or
// null when the trade is direct / a wrap. Set only by a successful path quote.
let swapRoute = null;

async function recalcQuote() {
  const infoBox = document.getElementById("swap-info");
  const swapBtn = document.getElementById("swap-btn");
  swapRoute = null;

  if (!tokenIn || !tokenOut) {
    infoBox.classList.add("hidden");
    return;
  }

  const inputIn  = document.getElementById("amount-in");
  const inputOut = document.getElementById("amount-out");
  const readProv = readProviderForEligibility();
  const router   = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_ABI, readProv);

  // ETH ↔ WETH is a 1:1 wrap/unwrap — mirror the amount, no pool quote.
  if (isWrapPair()) {
    const src = lastEditedSide === "in" ? inputIn : inputOut;
    const dst = lastEditedSide === "in" ? inputOut : inputIn;
    dst.value = src.value;
    infoBox.classList.add("hidden");
    if (!src.value || parseFloat(src.value) <= 0) { updateSwapButton("Enter an amount"); return; }
    if (!userAddress) { updateSwapButton("Connect wallet to swap"); return; }
    updateSwapButton(overBalanceLabel() || (isNative(tokenIn) ? "Wrap ETH → WETH" : "Unwrap WETH → ETH"));
    return;
  }

  try {
    const [reserveIn, reserveOut] = await router.getReserves(effAddr(tokenIn), effAddr(tokenOut));

    if (reserveIn.eq(0) || reserveOut.eq(0)) {
      // No direct pool — try bridging through WETH ([in, WETH, out]). On the
      // pre-path router the call reverts (function absent), a missing hop
      // pair reverts PairNotFound — either way we land in the same
      // "No liquidity" state this branch always showed.
      if (await quoteViaWeth(router, inputIn, inputOut, infoBox)) return;
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
      // getAmountOut reverts if the pool can't source the trade (amount ≥
      // reserve). Surface that as insufficient liquidity, not a silent catch.
      let amountOutWei;
      try { amountOutWei = await router.getAmountOut(amountInWei, reserveIn, reserveOut); }
      catch { inputOut.value = ""; infoBox.classList.add("hidden"); updateSwapButton("Insufficient liquidity"); return; }
      inputOut.value = trimAmount(ethers.utils.formatUnits(amountOutWei, tokenOut.decimals));
      // A quote that rounds below display precision (extreme pool ratio) isn't
      // a usable trade — don't leave an enabled Swap sitting on a "0" field.
      if (!inputOut.value || parseFloat(inputOut.value) === 0) {
        infoBox.classList.add("hidden");
        updateSwapButton("Amount too small for this pool");
        return;
      }
      renderSwapInfo(amountInWei, amountOutWei, spotOf(reserveIn, reserveOut));
    } else {
      const amtOut = inputOut.value;
      if (!amtOut || parseFloat(amtOut) <= 0) {
        inputIn.value = "";
        infoBox.classList.add("hidden");
        updateSwapButton("Enter an amount");
        return;
      }
      const amountOutWei = ethers.utils.parseUnits(amtOut, tokenOut.decimals);
      // getAmountIn reverts when the requested output ≥ the pool's reserve —
      // i.e. the pool simply doesn't hold that much of the receive token.
      let amountInWei;
      try { amountInWei = await router.getAmountIn(amountOutWei, reserveIn, reserveOut); }
      catch { inputIn.value = ""; infoBox.classList.add("hidden"); updateSwapButton("Insufficient liquidity"); return; }
      inputIn.value = trimAmount(ethers.utils.formatUnits(amountInWei, tokenIn.decimals));
      if (!inputIn.value || parseFloat(inputIn.value) === 0) {
        infoBox.classList.add("hidden");
        updateSwapButton("Amount too small for this pool");
        return;
      }
      renderSwapInfo(amountInWei, amountOutWei, spotOf(reserveIn, reserveOut));
    }

    updateSwapButton(overBalanceLabel() || (userAddress ? "Swap" : "Connect wallet to swap"));

  } catch (e) {
    console.warn("recalcQuote:", e.message);
    infoBox.classList.add("hidden");
    updateSwapButton("Enter an amount");
  }
}

// Spot price (tokenOut per tokenIn) of the direct pool's reserves.
function spotOf(reserveIn, reserveOut) {
  return parseFloat(ethers.utils.formatUnits(reserveOut, tokenOut.decimals)) /
         parseFloat(ethers.utils.formatUnits(reserveIn, tokenIn.decimals));
}

// Combined spot across a 2-hop WETH bridge: (WETH per tokenIn) × (tokenOut per WETH).
async function pathSpot(router, path) {
  const [aIn, aOut] = await router.getReserves(path[0], path[1]);
  const [bIn, bOut] = await router.getReserves(path[1], path[2]);
  const hop1 = parseFloat(ethers.utils.formatUnits(aOut, 18)) /
               parseFloat(ethers.utils.formatUnits(aIn, tokenIn.decimals));
  const hop2 = parseFloat(ethers.utils.formatUnits(bOut, tokenOut.decimals)) /
               parseFloat(ethers.utils.formatUnits(bIn, 18));
  return hop1 * hop2;
}

// Quote [in, WETH, out] when no direct pool exists. Returns true if it OWNED
// the quote (fields/button set — route usable or amount-stage message shown);
// false means fall back to the plain "No liquidity for this pair" state.
async function quoteViaWeth(router, inputIn, inputOut, infoBox) {
  const effIn = effAddr(tokenIn), effOut = effAddr(tokenOut);
  // A WETH leg means direct was the only possible route; native legs stay
  // direct-only in v1 (the path functions are token-in/token-out).
  if (effIn === ADDRESSES.WETH || effOut === ADDRESSES.WETH) return false;
  if (isNative(tokenIn) || isNative(tokenOut)) return false;
  const path = [effIn, ADDRESSES.WETH, effOut];
  try {
    let amountInWei, amountOutWei;
    if (lastEditedSide === "in") {
      const amtIn = inputIn.value;
      if (!amtIn || parseFloat(amtIn) <= 0) {
        inputOut.value = ""; infoBox.classList.add("hidden");
        updateSwapButton("Enter an amount"); return true;
      }
      amountInWei = ethers.utils.parseUnits(amtIn, tokenIn.decimals);
      const amounts = await router.getAmountsOutPath(amountInWei, path);
      amountOutWei = amounts[amounts.length - 1];
      inputOut.value = trimAmount(ethers.utils.formatUnits(amountOutWei, tokenOut.decimals));
      if (!inputOut.value || parseFloat(inputOut.value) === 0) {
        infoBox.classList.add("hidden");
        updateSwapButton("Amount too small for this route"); return true;
      }
    } else {
      const amtOut = inputOut.value;
      if (!amtOut || parseFloat(amtOut) <= 0) {
        inputIn.value = ""; infoBox.classList.add("hidden");
        updateSwapButton("Enter an amount"); return true;
      }
      amountOutWei = ethers.utils.parseUnits(amtOut, tokenOut.decimals);
      const amounts = await router.getAmountsInPath(amountOutWei, path);
      amountInWei = amounts[0];
      inputIn.value = trimAmount(ethers.utils.formatUnits(amountInWei, tokenIn.decimals));
      if (!inputIn.value || parseFloat(inputIn.value) === 0) {
        infoBox.classList.add("hidden");
        updateSwapButton("Amount too small for this route"); return true;
      }
    }
    renderSwapInfo(amountInWei, amountOutWei, await pathSpot(router, path), " · via WETH");
    swapRoute = path;
    updateSwapButton(overBalanceLabel() || (userAddress ? "Swap via WETH" : "Connect wallet to swap"));
    return true;
  } catch {
    // Router predates path support, a hop pool is missing, or a hop can't
    // source the trade — all read as "no route" here.
    return false;
  }
}

function renderSwapInfo(amountInWei, amountOutWei, spotPrice, viaLabel = "") {
  const infoBox = document.getElementById("swap-info");
  infoBox.classList.remove("hidden");

  const rate = parseFloat(ethers.utils.formatUnits(amountOutWei, tokenOut.decimals)) /
               parseFloat(ethers.utils.formatUnits(amountInWei, tokenIn.decimals));
  document.getElementById("info-rate").textContent =
    `1 ${tokenIn.symbol} = ${rate.toFixed(6)} ${tokenOut.symbol}${viaLabel}`;

  // Price impact estimate: compare execution price to current spot price
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

  renderRouteDivergence(rate, impact);
}

// How far this route's price sits from the reference oracle, beyond what fee +
// impact explain.
//
// The oracle prices every token through its WETH pool against one anchor
// (config.js). A swap does NOT have to take that path — the router picks the
// best fill, which is often a direct pair. When a direct pool and the WETH path
// disagree, that gap is an arbitrage sitting in our own liquidity.
//
// This outlived the "≈ $" figures it was originally written to explain: those
// are gone, but the divergence they exposed is real and still worth naming, so
// the note now compares this route against the WETH route directly.
//
// Expected: a route should come in BELOW reference by roughly (impact + fee).
// Anything past DIVERGENCE_TOLERANCE_PCT beyond that is pools disagreeing.
const DIVERGENCE_TOLERANCE_PCT = 5;

async function renderRouteDivergence(rate, impactPct) {
  const el = document.getElementById("info-divergence");
  if (!el) return;
  const inTok = tokenIn, outTok = tokenOut;
  el.classList.add("hidden");
  try {
    const [pIn, pOut] = await Promise.all([
      usdPriceOf(effAddr(inTok)), usdPriceOf(effAddr(outTok))
    ]);
    // A later edit swapped the pair out from under this resolution — drop it.
    if (inTok !== tokenIn || outTok !== tokenOut) return;
    if (!pIn || !pOut) return;                       // unpriceable, say nothing

    const referenceRate = pIn / pOut;                // out per in, at reference
    if (!isFinite(referenceRate) || referenceRate <= 0) return;

    const divergence = (rate / referenceRate - 1) * 100;
    const expected   = -(impactPct + 0.05);          // impact + the 0.05% fee
    const excess     = divergence - expected;
    if (Math.abs(excess) < DIVERGENCE_TOLERANCE_PCT) return;

    const better = excess > 0;
    el.textContent = better
      ? `This route pays ${Math.abs(excess).toFixed(0)}% MORE than the same trade ` +
        `routed ${inTok.symbol}→WETH→${outTok.symbol}. Our own pools disagree on ` +
        `this pair — good for you here, but it means one of them is mispriced.`
      : `This route pays ${Math.abs(excess).toFixed(0)}% LESS than the same trade ` +
        `routed ${inTok.symbol}→WETH→${outTok.symbol}. A better fill may exist ` +
        `through another pool.`;
    el.className = "info-note" + (better ? " good" : " warn");
  } catch {
    /* pricing is best-effort — never block a quote on it */
  }
}

function updateSwapButton(text) {
  const btn = document.getElementById("swap-btn");
  btn.textContent = text;
  btn.disabled = !userAddress || !tokenIn || !tokenOut ||
                 text === "Enter an amount" || text === "No liquidity for this pair" ||
                 text.startsWith("Insufficient") || text === "Amount too small for this pool" ||
                 text === "Amount too small for this route";
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

// Thin testnet pools move fast (small reserves + the game constantly nudging
// them), so a $20 trade can show ~10% price impact and the pool can shift more
// than a few % between the submit-time re-quote and mining. A 2.5% ceiling made
// those swaps unclearable — every attempt reverted InsufficientOutputAmount.
// 15% gives real headroom on testnet while still capping a fat-finger.
const MAX_SLIPPAGE_PCT = 15;
document.getElementById("slip-custom")?.addEventListener("input", (e) => {
  let val = parseFloat(e.target.value);
  if (val > 0) {
    if (val > MAX_SLIPPAGE_PCT) { val = MAX_SLIPPAGE_PCT; e.target.value = String(MAX_SLIPPAGE_PCT); }
    slippagePct = val;
    document.querySelectorAll(".slip-btn").forEach(b => b.classList.remove("slip-active"));
    recalcQuote();
  }
});

// ─── Swap Execution ───────────────────────────────────────────────────────────

// Walk a wallet-wrapped error for a 4-byte revert selector (shared by
// handleSwap and handleAddLiquidity — wallets nest the data differently).
function revertSel(err) {
  const d = err?.data?.originalError?.data ?? err?.error?.data?.data ??
            err?.error?.data ?? err?.data;
  const hex = typeof d === "string" ? d
    : (typeof d?.data === "string" ? d.data : null);
  if (hex && hex.startsWith("0x") && hex.length >= 10) return hex.slice(0, 10).toLowerCase();
  // No message-text fallback: it false-positived twice in production (the
  // wallet address, then the 8-hex maxPriorityFeePerGas). Structured data
  // fields only; diagnoseRevert() recovers anything the wallet strips.
  return null;
}

// Router swap-path custom errors → human messages. Some in-app wallets
// strip custom-error data entirely (observed: data "0x"), so the empty-data
// case gets a price-moved fallback in the catch below.
const SWAP_REVERTS = {
  // Router
  "0xd28d3eb5": "Price moved: the pool can no longer deliver your minimum output. Quote refreshed — try again.", // InsufficientOutputAmount(uint256,uint256)
  "0x3eb9e86a": "Sent ETH doesn't cover amount + 0.05% protocol fee. Refresh and try again.",                    // InsufficientETHSent
  "0x1f2a2005": "Swap amount is zero.",                                                                          // ZeroAmount
  "0x0dc08fa2": "Router misconfigured (WETH unset) — owner action needed.",                                      // WethNotSet
  "0x4db171d4": "This pair has no pool yet — create it via Add Liquidity.",                                      // PairNotFound
  "0xf80dbaea": "This quote's deadline passed — refresh and try again.",                                         // Expired
  "0xf562b5a0": "The router is paused — owner action needed.",                                                   // RouterPaused
  "0xbb55fd27": "The pool has no liquidity for this pair.",                                                      // InsufficientLiquidity
  "0xf0c49d44": "ETH refund to your wallet failed — is your wallet a contract?",                                 // RefundFailed
  "0xb12d13eb": "ETH transfer to your wallet failed.",                                                           // ETHTransferFailed
  // Pair
  "0x42301c23": "Pool rejected the output amount (pair-level).",                                                 // InsufficientOutputAmount()
  "0x098fb561": "Pool rejected the input amount (pair-level).",                                                  // InsufficientInputAmount
  "0x5327d568": "Pool invariant check failed — reserves moved mid-swap; try again.",                             // KInvariantViolated
  "0x659a0b22": "Invalid swap recipient.",                                                                       // InvalidTo
  "0x20db8267": "No valid route between these tokens.",                                                          // InvalidPath
};

// ── Uncensored revert diagnosis ───────────────────────────────────────────────
// Some in-app wallets strip custom-error revert data to "0x", leaving
// estimation failures unexplainable. ethers embeds the exact transaction it
// tried to estimate on the error — replay it as a raw eth_call through the
// PUBLIC RPC, which returns the revert data uncensored, and decode it.
async function diagnoseRevert(err) {
  // Fast path: some wallets/nodes strip the revert DATA but still surface the
  // reason as a plain string. Catch the common balance case here so it isn't
  // mislabeled as a price move (the 0.05% fee is charged on top of amountIn).
  const reason = (err?.reason || err?.error?.message || err?.data?.message || "").toLowerCase();
  if (reason.includes("exceeds balance")) {
    return `Not enough ${tokenIn?.symbol || "input token"} — this amount plus the 0.05% fee is more than your balance. Lower it (or tap Max).`;
  }
  const tx = err?.transaction;
  if (!tx || !tx.to || !tx.data) return null;
  try {
    await readProviderForEligibility().call({
      from: tx.from, to: tx.to, data: tx.data, value: tx.value || undefined
    });
    return null; // call succeeded on the public node — transient wallet issue
  } catch (callErr) {
    const d = callErr?.error?.data ?? callErr?.data ?? null;
    const hex = typeof d === "string" ? d : (typeof d?.data === "string" ? d.data : null);
    if (!hex || hex === "0x") return null;
    DebugHub.logError("handleSwap.revertData", new Error("revert data " + hex.slice(0, 138)));
    if (hex.startsWith("0x08c379a0")) {
      // Standard Error(string): offset(32) + length(32) + bytes
      try {
        const len = parseInt(hex.slice(10 + 64, 10 + 128), 16);
        const strHex = hex.slice(10 + 128, 10 + 128 + len * 2);
        let out = "";
        for (let i = 0; i < strHex.length; i += 2) out += String.fromCharCode(parseInt(strHex.slice(i, i + 2), 16));
        return out;
      } catch { return null; }
    }
    return SWAP_REVERTS[hex.slice(0, 10).toLowerCase()] || ("Contract reverted: " + hex.slice(0, 10));
  }
}

async function handleSwap() {
  if (!userAddress || !tokenIn || !tokenOut) return;

  const amtIn = document.getElementById("amount-in").value;
  if (!amtIn || parseFloat(amtIn) <= 0) return;

  const btn = document.getElementById("swap-btn");
  const originalText = btn.textContent;
  let simulatedOk = false; // set once the public-RPC gas estimate passes

  try {
    const amountInWei = ethers.utils.parseUnits(amtIn, tokenIn.decimals);

    // ── Pre-flight balance check ──────────────────────────────────────────
    // Wallets mask balance reverts as opaque -32603 / empty-data estimation
    // failures (observed live: 'swap 2000 ETH' and an ERC20-WETH swap with
    // zero WETH). Check here and say it in a sentence instead.
    const needIn = !isWrapPair()
      ? amountInWei.add(amountInWei.mul(5).div(10000)) // + 0.05% protocol fee (on top, native + ERC20)
      : amountInWei;
    const balIn = await tokenBalance(tokenIn);
    if (balIn.lt(needIn)) {
      alert(
        `Insufficient ${tokenIn.symbol}: you have ` +
        `${fmt(balIn, tokenIn.decimals, 6)}, this swap needs ` +
        `${fmt(needIn, tokenIn.decimals, 6)}` +
        (isNative(tokenIn) ? " plus gas." : ".")
      );
      updateSwapButton(originalText);
      return;
    }

    // Native ETH never needs an ERC20 approval; wrap pairs skip it too since
    // WETH.deposit/withdraw act on the caller's own balance.
    if (!isNative(tokenIn) && !isWrapPair()) {
      const tokenContract = await writeContract(tokenIn.address, ERC20_ABI);
      const allowance = await tokenContract.allowance(userAddress, ADDRESSES.TimbSwapRouter);
      if (allowance.lt(amountInWei)) {
        btn.disabled = true;
        btn.textContent = "Approving…";
        DebugHub.logCheckpoint("Approve Requested", "pass");

        const gas = await getGasParams();
        const nonce = await getPendingNonce();
        const approveTx = await tokenContract.approve(ADDRESSES.TimbSwapRouter, ethers.constants.MaxUint256, { ...gas, nonce });

        DebugHub.logCheckpoint("Approve Submitted", "pass");
        await confirmTx(approveTx);
        DebugHub.logCheckpoint("Approve Confirmed", "pass");
      }
    }

    // Execute swap
    btn.textContent = "Swapping…";
    DebugHub.logCheckpoint("Swap Requested", "pass");

    const router = await writeContract(ADDRESSES.TimbSwapRouter, ROUTER_ABI);

    // Re-quote from LIVE reserves at submit time. The on-screen quote can be
    // minutes stale, and a minOut derived from it reverts with
    // InsufficientOutputAmount on every retry (observed live: a stale quote
    // demanded 1980 TIMBS when the pool could only deliver ~1892). The
    // display is updated to match what we actually ask the router for.
    let minOut = ethers.constants.Zero;
    if (!isWrapPair()) {
      const reader = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_ABI, readProviderForEligibility());
      let freshOut;
      if (swapRoute) {
        const amounts = await reader.getAmountsOutPath(amountInWei, swapRoute);
        freshOut = amounts[amounts.length - 1];
      } else {
        const [rIn, rOut] = await reader.getReserves(effAddr(tokenIn), effAddr(tokenOut));
        // getAmountOut reverts ZeroAmount() (0x1f2a2005) on a zero input or an
        // empty pool. Unguarded, that surfaced to the user as a raw ethers
        // CALL_EXCEPTION blob — say what's actually wrong instead.
        if (amountInWei.isZero()) throw new Error("Enter an amount to swap.");
        if (rIn.isZero() || rOut.isZero()) {
          throw new Error("This pair has no liquidity yet — add liquidity before swapping.");
        }
        freshOut = await reader.getAmountOut(amountInWei, rIn, rOut);
      }
      minOut = freshOut.mul(Math.floor((100 - slippagePct) * 100)).div(10000);
      document.getElementById("amount-out").value =
        trimAmount(ethers.utils.formatUnits(freshOut, tokenOut.decimals));
    }
    const deadline = Math.floor(Date.now() / 1000) + 1200; // 20 min
    const influencePrize = isEligiblePair && document.getElementById("influence-toggle").checked;

    const gas = await getGasParams();
    const nonce = await getPendingNonce();

    // Gas is estimated on the PUBLIC RPC and passed as an explicit gasLimit,
    // so the wallet's own estimator is never consulted. Observed live: an
    // in-app wallet whose internal node rejected estimation for a
    // transaction that replays cleanly on the canonical chain — with a
    // provided gasLimit the wallet just signs. If the PUBLIC estimate
    // reverts, that's a real revert with uncensored data → named alert.
    let method, args, value;
    if (isWrapPair()) {
      method = isNative(tokenIn) ? "deposit" : "withdraw";
      args   = isNative(tokenIn) ? [] : [amountInWei];
      value  = isNative(tokenIn) ? amountInWei : undefined;
    } else if (isNative(tokenIn)) {
      // ETH → token: msg.value must cover amountIn plus the 0.05% protocol fee.
      const fee = amountInWei.mul(5).div(10000);
      method = "swapExactETHForTokens";
      args   = [amountInWei, minOut, tokenOut.address, userAddress, deadline, influencePrize];
      value  = amountInWei.add(fee);
    } else if (isNative(tokenOut)) {
      method = "swapExactTokensForETH";
      args   = [amountInWei, minOut, tokenIn.address, userAddress, deadline, influencePrize];
    } else if (swapRoute) {
      // No direct pool — route through WETH. Fee + nudge stay on the input
      // token, so the game/eligibility semantics match a direct swap.
      method = "swapExactTokensForTokensPath";
      args   = [amountInWei, minOut, swapRoute, userAddress, deadline, influencePrize];
    } else {
      method = "swapExactTokensForTokens";
      args   = [amountInWei, minOut, tokenIn.address, tokenOut.address, userAddress, deadline, influencePrize];
    }

    const target = isWrapPair()
      ? await writeContract(ADDRESSES.WETH, WETH_ABI)
      : router;
    if (isWrapPair()) btn.textContent = isNative(tokenIn) ? "Wrapping…" : "Unwrapping…";

    const estReq = await target.populateTransaction[method](...args, value ? { value } : {});
    estReq.from = userAddress;
    const gasLimit = (await readProviderForEligibility().estimateGas(estReq)).mul(150).div(100);
    // The public RPC simulated this exact transaction successfully — from
    // here on, any failure is the WALLET (broadcast/signing), not the tx.
    simulatedOk = true;

    const overrides = { ...gas, nonce, gasLimit };
    if (value) overrides.value = value;
    const tx = await target[method](...args, overrides);

    DebugHub.logCheckpoint("Swap Submitted", "pass");
    // Confirm via public RPC (confirmTx sets err.receipt on an on-chain
    // revert, so the catch below still classifies slippage reverts correctly).
    await confirmTx(tx);
    DebugHub.logCheckpoint("Swap Confirmed", "pass");

    document.getElementById("amount-in").value = "";
    document.getElementById("amount-out").value = "";
    await refreshBalances();
    btn.textContent = "Swap confirmed ✓";
    btn.style.background = "#14f195";
    // Show view tx link
    const txLink = document.getElementById("swap-tx-link");
    if (txLink) {
      txLink.href = `https://arbiscan.io/tx/${tx.hash}`;
      txLink.classList.remove("hidden");
    }
    setTimeout(() => {
      updateSwapButton("Swap");
      btn.style.background = "";
      if (txLink) txLink.classList.add("hidden");
    }, 8000);

  } catch (err) {
    const msg = err?.reason || err?.message || String(err);
    console.error("Swap failed:", msg);
    const sel = revertSel(err);
    // Log a FLAT, always-serializable summary first — a raw ethers error is a
    // deep object with circular refs (err.transaction/err.error), and the
    // DebugHub SDK dropped it silently when it couldn't serialize, so swap
    // failures never reached the dashboard. This plain-string line always does.
    const _sum = `code=${err?.code ?? "-"} sel=${sel ?? "-"} reason=${(msg || "").slice(0, 180)}`;
    DebugHub.logError("handleSwap.summary", new Error(_sum));
    if (sel) DebugHub.logError("handleSwap.revertSelector", new Error("selector " + sel));
    try { DebugHub.logError("handleSwap", err); } catch (_) { /* raw err unserializable — summary already logged */ }
    DebugHub.logCheckpoint("Swap Failed", "fail");
    const code = err?.code;
    const userRejected = code === 4001 || code === "ACTION_REJECTED";
    // Did the tx actually reach the chain? A receipt / tx hash means it was
    // broadcast and MINED, then reverted — an on-chain failure (slippage on a
    // moving pool), NOT a wallet broadcast defect. Only a failure with no hash
    // is wallet-side.
    const minedHash    = err?.transactionHash || err?.receipt?.transactionHash || err?.transaction?.hash;
    const minedReverted = !!minedHash || !!err?.receipt;
    if (userRejected) {
      // Not an error — the user declined in their wallet.
    } else if (SWAP_REVERTS[sel]) {
      // A decoded protocol revert is authoritative regardless of mining state.
      alert(SWAP_REVERTS[sel]);
      onAmountInChange();
    } else if (minedReverted) {
      // Broadcast + mined, then reverted. The trade executed and failed —
      // almost always slippage: the pool moved between the quote and mining
      // (thin/fast pool, high price impact). Do NOT blame the wallet.
      DebugHub.logError("handleSwap.onchainRevert", new Error("mined & reverted: " + code + " tx " + minedHash));
      const diagnosed = await diagnoseRevert(err);
      alert(diagnosed ||
        "The swap reached the chain but reverted — the pool price moved between " +
        "the quote and execution (slippage on a thin, fast-moving pool). Raise " +
        "the slippage tolerance (⚙, up to 15%) or reduce the size, then try again. Quote refreshed."
      );
      onAmountInChange();
    } else if (simulatedOk) {
      // Simulated OK on the public RPC and never reached the chain (no hash) →
      // the failure is inside the wallet (broadcast/signing), not the trade.
      // Observed live: a wallet returning -32603 here while the identical
      // swap confirmed instantly in a different wallet. See DebugHub §9.
      DebugHub.logError("handleSwap.walletBroadcast", new Error("code " + code + " after successful public simulation"));
      alert(
        "Your wallet couldn't broadcast this swap, but it simulates fine " +
        "on-chain — so this is a wallet-side issue, not the trade. Fastest " +
        "fix (confirmed to work): open your wallet's site-permissions for " +
        "this site, disconnect this account, then reconnect it — that clears " +
        "the stuck wallet state. Failing that, switch the wallet's network " +
        "away and back, or use a different account/wallet. (The same swap " +
        "succeeds in other accounts.)"
      );
    } else if (/UNPREDICTABLE_GAS_LIMIT/.test(code || "") || code === -32603) {
      // Failed before our own simulation — recover the real revert reason
      // by replaying the exact call through the public RPC.
      const diagnosed = await diagnoseRevert(err);
      if (diagnosed) {
        alert(diagnosed);
      } else {
        alert("The pool price moved since this quote. The quote has been refreshed — review and try again.");
      }
      onAmountInChange();
    }
    btn.textContent = userRejected ? "Swap cancelled" : "Swap failed — try again";
    btn.style.background = "rgba(239,68,68,0.15)";
    btn.style.color = "#ef4444";
    btn.style.borderColor = "#ef4444";
    setTimeout(() => {
      updateSwapButton(originalText);
      btn.style.background = "";
      btn.style.color = "";
      btn.style.borderColor = "";
    }, 3000);
  } finally {
    btn.disabled = false;
  }
}

// ─── Liquidity (add / remove) ─────────────────────────────────────────────────

function setMode(m) {
  mode = m;
  document.getElementById("tab-swap").classList.toggle("active", m === "swap");
  document.getElementById("tab-liq").classList.toggle("active", m === "liquidity");
  document.getElementById("swap-mode").classList.toggle("hidden", m !== "swap");
  document.getElementById("liquidity-mode").classList.toggle("hidden", m !== "liquidity");
  const title = document.getElementById("swap-title");
  if (title) title.textContent = m === "liquidity" ? "Liquidity" : "Swap";
  if (m === "liquidity") {
    // The influence / prize panel is swap-only.
    const prize = document.getElementById("prize-panel");
    if (prize) prize.style.display = "none";
    refreshLiquidity(); // re-syncs lq-symbol-a/b from the shared pair
  } else {
    // Swap and Liquidity SHARE tokenIn/tokenOut. The other tab may have
    // changed the pair while we were away, so re-sync the swap labels to the
    // shared truth (otherwise the buttons show a stale pair while the quote,
    // fee, and balances run on the real one) and re-quote.
    document.getElementById("token-in-symbol").textContent  = tokenIn  ? tokenIn.symbol  : "--";
    document.getElementById("token-out-symbol").textContent = tokenOut ? tokenOut.symbol : "--";
    updateAddOutWalletChip();
    checkEligibility();
    refreshBalances();
    recalcQuote();
  }
}

function syncLiquidityLabels() {
  const a = document.getElementById("lq-symbol-a");
  const b = document.getElementById("lq-symbol-b");
  if (a) a.textContent = tokenIn  ? tokenIn.symbol  : "--";
  if (b) b.textContent = tokenOut ? tokenOut.symbol : "--";
}

async function refreshLiquidity() {
  syncLiquidityLabels();
  const balA = document.getElementById("lq-bal-a");
  const balB = document.getElementById("lq-bal-b");
  const ratioEl = document.getElementById("lq-ratio");
  const lpEl = document.getElementById("lq-lp-bal");
  const lpRemoveEl = document.getElementById("lq-remove-bal");
  const wdEl = document.getElementById("lq-withdrawable");
  const read = readProviderForEligibility();

  // Balances — cache the raw wei so the button can flag "Insufficient balance"
  // instantly on input, and clear the cache on disconnect / read failure so a
  // stale value never blocks a valid add.
  if (userAddress && tokenIn) {
    try { lqBalAWei = await tokenBalance(tokenIn); balA.textContent = `Balance: ${fmt(lqBalAWei, tokenIn.decimals, 4)}`; }
    catch { lqBalAWei = null; balA.textContent = "Balance: —"; }
  } else { lqBalAWei = null; balA.textContent = "Balance: —"; }
  if (userAddress && tokenOut) {
    try { lqBalBWei = await tokenBalance(tokenOut); balB.textContent = `Balance: ${fmt(lqBalBWei, tokenOut.decimals, 4)}`; }
    catch { lqBalBWei = null; balB.textContent = "Balance: —"; }
  } else { lqBalBWei = null; balB.textContent = "Balance: —"; }

  // Liquidity pools hold WETH, not native ETH — pick WETH for LP positions.
  if (isNative(tokenIn) || isNative(tokenOut)) {
    ratioEl.textContent = "Use WETH (wrap ETH on the Swap tab)";
    lpBalanceWei = null; lpEl.textContent = "—"; lpRemoveEl.textContent = "LP: —";
    if (wdEl) wdEl.textContent = "—";
    updateLqButtons();
    return;
  }

  if (tokenIn && tokenOut) {
    // Pool ratio — keep the reserves around for the withdrawable preview below.
    let rA = null, rB = null;
    try {
      const router = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_ABI, read);
      [rA, rB] = await router.getReserves(tokenIn.address, tokenOut.address);
      if (rA.gt(0) && rB.gt(0)) {
        const ratio = parseFloat(ethers.utils.formatUnits(rB, tokenOut.decimals)) /
                      parseFloat(ethers.utils.formatUnits(rA, tokenIn.decimals));
        ratioEl.textContent = `1 ${tokenIn.symbol} = ${ratio.toFixed(6)} ${tokenOut.symbol}`;
      } else {
        ratioEl.textContent = "New pool — you set the price";
      }
    } catch { ratioEl.textContent = "—"; }

    // LP pair + balance + withdrawable preview. A position is withdrawable
    // whenever the wallet holds LP tokens for this pair — show exactly what
    // removeLiquidity(100%) would return right now: lpBal × reserve ÷ supply,
    // the pair contract's own redemption math.
    try {
      const factory = new ethers.Contract(ADDRESSES.TimbSwapFactory, FACTORY_ABI, read);
      lpPairAddress = await factory.getPairAddress(tokenIn.address, tokenOut.address);
      const pairExists = lpPairAddress && lpPairAddress !== ethers.constants.AddressZero;
      if (pairExists && userAddress) {
        const lp = new ethers.Contract(lpPairAddress, ERC20_ABI, read);
        lpBalanceWei = await lp.balanceOf(userAddress);
        const s = fmtLp(lpBalanceWei);
        lpEl.textContent = s;
        lpRemoveEl.textContent = "LP: " + s;
        if (wdEl) {
          if (lpBalanceWei.isZero()) {
            wdEl.textContent = "No position";
            lpReserveA = lpReserveB = lpTotalSupply = null;
          } else if (rA && rB && rA.gt(0) && rB.gt(0)) {
            const supply = await lp.totalSupply();
            lpReserveA = rA; lpReserveB = rB; lpTotalSupply = supply; // for the slider preview
            const outA = lpBalanceWei.mul(rA).div(supply);
            const outB = lpBalanceWei.mul(rB).div(supply);
            wdEl.textContent =
              `✓ ≈ ${fmt(outA, tokenIn.decimals, 4)} ${tokenIn.symbol} + ` +
              `${fmt(outB, tokenOut.decimals, 4)} ${tokenOut.symbol}`;
          } else {
            wdEl.textContent = "✓ Yes";
            lpReserveA = lpReserveB = lpTotalSupply = null;
          }
        }
      } else {
        lpBalanceWei = null; lpEl.textContent = "—"; lpRemoveEl.textContent = "LP: —";
        lpReserveA = lpReserveB = lpTotalSupply = null;
        if (wdEl) wdEl.textContent = !pairExists ? "No pool here yet — be the first." : "Connect wallet";
      }
    } catch {
      lpBalanceWei = null; lpEl.textContent = "—"; lpRemoveEl.textContent = "LP: —";
      lpReserveA = lpReserveB = lpTotalSupply = null;
      if (wdEl) wdEl.textContent = "—";
    }
  }
  renderRemovePreview(); // reflect the new pool state at the current slider %
  updateLqButtons();
}

// Mirror the counterpart amount from the pool ratio (no-op for a brand-new pool).
async function _mirrorLq(fromId, toId, fromTok, toTok, invert) {
  const v = document.getElementById(fromId).value;
  if (!fromTok || !toTok || !v || parseFloat(v) <= 0) { updateLqButtons(); return; }
  try {
    const router = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_ABI, readProviderForEligibility());
    const [rA, rB] = await router.getReserves(tokenIn.address, tokenOut.address);
    const [rFrom, rTo] = invert ? [rB, rA] : [rA, rB];
    if (rFrom.gt(0) && rTo.gt(0)) {
      const amt = ethers.utils.parseUnits(v, fromTok.decimals).mul(rTo).div(rFrom);
      document.getElementById(toId).value = trimAmount(ethers.utils.formatUnits(amt, toTok.decimals));
    }
  } catch {}
  updateLqButtons();
}
async function onLqAmountA() { await _mirrorLq("lq-amount-a", "lq-amount-b", tokenIn, tokenOut, false); updateLqUsd(); }
async function onLqAmountB() { await _mirrorLq("lq-amount-b", "lq-amount-a", tokenOut, tokenIn, true); updateLqUsd(); }

// Deposit-amount "≈ $" estimates, removed for the same reason as the swap
// fields above. No-op retained so callers stay unchanged.
async function updateLqUsd() {}

// True when `amountStr` parses to more than the wallet holds. Returns false
// on anything unknown (null balance, empty/partial input, over-precise
// decimals) so it never blocks a genuinely valid amount.
function overBalance(amountStr, token, balWei) {
  if (!token || !balWei) return false;
  if (!amountStr || parseFloat(amountStr) <= 0) return false;
  try {
    return ethers.utils.parseUnits(amountStr, token.decimals).gt(balWei);
  } catch { return false; }
}

function updateLqButtons() {
  const addBtn = document.getElementById("lq-add-btn");
  const remBtn = document.getElementById("lq-remove-btn");
  if (!addBtn || !remBtn) return;

  const aStr = document.getElementById("lq-amount-a").value;
  const bStr = document.getElementById("lq-amount-b").value;
  const a = parseFloat(aStr);
  const b = parseFloat(bStr);
  // Over-balance check: parse each input to wei against the cached balance.
  // A null cache (unknown / read failed / disconnected) never blocks. This
  // re-runs on every keystroke and after refreshLiquidity, so the state
  // clears itself when the amount is lowered or the balance later lands.
  const over = overBalance(aStr, tokenIn, lqBalAWei) ? tokenIn
             : overBalance(bStr, tokenOut, lqBalBWei) ? tokenOut
             : null;
  if (!userAddress)               { addBtn.textContent = "Connect wallet to add liquidity"; addBtn.disabled = true; }
  else if (!tokenIn || !tokenOut) { addBtn.textContent = "Select tokens"; addBtn.disabled = true; }
  else if (isNative(tokenIn) || isNative(tokenOut)) { addBtn.textContent = "Use WETH for liquidity"; addBtn.disabled = true; }
  else if (!a || a <= 0 || !b || b <= 0) { addBtn.textContent = "Enter amounts"; addBtn.disabled = true; }
  else if (over) { addBtn.textContent = `Insufficient ${over.symbol} balance`; addBtn.disabled = true; }
  else { addBtn.textContent = `Add ${tokenIn.symbol} + ${tokenOut.symbol}`; addBtn.disabled = false; }

  const hasLp = lpBalanceWei && !lpBalanceWei.isZero();
  remBtn.disabled = !userAddress || !hasLp || removePct <= 0;
  remBtn.textContent = (hasLp && removePct > 0) ? `Remove ${removePct}%` : "Remove liquidity";

  // No LP position for the current pair (none owned, wallet disconnected, or
  // the selected asset pair changed to one you're not in): snap the bar back to
  // 0, grey it, and lock the quick-% buttons. This runs on every keystroke and
  // after refreshLiquidity, so the remove control heals its own state as the
  // token pair / asset list changes — no separate listener needed.
  const slider  = document.getElementById("lq-remove-slider");
  const remWrap = document.querySelector(".lq-remove");
  const pctBtns = document.querySelectorAll(".lq-pct-row .slip-btn");
  if (!hasLp) {
    if (removePct !== 0) {
      removePct = 0;
      const lbl = document.getElementById("lq-remove-pct");
      if (lbl) lbl.textContent = "0%";
      renderRemovePreview();
    }
    if (slider) { slider.value = 0; slider.disabled = true; }
    pctBtns.forEach(b => { b.disabled = true; b.classList.remove("slip-active"); });
    if (remWrap) remWrap.classList.add("lq-remove--empty");
  } else {
    if (slider) slider.disabled = false;
    pctBtns.forEach(b => { b.disabled = false; });
    if (remWrap) remWrap.classList.remove("lq-remove--empty");
  }
}

function setRemovePct(pct) {
  removePct = Math.max(0, Math.min(100, Math.round(pct)));
  const slider = document.getElementById("lq-remove-slider");
  if (slider && Number(slider.value) !== removePct) slider.value = removePct;
  const lbl = document.getElementById("lq-remove-pct");
  if (lbl) lbl.textContent = removePct + "%";
  // Highlight a quick-button only when it matches the slider exactly.
  document.querySelectorAll(".lq-pct-row .slip-btn").forEach(b =>
    b.classList.toggle("slip-active", Number(b.dataset.pct) === removePct));
  renderRemovePreview();
  updateLqButtons();
}

// Live payout for the current slider %: burns removePct of the LP position and
// shows the pro-rata token amounts (lpBal × pct/100 × reserve ÷ supply — the
// pair's own redemption math). Uses cached pool state, so it's instant on drag.
function renderRemovePreview() {
  const el = document.getElementById("lq-remove-preview");
  const lpEl = document.getElementById("lq-remove-bal");
  if (!el) return;
  if (!lpBalanceWei || lpBalanceWei.isZero() || !lpReserveA || !lpTotalSupply || lpTotalSupply.isZero() || removePct <= 0 || !tokenIn || !tokenOut) {
    el.textContent = "";
    if (lpEl) lpEl.textContent = "LP: " + (lpBalanceWei ? fmtLp(lpBalanceWei) : "—");
    return;
  }
  const liq  = lpBalanceWei.mul(removePct).div(100);
  const outA = liq.mul(lpReserveA).div(lpTotalSupply);
  const outB = liq.mul(lpReserveB).div(lpTotalSupply);
  el.textContent =
    `You receive ≈ ${fmt(outA, tokenIn.decimals, 4)} ${tokenIn.symbol} + ` +
    `${fmt(outB, tokenOut.decimals, 4)} ${tokenOut.symbol}`;
  // Also show the LP amount being burned next to the "LP:" label.
  if (lpEl) lpEl.textContent = `Burn ${fmtLp(liq)} of ${fmtLp(lpBalanceWei)} LP`;

  // The withdrawal's total USD used to be appended here. Dropped with the rest
  // of the pool-priced dollar figures — the preview already states both token
  // amounts exactly, which is the number that matters when you're deciding how
  // much LP to burn.
}

function showLqTx(hash) {
  const link = document.getElementById("lq-tx-link");
  if (link) { link.href = `https://arbiscan.io/tx/${hash}`; link.classList.remove("hidden"); }
}

// confirmTx() is a shared helper in config.js — it polls the public RPC for
// the receipt so a flaky in-app wallet provider can't leave a button stuck in
// its loading state.

async function handleAddLiquidity() {
  if (!userAddress || !tokenIn || !tokenOut) return;
  if (isNative(tokenIn) || isNative(tokenOut)) return; // LP positions use WETH
  const aStr = document.getElementById("lq-amount-a").value;
  const bStr = document.getElementById("lq-amount-b").value;
  if (!aStr || !bStr || parseFloat(aStr) <= 0 || parseFloat(bStr) <= 0) return;

  const btn = document.getElementById("lq-add-btn");
  const orig = btn.textContent;
  try {
    btn.disabled = true;
    const amtA = ethers.utils.parseUnits(aStr, tokenIn.decimals);
    let   amtB = ethers.utils.parseUnits(bStr, tokenOut.decimals);
    // Re-quote amtB from LIVE reserves at submit so the deposit matches the
    // current pool ratio. A stale auto-fill (pool moved after the field was
    // filled, or the user edited one side) otherwise trips the router's
    // slippage guard — InsufficientBAmount (0x51959667) / InsufficientAAmount.
    // A brand-new pool (no reserves) keeps the typed amounts: the first add
    // sets the price, so any ratio is valid.
    try {
      const reader = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_ABI, readProviderForEligibility());
      const [rA, rB] = await reader.getReserves(tokenIn.address, tokenOut.address);
      if (rA.gt(0) && rB.gt(0)) {
        amtB = amtA.mul(rB).div(rA);
        const bField = document.getElementById("lq-amount-b");
        if (bField) bField.value = trimAmount(ethers.utils.formatUnits(amtB, tokenOut.decimals));
      }
    } catch {}
    const slip = Math.floor((100 - slippagePct) * 100);
    const aMin = amtA.mul(slip).div(10000);
    const bMin = amtB.mul(slip).div(10000);

    // Approve both tokens to the router if needed.
    for (const [tok, amt] of [[tokenIn, amtA], [tokenOut, amtB]]) {
      const c = await writeContract(tok.address, ERC20_ABI);
      const allow = await c.allowance(userAddress, ADDRESSES.TimbSwapRouter);
      if (allow.lt(amt)) {
        btn.textContent = `Approving ${tok.symbol}…`;
        DebugHub.logCheckpoint("Liquidity Approve Requested", "pass");
        const gas = await getGasParams(); const nonce = await getPendingNonce();
        await confirmTx(await c.approve(ADDRESSES.TimbSwapRouter, ethers.constants.MaxUint256, { ...gas, nonce }));
      }
    }

    // Router v6 creates a missing pair INSIDE addLiquidity, so go straight
    // to the add — no fragile pre-create step (wallets wrap its estimation
    // reverts as opaque -32603 errors). On failure, decode the revert
    // selector to self-diagnose instead of surfacing wallet noise.
    const SEL_PAIR_NOT_FOUND = "0x4db171d4"; // PairNotFound(addr,addr) — pre-v6 router
    const SEL_CREATE_PAUSED  = "0xaaed1932"; // PairCreationPaused() — factory paused
    const SEL_INSUFF_A       = "0x47c5f09e"; // InsufficientAAmount — ratio/slippage
    const SEL_INSUFF_B       = "0x51959667"; // InsufficientBAmount — ratio/slippage


    const router = await writeContract(ADDRESSES.TimbSwapRouter, ROUTER_ABI);
    const sendAdd = async () => {
      const deadline = Math.floor(Date.now() / 1000) + 1200;
      const gas = await getGasParams(); const nonce = await getPendingNonce();
      const t = await router.addLiquidity(tokenIn.address, tokenOut.address, amtA, amtB, aMin, bMin, userAddress, deadline, { ...gas, nonce });
      await confirmTx(t);
      return t;
    };

    btn.textContent = "Adding liquidity…";
    DebugHub.logCheckpoint("Liquidity Add Requested", "pass");
    let tx;
    try {
      tx = await sendAdd();
    } catch (addErr) {
      const sel = revertSel(addErr);
      if (sel) DebugHub.logError("handleAddLiquidity.revertSelector", new Error("selector " + sel));

      if (sel === SEL_CREATE_PAUSED) {
        alert("Pair creation is PAUSED on the TimbSwapFactory — call unpause() as the factory owner, then retry.");
        throw addErr;
      }
      if (sel === SEL_INSUFF_A || sel === SEL_INSUFF_B) {
        alert("The pool ratio moved since these amounts were set. Amounts are re-quoted from live reserves at submit — refresh the panel (re-enter the first amount) and add again, or widen slippage.");
        throw addErr;
      }
      if (sel === SEL_PAIR_NOT_FOUND) {
        // Pre-v6 router without create-on-add: create via the permissionless
        // factory call, then retry the add once.
        btn.textContent = `Creating ${tokenIn.symbol}/${tokenOut.symbol} pair…`;
        DebugHub.logCheckpoint("Liquidity Pair Create Requested", "pass");
        const factory = await writeContract(ADDRESSES.TimbSwapFactory, FACTORY_ABI);
        const gasCp = await getGasParams(); const nonceCp = await getPendingNonce();
        await confirmTx(await factory.createPair(tokenIn.address, tokenOut.address, { ...gasCp, nonce: nonceCp }));
        DebugHub.logCheckpoint("Liquidity Pair Created", "pass");
        btn.textContent = "Adding liquidity…";
        tx = await sendAdd();
      } else {
        throw addErr;
      }
    }
    DebugHub.logCheckpoint("Liquidity Add Confirmed", "pass");

    document.getElementById("lq-amount-a").value = "";
    document.getElementById("lq-amount-b").value = "";
    btn.textContent = "Liquidity added ✓";
    showLqTx(tx.hash);
    await refreshLiquidity();
    setTimeout(() => updateLqButtons(), 6000);
  } catch (err) {
    console.error("Add liquidity failed:", err.message);
    DebugHub.logError("handleAddLiquidity", err);
    DebugHub.logCheckpoint("Liquidity Add Failed", "fail");
    btn.textContent = "Failed — try again";
    setTimeout(() => { btn.textContent = orig; updateLqButtons(); }, 3000);
  }
}

async function handleRemoveLiquidity() {
  if (!userAddress || !tokenIn || !tokenOut) return;
  if (!lpBalanceWei || lpBalanceWei.isZero() || removePct <= 0) return;
  if (!lpPairAddress || lpPairAddress === ethers.constants.AddressZero) return;

  const btn = document.getElementById("lq-remove-btn");
  const orig = btn.textContent;
  try {
    btn.disabled = true;
    const liquidity = lpBalanceWei.mul(removePct).div(100);
    if (liquidity.isZero()) { updateLqButtons(); return; }

    // Approve the LP token to the router if needed.
    const lp = await writeContract(lpPairAddress, ERC20_ABI);
    const allow = await lp.allowance(userAddress, ADDRESSES.TimbSwapRouter);
    if (allow.lt(liquidity)) {
      btn.textContent = "Approving LP…";
      DebugHub.logCheckpoint("Liquidity Remove Approve", "pass");
      const gas = await getGasParams(); const nonce = await getPendingNonce();
      await confirmTx(await lp.approve(ADDRESSES.TimbSwapRouter, ethers.constants.MaxUint256, { ...gas, nonce }));
    }

    btn.textContent = "Removing…";
    DebugHub.logCheckpoint("Liquidity Remove Requested", "pass");
    const router = await writeContract(ADDRESSES.TimbSwapRouter, ROUTER_ABI);
    const deadline = Math.floor(Date.now() / 1000) + 1200;
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    // amountAMin/amountBMin 0 — acceptable on testnet; the burn returns the pro-rata share.
    const tx = await router.removeLiquidity(tokenIn.address, tokenOut.address, liquidity, 0, 0, userAddress, deadline, { ...gas, nonce });
    await confirmTx(tx);
    DebugHub.logCheckpoint("Liquidity Remove Confirmed", "pass");

    btn.textContent = "Removed ✓";
    showLqTx(tx.hash);
    removePct = 0;
    document.querySelectorAll(".lq-pct-row .slip-btn").forEach(b => b.classList.remove("slip-active"));
    await refreshLiquidity();
    setTimeout(() => updateLqButtons(), 6000);
  } catch (err) {
    console.error("Remove liquidity failed:", err.message);
    DebugHub.logError("handleRemoveLiquidity", err);
    DebugHub.logCheckpoint("Liquidity Remove Failed", "fail");
    btn.textContent = "Failed — try again";
    setTimeout(() => { btn.textContent = orig; updateLqButtons(); }, 3000);
  }
}

// ─── Wallet Connect (page-specific wiring) ────────────────────────────────────

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

  await refreshBalances();
  updateSwapButton(tokenIn && tokenOut ? "Swap" : "Select tokens");
  await checkEligibility(); // reveal the (wallet-gated) prize panel now
  if (mode === "liquidity") await refreshLiquidity();

  listenForAccountChanges(async (newAddr) => {
    if (!newAddr) { handleDisconnect(); return; }
    document.getElementById("wallet-addr").textContent = fmtAddr(newAddr);
    await refreshBalances();
    await checkEligibility();
  });
}

function handleDisconnect() {
  DebugHub.endSession();
  disconnectWallet();
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
  updateSwapButton("Connect wallet to swap");
  refreshBalances();
  refreshLiquidity();  // LP balance, withdrawable row → gated "—" states
  checkEligibility(); // hide the prize panel / influence row again
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  // No default pair — both selectors open unselected ("--") so the user
  // consciously picks. tokenIn/tokenOut stay null; every downstream path
  // (quote, eligibility, buttons, liquidity labels) already handles null.
  document.getElementById("token-in-symbol").textContent  = "--";
  document.getElementById("token-out-symbol").textContent = "--";
  updateAddOutWalletChip();
  checkEligibility();
  recalcQuote();
  updateSwapButton("Select tokens");

  // Deep-link: the farm page sends "Get LP" here with #liquidity so a user with
  // no LP lands straight on the Add-liquidity tab instead of the Swap tab.
  if (window.location.hash === "#liquidity") setMode("liquidity");

  // Auto-reconnect if wallet was connected before navigation
    DebugHub.logCheckpoint("Swap:Page Loaded", "pass");
  const _reconnected = await autoReconnect();
  if (_reconnected) {
    document.getElementById("connect-btn")?.classList.add("hidden");
    document.getElementById("wallet-info")?.classList.remove("hidden");
    document.getElementById("network-badge")?.classList.remove("hidden");
    const _addrEl = document.getElementById("wallet-addr");
    if (_addrEl) _addrEl.textContent = fmtAddr(_reconnected);
    await refreshBalances();
    updateSwapButton(tokenIn && tokenOut ? "Swap" : "Select tokens");
    await checkEligibility(); // reveal the (wallet-gated) prize panel now
    if (mode === "liquidity") await refreshLiquidity();
    DebugHub.startSession(_reconnected);
    DebugHub.logCheckpoint("Wallet Auto-Reconnected", "pass");
    listenForAccountChanges(async (newAddr) => {
      if (!newAddr) { handleDisconnect(); return; }
      const _el = document.getElementById("wallet-addr");
      if (_el) _el.textContent = fmtAddr(newAddr);
      await refreshBalances();
      await checkEligibility();
    });
  }
})();
