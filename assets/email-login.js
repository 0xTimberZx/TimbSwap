// assets/email-login.js — "Continue with email" for TimbSwap.
//
// Email sign-in backed by a Privy embedded wallet: the user types an email,
// enters the one-time code, and gets a normal Ethereum address (an EOA whose
// key is split between Privy's iframe and this browser). The wallet speaks
// EIP-1193, so config.js drops it into the same slot as a browser extension
// and every page keeps working unchanged (ethers Web3Provider → signer → the
// same mint / swap / claim calls).
//
// Loading: config.js injects this file on demand (the first connect that could
// use it). This file in turn imports vendor/privy-core.js (the bundled SDK,
// ~800 KB) only when the user actually picks email — extension users never
// download either. Nothing here runs at page load.
//
// Exposes window.TimbEmailWallet:
//   available()              → PRIVY_APP_ID is set
//   chooseMethod({hasInjected}) → Promise<"injected" | "email" | null>
//   login()                  → Promise<{ provider, address } | null>  (null = cancelled)
//   restore()                → Promise<provider | null>  (silent, no UI)
//   logout()                 → Promise<void>
//
// Privacy: the email address goes to Privy (their terms/privacy apply), never
// to TimbSwap's own backend. TimbSwap only ever sees the resulting wallet
// address, exactly as with an extension wallet.

(function () {
  "use strict";

  const ROOT   = (typeof SITE_ROOT !== "undefined" && SITE_ROOT) ? SITE_ROOT : "/";
  const VENDOR = ROOT + "vendor/privy-core.js?v=" + (window.ASSET_VER || "1");
  const CHAIN  = (typeof CHAIN_ID !== "undefined") ? CHAIN_ID : 421614;

  let _mod = null;      // the vendored SDK module
  let _privy = null;    // Privy client
  let _iframe = null;   // Privy's secure-context iframe (holds the device key share)
  let _loading = null;  // memoised load()
  let _address = null;  // current embedded wallet address (after login/restore)

  function available() { return !!window.PRIVY_APP_ID; }

  // ── SDK bootstrap ───────────────────────────────────────────────────────────
  async function load() {
    if (_loading) return _loading;
    _loading = (async () => {
      if (!available()) throw new Error("PRIVY_APP_ID is not set");
      _mod = await import(VENDOR);
      const chain = CHAIN === 42161 ? _mod.arbitrum : _mod.arbitrumSepolia;
      _privy = new _mod.Privy({
        appId: window.PRIVY_APP_ID,
        storage: new _mod.LocalStorage(),
        // The embedded wallet defaults to the first supported chain, so this is
        // what makes eth_chainId come back as the app's chain with no switch.
        supportedChains: [chain],
      });

      // Privy's key operations run inside its own iframe; the SDK talks to it
      // via postMessage. Mount it hidden, wire both directions, then init.
      _iframe = document.createElement("iframe");
      _iframe.src = _privy.embeddedWallet.getURL();
      _iframe.setAttribute("aria-hidden", "true");
      _iframe.setAttribute("title", "wallet");
      _iframe.style.cssText = "position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none;";
      const iframeOrigin = new URL(_iframe.src).origin;
      const loaded = new Promise((res) => { _iframe.onload = () => res(); });
      document.body.appendChild(_iframe);
      _privy.setMessagePoster(_iframe.contentWindow);
      window.addEventListener("message", (e) => {
        if (e.origin !== iframeOrigin) return;
        try { _privy.embeddedWallet.onMessage(e.data); } catch (_err) { /* not for us */ }
      });
      await loaded;
      await _privy.initialize();
      return _privy;
    })();
    _loading.catch(() => { _loading = null; }); // allow a retry after a failed load
    return _loading;
  }

  async function _providerFor(user) {
    const account = _mod.getUserEmbeddedEthereumWallet(user);
    if (!account) return null;
    const { entropyId, entropyIdVerifier } = _mod.getEntropyDetailsFromAccount(account);
    const provider = await _privy.embeddedWallet.getEthereumProvider({
      wallet: account, entropyId, entropyIdVerifier,
    });
    _address = account.address;
    return guard(provider);
  }

  // ── Confirmation guard ──────────────────────────────────────────────────────
  // The headless SDK signs whatever the page asks, with no popup of its own —
  // an extension wallet would show one. So every write request (send / sign)
  // goes through a confirmation sheet FIRST; the wallet only sees it after the
  // user taps Confirm. Reject throws the standard EIP-1193 "user rejected"
  // error (code 4001), which every call site already handles for extensions.
  // Reads (eth_call, eth_estimateGas, balances, chain id …) pass straight
  // through. Note the limit: this protects against bugs and accidental sends;
  // a script that fully controls the page could still drive the sheet. The
  // out-of-page answer is Privy's transaction MFA (see dev-docs/EMAIL_LOGIN.md).
  const WRITE_METHODS = new Set([
    "eth_sendTransaction", "eth_signTransaction", "eth_sign", "personal_sign",
    "eth_signTypedData", "eth_signTypedData_v3", "eth_signTypedData_v4",
    "wallet_addEthereumChain",
  ]);

  function guard(provider) {
    const g = {
      isTimbEmailWallet: true,
      async request(args) {
        if (args && WRITE_METHODS.has(args.method)) {
          const isTx = (args.method === "eth_sendTransaction" || args.method === "eth_signTransaction");
          const ok = await confirmRequest(args, provider);
          if (!ok) {
            const err = new Error("User rejected the request.");
            err.code = 4001;
            throw err;
          }
          try {
            const result = await provider.request(args);
            close(null); // sending state → done
            return result;
          } catch (e) {
            await showError(e, isTx);
            throw e;
          }
        }
        return provider.request(args);
      },
      on(ev, fn) { try { provider.on && provider.on(ev, fn); } catch (_e) {} return g; },
      removeListener(ev, fn) { try { provider.removeListener && provider.removeListener(ev, fn); } catch (_e) {} return g; },
      off(ev, fn) { return g.removeListener(ev, fn); },
    };
    return g;
  }

  // ── Decoding, fee estimate and advanced overrides for the sheet ────────────
  // Human-readable ABI for the calls the site makes (names matter: the rows
  // below read args by name). Overloads that share a selector are listed once.
  const KNOWN_ABI = [
    "function submitEntry(bytes6 string6, bool useETH, uint256 extraRounds) payable",
    "function replaceEntry(bytes6 newString6, uint256 extraRounds)",
    "function cancelEntry()",
    "function claimRefund(uint256 ticketId)",
    "function claimWinnings(uint256 round)",
    "function reclaimFromPastGame(uint256 ticketId)",
    "function advanceScroll(uint256 count)",
    "function approve(address spender, uint256 amount)",
    "function swapExactETHForTokens(uint256 amountIn, uint256 amountOutMin, address tokenOut, address to, uint256 deadline, bool influencePrize) payable",
    "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address tokenIn, address to, uint256 deadline, bool influencePrize)",
    "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address tokenIn, address tokenOut, address to, uint256 deadline, bool influencePrize)",
    "function swapExactTokensForTokensPath(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline, bool influencePrize)",
    "function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline)",
    "function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline)",
    "function provideLiquidityETH(address token, uint256 amountTokenDesired, uint256 ethAmount, uint256 amountTokenMin, uint256 amountETHMin)",
    "function stake(uint256 amount)",
    "function unstake(uint256 amount)",
    "function claimRewards()",
    "function claimRewards(uint256 pid)",
    "function deposit() payable",
    "function deposit(uint256 pid, uint256 amount)",
    "function withdraw(uint256 amount)",
    "function withdraw(uint256 pid, uint256 amount)",
    "function lock(address token, uint256 amount, uint256 durationSeconds)",
    "function unwrapWeth(uint256 amount)",
    "function castVote(uint256 proposalId, bool support)",
    "function depositVotingPower(uint256 amount)",
    "function withdrawVotingPower(uint256 amount)",
    "function resolveProposal(uint256 proposalId)",
  ];
  const LABELS = {
    submitEntry: "Enter a ticket", replaceEntry: "Replace your ticket", cancelEntry: "Cancel your ticket",
    claimRefund: "Claim ticket refund", claimWinnings: "Claim winnings", reclaimFromPastGame: "Reclaim from past game",
    advanceScroll: "Advance the scroll", approve: "Approve token spending",
    swapExactETHForTokens: "Swap ETH for tokens", swapExactTokensForETH: "Swap tokens for ETH",
    swapExactTokensForTokens: "Swap tokens", swapExactTokensForTokensPath: "Swap tokens",
    addLiquidity: "Add liquidity", removeLiquidity: "Remove liquidity", provideLiquidityETH: "Add liquidity",
    stake: "Stake", unstake: "Unstake", claimRewards: "Claim rewards",
    deposit: "Deposit", withdraw: "Withdraw", lock: "Lock tokens", unwrapWeth: "Unwrap WETH",
    castVote: "Cast vote", depositVotingPower: "Deposit voting power", withdrawVotingPower: "Withdraw voting power",
    resolveProposal: "Resolve proposal",
  };

  let _iface = null;
  function iface() {
    if (_iface === null) { try { _iface = new ethers.utils.Interface(KNOWN_ABI); } catch (_e) { _iface = false; } }
    return _iface || null;
  }
  function decodeTx(tx) {
    const i = iface();
    if (!i || !tx || typeof tx.data !== "string" || tx.data.length < 10) return null;
    try { return i.parseTransaction({ data: tx.data, value: tx.value || 0 }); } catch (_e) { return null; }
  }
  // Pages outside KNOWN_ABI (the SwapTables pages, ethers v6) register their
  // own selector → label and address → name maps (tables/wallet.js).
  const _extraLabels = {};
  const _extraNames = {};
  function registerCalls(list) {
    for (const c of list || []) if (c && c.selector) _extraLabels[String(c.selector).toLowerCase()] = c.label || c.selector;
  }
  function registerContracts(map) {
    for (const [a, n] of Object.entries(map || {})) if (a) _extraNames[String(a).toLowerCase()] = n;
  }

  function actionLabel(tx) {
    if (!tx.data || tx.data === "0x") return "Send ETH";
    const sel = String(tx.data).slice(0, 10).toLowerCase();
    if (_extraLabels[sel]) return _extraLabels[sel];
    const p = decodeTx(tx);
    return p ? (LABELS[p.name] || p.name) : "Contract call " + sel;
  }

  function contractName(addr) {
    const a = String(addr || "").toLowerCase();
    if (_extraNames[a]) return _extraNames[a];
    try {
      for (const [name, v] of Object.entries(ADDRESSES)) if (String(v).toLowerCase() === a) return name;
    } catch (_e) {}
    return null;
  }

  // Token symbol + decimals: known addresses from config, else read on-chain
  // via the site's shared read provider (cached per address).
  const _tokCache = {};
  async function tokenInfo(addr) {
    const a = String(addr || "").toLowerCase();
    if (_tokCache[a]) return _tokCache[a];
    let info = null;
    const name = contractName(a);
    if (name === "TIMBSToken") info = { symbol: "TIMBS", decimals: 18 };
    else if (name === "WETH")  info = { symbol: "WETH", decimals: 18 };
    if (!info) {
      try {
        const c = new ethers.Contract(a, ["function symbol() view returns (string)", "function decimals() view returns (uint8)"], sharedReadProvider());
        const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
        info = { symbol, decimals: Number(decimals) };
      } catch (_e) { info = { symbol: short(a), decimals: 18 }; }
    }
    _tokCache[a] = info;
    return info;
  }

  function fmtWei(v, decimals, dp) {
    try {
      const wei = BigInt(v || 0);
      if (wei === 0n) return "0";
      const s = wei.toString().padStart(decimals + 1, "0");
      const whole = s.slice(0, s.length - decimals);
      const frac = s.slice(s.length - decimals).replace(/0+$/, "").slice(0, dp);
      return whole + (frac ? "." + frac : "");
    } catch (_e) { return String(v); }
  }
  function fmtEth(v, dp = 6) { return fmtWei(v, 18, dp) + " ETH"; }
  function short(a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : ""; }
  function bytes6Text(b) { try { return ethers.utils.toUtf8String(b).replace(/\0/g, ""); } catch (_e) { return String(b); } }
  function deadlineText(d) {
    const secs = Number(d) - Math.floor(Date.now() / 1000);
    if (!isFinite(secs)) return String(d);
    return secs > 0 ? "in " + Math.max(1, Math.round(secs / 60)) + " min" : "already passed";
  }
  function isMaxUint(bn) { try { return bn.eq(ethers.constants.MaxUint256); } catch (_e) { return false; } }

  // Per-call detail rows (async: token symbols may need a read).
  async function detailRows(p, tx) {
    const a = p.args, rows = [];
    const toName = contractName(tx.to);
    const amt = async (addr, v) => { const t = await tokenInfo(addr); return fmtWei(v, t.decimals, 6) + " " + t.symbol; };
    const extra = (n) => { if (n && n.gt && n.gt(0)) rows.push(["Extra rounds", n.toString() + " · paid in TIMBS, non-refundable"]); };
    const swapTail = () => { rows.push(["Recipient", short(a.to), 1]); rows.push(["Deadline", deadlineText(a.deadline)]); rows.push(["Nudges the meter", a.influencePrize ? "yes" : "no"]); };
    switch (p.name) {
      case "submitEntry":
        rows.push(["Ticket", bytes6Text(a.string6), 1]);
        rows.push(["Backed by", a.useETH ? fmtEth(tx.value) + " (refundable escrow)" : "TIMBS entry cost (refundable escrow)"]);
        extra(a.extraRounds); break;
      case "replaceEntry":
        rows.push(["New ticket", bytes6Text(a.newString6), 1]);
        extra(a.extraRounds);
        rows.push(["Note", "Concedes your current ticket; its principal carries over"]); break;
      case "swapExactETHForTokens":
        rows.push(["You pay", fmtEth(tx.value)]);
        rows.push(["You receive", "≥ " + await amt(a.tokenOut, a.amountOutMin) + " (min after slippage)"]);
        swapTail(); break;
      case "swapExactTokensForETH":
        rows.push(["You pay", await amt(a.tokenIn, a.amountIn)]);
        rows.push(["You receive", "≥ " + fmtEth(a.amountOutMin) + " (min after slippage)"]);
        swapTail(); break;
      case "swapExactTokensForTokens":
        rows.push(["You pay", await amt(a.tokenIn, a.amountIn)]);
        rows.push(["You receive", "≥ " + await amt(a.tokenOut, a.amountOutMin) + " (min after slippage)"]);
        swapTail(); break;
      case "swapExactTokensForTokensPath":
        rows.push(["You pay", await amt(a.path[0], a.amountIn)]);
        rows.push(["You receive", "≥ " + await amt(a.path[a.path.length - 1], a.amountOutMin) + " (min after slippage)"]);
        rows.push(["Route", (a.path.length - 1) + " hop" + (a.path.length > 2 ? "s" : "")]);
        rows.push(["Deadline", deadlineText(a.deadline)]);
        rows.push(["Nudges the meter", a.influencePrize ? "yes" : "no"]); break;
      case "approve": {
        const t = await tokenInfo(tx.to);
        rows.push(["Token", t.symbol]);
        rows.push(["Spender", contractName(a.spender) || short(a.spender)]);
        rows.push(["Allowance", isMaxUint(a.amount) ? "Unlimited" : fmtWei(a.amount, t.decimals, 6) + " " + t.symbol]); break;
      }
      case "stake": case "unstake": case "depositVotingPower": case "withdrawVotingPower":
        rows.push(["Amount", fmtWei(a.amount, 18, 6) + " TIMBS"]); break;
      case "withdraw":
        if (a.pid !== undefined) { rows.push(["Pool", a.pid.toString()]); rows.push(["Amount", fmtWei(a.amount, 18, 6) + " LP"]); }
        else if (toName === "TimbLockVault") rows.push(["Lock #", a.amount.toString()]);
        else rows.push(["Amount", fmtWei(a.amount, 18, 6) + " TIMBS"]);
        break;
      case "deposit":
        if (a.pid !== undefined) { rows.push(["Pool", a.pid.toString()]); rows.push(["Amount", fmtWei(a.amount, 18, 6) + " LP"]); }
        else rows.push(["Amount", fmtEth(tx.value)]);
        break;
      case "lock":
        rows.push(["Amount", await amt(a.token, a.amount)]);
        rows.push(["Duration", Math.round(Number(a.durationSeconds) / 86400) + " days"]); break;
      case "unwrapWeth": rows.push(["Amount", fmtWei(a.amount, 18, 6) + " WETH"]); break;
      case "claimRefund": case "reclaimFromPastGame": rows.push(["Ticket #", a.ticketId.toString()]); break;
      case "claimWinnings": rows.push(["Round", a.round.toString()]); break;
      case "claimRewards": if (a.pid !== undefined) rows.push(["Pool", a.pid.toString()]); break;
      case "castVote": rows.push(["Proposal #", a.proposalId.toString()]); rows.push(["Vote", a.support ? "For" : "Against"]); break;
      case "resolveProposal": rows.push(["Proposal #", a.proposalId.toString()]); break;
      case "advanceScroll": rows.push(["Steps", a.count.toString()]); break;
      case "addLiquidity":
        rows.push(["Token A", await amt(a.tokenA, a.amountADesired) + " (min " + await amt(a.tokenA, a.amountAMin) + ")"]);
        rows.push(["Token B", await amt(a.tokenB, a.amountBDesired) + " (min " + await amt(a.tokenB, a.amountBMin) + ")"]);
        rows.push(["Deadline", deadlineText(a.deadline)]); break;
      case "removeLiquidity":
        rows.push(["LP burned", fmtWei(a.liquidity, 18, 6)]);
        rows.push(["Min out", await amt(a.tokenA, a.amountAMin) + " + " + await amt(a.tokenB, a.amountBMin)]);
        rows.push(["Deadline", deadlineText(a.deadline)]); break;
      case "provideLiquidityETH":
        rows.push(["Token", await amt(a.token, a.amountTokenDesired) + " (min " + await amt(a.token, a.amountTokenMin) + ")"]);
        rows.push(["ETH", fmtEth(a.ethAmount) + " (min " + fmtEth(a.amountETHMin) + ")"]); break;
      default: break;
    }
    return rows;
  }

  // Gas / fee / nonce, read through the wallet's own provider (reads never
  // trigger the guard). Missing pieces degrade to a note.
  async function feeInfo(raw, tx) {
    const info = { gas: null, maxFee: null, nonce: null, fee: null, balance: null, gasError: null, legacy: !!tx.gasPrice };
    try {
      const g = tx.gas || tx.gasLimit || await raw.request({ method: "eth_estimateGas", params: [tx] });
      info.gas = BigInt(g);
    } catch (e) { info.gasError = txErrorText(e); }
    try {
      const f = tx.maxFeePerGas || tx.gasPrice || await raw.request({ method: "eth_gasPrice", params: [] });
      info.maxFee = BigInt(f);
    } catch (_e) {}
    try { info.nonce = Number(BigInt(await raw.request({ method: "eth_getTransactionCount", params: [_address, "pending"] }))); } catch (_e) {}
    try { info.balance = BigInt(await raw.request({ method: "eth_getBalance", params: [_address, "latest"] })); } catch (_e) {}
    if (info.gas != null && info.maxFee != null) info.fee = info.gas * info.maxFee;
    return info;
  }

  // Plain-language reason for a failed send / estimate.
  function txErrorText(e) {
    const msg = String((e && (e.reason || (e.error && e.error.message) || (e.data && e.data.message) || e.message)) || "Unknown error");
    if (e && e.code === 4001) return "Rejected.";
    if (/insufficient funds/i.test(msg)) return "Not enough ETH to cover the amount plus the network fee.";
    if (/nonce too low/i.test(msg)) return "Nonce too low: a transaction with that nonce already went through. Leave the nonce blank to use the next one.";
    if (/replacement transaction underpriced|already known|already exists/i.test(msg)) return "A transaction with this nonce is already pending. Raise the max fee to replace it, or wait for it to confirm.";
    if (/gas required exceeds|intrinsic gas too low|out of gas/i.test(msg)) return "Gas limit too low for this transaction. Raise it under Advanced.";
    const m = /execution reverted:?\s*([^"}]*)/i.exec(msg);
    if (m) return "The contract rejected this transaction" + (m[1] && m[1].trim() ? ": " + m[1].trim() : ".");
    if (/user rejected|user denied/i.test(msg)) return "Rejected.";
    return msg.length > 240 ? msg.slice(0, 240) + "…" : msg;
  }

  function row(k, v, mono) {
    return h("div", { class: "tsheet-row" }, h("span", { class: "tsheet-k", text: k }), h("span", { class: "tsheet-v" + (mono ? " tsheet-mono" : ""), text: v }));
  }
  function gweiToWei(str) { const n = Number(str); if (!isFinite(n) || n < 0) return null; return BigInt(Math.round(n * 1e9)); }
  function hex(b) { return "0x" + BigInt(b).toString(16); }

  // Build the sheet for one request; resolves true (confirmed) / false. After
  // Confirm the sheet STAYS OPEN in a "Sending…" state; guard() closes it on
  // success or swaps in the error (showError). For transactions the details
  // and fee rows fill in asynchronously, and the Advanced panel lets the user
  // override gas limit, max fee and nonce — applied only when they Confirm.
  function confirmRequest(args, raw) {
    const p = open("Confirm with your email wallet");
    const m = args.method;
    const rows = h("div", { class: "tsheet-rows" });
    const more = h("div", { class: "tsheet-rows tsheet-more hidden" });
    const err = h("p", { class: "tsheet-err", role: "alert" });
    const adv = h("div", { class: "tsheet-adv hidden" });
    const actions = h("div", { class: "tsheet-actions" });
    let advInputs = null;
    let info = null;
    const isTx = (m === "eth_sendTransaction" || m === "eth_signTransaction");
    const btnConfirm = h("button", { class: "tsheet-btn tsheet-btn-primary", type: "button", onclick: onConfirm }, h("strong", { text: "Confirm" }));
    const btnReject  = h("button", { class: "tsheet-btn", type: "button", onclick: () => close(false) }, h("strong", { text: "Reject" }));
    const advLink = h("button", { class: "tsheet-link", type: "button", onclick: () => {
      adv.classList.toggle("hidden");
      advLink.textContent = adv.classList.contains("hidden") ? "Advanced: gas & nonce" : "Hide advanced";
    } }, "Advanced: gas & nonce");

    function onConfirm() {
      err.textContent = "";
      if (isTx && advInputs && !adv.classList.contains("hidden")) {
        const tx = args.params[0];
        const gasV = advInputs.gas.value.trim(), feeV = advInputs.fee.value.trim(), nonceV = advInputs.nonce.value.trim();
        if (gasV !== "") {
          if (!/^\d+$/.test(gasV) || BigInt(gasV) < 21000n) { err.textContent = "Gas limit must be a whole number of at least 21000."; return; }
          tx.gas = hex(gasV); delete tx.gasLimit;
        }
        if (feeV !== "") {
          const w = gweiToWei(feeV);
          if (w == null || w <= 0n) { err.textContent = "Max fee must be a positive number of gwei."; return; }
          if (info && info.legacy) tx.gasPrice = hex(w);
          else { tx.maxFeePerGas = hex(w); if (tx.maxPriorityFeePerGas && BigInt(tx.maxPriorityFeePerGas) > w) tx.maxPriorityFeePerGas = hex(w); }
        }
        if (nonceV !== "") {
          if (!/^\d+$/.test(nonceV)) { err.textContent = "Nonce must be a whole number."; return; }
          tx.nonce = hex(nonceV);
        }
      }
      // Pending state: keep the sheet up until the wallet answers.
      btnConfirm.disabled = true; btnReject.disabled = true; advLink.disabled = true;
      btnConfirm.firstChild.textContent = isTx ? "Sending…" : "Signing…";
      settle(true);
    }

    if (isTx) {
      const tx = (args.params && args.params[0]) || {};
      const name = contractName(tx.to);
      rows.append(row("Action", actionLabel(tx)));
      rows.append(row("To", name ? name + " (" + short(tx.to) + ")" : (tx.to || "(contract creation)"), !name));
      rows.append(row("Amount", fmtEth(tx.value)));
      rows.append(row("From", short(_address), true));
      rows.append(row("Network", chainName()));
      const loading = row("Details", "loading…");
      more.classList.remove("hidden"); more.append(loading);

      (async () => {
        const parts = [];
        try { const parsed = decodeTx(tx); if (parsed) parts.push(...await detailRows(parsed, tx)); } catch (_e) {}
        try { info = await feeInfo(raw, tx); } catch (_e) { info = null; }
        if (info) {
          if (info.gasError) parts.push(["Gas estimate", "failed — this transaction would likely fail: " + info.gasError]);
          else if (info.gas != null) parts.push(["Gas limit", info.gas.toString()]);
          if (info.maxFee != null) parts.push(["Max fee per gas", fmtWei(info.maxFee, 9, 4) + " gwei"]);
          if (info.fee != null) {
            parts.push(["Network fee (max)", fmtEth(info.fee, 8)]);
            const total = info.fee + BigInt(tx.value || 0);
            parts.push(["Total (max)", fmtEth(total, 8)]);
            if (info.balance != null && info.balance < total) parts.push(["Warning", "Not enough ETH: " + fmtEth(info.balance, 6) + " available"]);
          }
          if (info.nonce != null) parts.push(["Nonce", String(info.nonce)]);
          advInputs = {
            gas:   h("input", { class: "tsheet-input tsheet-adv-in", inputmode: "numeric", placeholder: info.gas != null ? info.gas.toString() : "auto", "aria-label": "Gas limit" }),
            fee:   h("input", { class: "tsheet-input tsheet-adv-in", inputmode: "decimal", placeholder: info.maxFee != null ? fmtWei(info.maxFee, 9, 4) : "auto", "aria-label": "Max fee per gas (gwei)" }),
            nonce: h("input", { class: "tsheet-input tsheet-adv-in", inputmode: "numeric", placeholder: info.nonce != null ? String(info.nonce) : "auto", "aria-label": "Nonce" }),
          };
          adv.replaceChildren(
            h("label", { class: "tsheet-adv-row" }, h("span", { text: "Gas limit" }), advInputs.gas),
            h("label", { class: "tsheet-adv-row" }, h("span", { text: "Max fee (gwei)" }), advInputs.fee),
            h("label", { class: "tsheet-adv-row" }, h("span", { text: "Nonce" }), advInputs.nonce),
            h("p", { class: "tsheet-note", text: "Leave blank to keep the estimate. Reusing a pending nonce with a higher max fee replaces that transaction." }));
        }
        loading.remove();
        if (parts.length) for (const r of parts) more.append(row(r[0], r[1], r[2])); else more.classList.add("hidden");
      })();
    } else if (m === "personal_sign" || m === "eth_sign") {
      const rawMsg = String((args.params && args.params[0]) || "");
      let text = rawMsg;
      try { if (/^0x[0-9a-f]*$/i.test(rawMsg)) text = new TextDecoder().decode(Uint8Array.from(rawMsg.slice(2).match(/../g).map((x) => parseInt(x, 16)))); } catch (_e) {}
      rows.append(row("Action", "Sign a message"));
      rows.append(row("Message", text.length > 300 ? text.slice(0, 300) + "…" : text, true));
      rows.append(row("From", short(_address), true)); rows.append(row("Network", chainName()));
    } else if (m.startsWith("eth_signTypedData")) {
      let dom = "", type = "";
      try { const td = typeof args.params[1] === "string" ? JSON.parse(args.params[1]) : args.params[1]; dom = (td.domain && td.domain.name) || ""; type = td.primaryType || ""; } catch (_e) {}
      rows.append(row("Action", "Sign typed data"));
      if (dom) rows.append(row("App", dom));
      if (type) rows.append(row("Type", type));
      rows.append(row("From", short(_address), true)); rows.append(row("Network", chainName()));
    } else {
      rows.append(row("Action", m));
      rows.append(row("From", short(_address), true)); rows.append(row("Network", chainName()));
    }

    actions.append(btnConfirm, btnReject);
    const nodes = [
      h("p", { class: "tsheet-note", text: "Your email wallet only signs after you confirm. Check the action and amounts." }),
      rows, more, err,
    ];
    if (isTx) nodes.push(h("div", { class: "tsheet-links" }, advLink), adv);
    nodes.push(actions);
    setBody(...nodes);
    return p.then((v) => v === true);
  }

  // After a confirmed request fails at the wallet / node: show why, in place.
  function showError(e, isTx) {
    const p = open(isTx ? "Transaction failed" : "Signing failed");
    setBody(
      h("p", { class: "tsheet-err", role: "alert", text: txErrorText(e) }),
      h("p", { class: "tsheet-note", text: isTx ? "Nothing was sent. Adjust and try again." : "Nothing was signed." }),
      h("div", { class: "tsheet-actions" }, h("button", { class: "tsheet-btn tsheet-btn-primary", type: "button", onclick: () => close(true) }, h("strong", { text: "Close" }))));
    return p;
  }

  // ── Auth primitives ─────────────────────────────────────────────────────────
  async function sendCode(email) {
    await load();
    return _privy.auth.email.sendCode(email);
  }

  async function verifyCode(email, code) {
    await load();
    let { user } = await _privy.auth.email.loginWithCode(email, code);
    // First login on this app: no wallet yet → create one (Privy-managed
    // recovery, no password; the user can add one later from a settings UI).
    if (!_mod.getUserEmbeddedEthereumWallet(user)) {
      ({ user } = await _privy.embeddedWallet.create({}));
    }
    const provider = await _providerFor(user);
    if (!provider) throw new Error("wallet_missing");
    return { provider, address: _address };
  }

  // Silent session restore on page load (no UI). Privy keeps its own session
  // (tokens in localStorage); if it is still valid this yields a provider for
  // the same address, otherwise null and config.js drops to the gated view.
  async function restore() {
    try {
      await load();
      const { user } = await _privy.user.get();
      return await _providerFor(user);
    } catch (_err) {
      return null;
    }
  }

  async function logout() {
    _address = null;
    try { if (_privy) await _privy.auth.logout(); } catch (_err) { /* already out */ }
  }

  // ── Sheet UI ────────────────────────────────────────────────────────────────
  // One shared bottom sheet, built by script so no page markup changes. Styles
  // are injected by this file too (SHEET_CSS below).
  let _sheet = null, _title = null, _body = null, _onClose = null;

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of children) if (c != null) el.append(c);
    return el;
  }

  // The sheet's styles ship inside this file (not style.css): the live site's
  // pages load style.css with a fixed ?v= query behind a CDN, so a stylesheet
  // change can be cached away while this script (new file, loaded on demand)
  // is always fresh. Injected once, before the sheet is built. The palette is
  // self-contained too: the site's tokens when style.css is present, dark
  // defaults otherwise (the SwapTables pages have their own styling and no
  // :root tokens — the sheet used to render there with no background).
  const SHEET_CSS = `
.tsheet-backdrop {
  --ts-bg: var(--bg, #0b0f14); --ts-bg2: var(--bg2, #111820); --ts-bg3: var(--bg3, #1a2330);
  --ts-border: var(--border, #1e2d3d); --ts-green: var(--green, #14f195);
  --ts-text: var(--text, #e2e8f0); --ts-text-2: var(--text-2, #8ca3bf); --ts-text-3: var(--text-3, #4a6278);
  --ts-sans: var(--sans, 'Space Grotesk', system-ui, sans-serif); --ts-mono: var(--mono, 'Space Mono', ui-monospace, monospace);
  --ts-radius: var(--radius, 8px);
  color: var(--ts-text); font-family: var(--ts-sans); font-size: 14px; line-height: 1.4; text-align: left;
}
.tsheet-backdrop.hidden { display: none !important; }
.tsheet-backdrop {
  position: fixed; inset: 0; z-index: 300;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: flex-end; justify-content: center;
  padding: 16px;
}
@media (min-width: 560px) { .tsheet-backdrop { align-items: center; } }
.tsheet {
  position: relative; width: 100%; max-width: 420px;
  max-height: calc(100vh - 32px); max-height: calc(100dvh - 32px); overflow-y: auto; -webkit-overflow-scrolling: touch;
  background: var(--ts-bg2); color: var(--ts-text);
  border: 1px solid var(--ts-border); border-radius: 12px;
  padding: 20px 20px 18px; font-family: var(--ts-sans);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
}
.tsheet-title { margin: 0 28px 12px 0; font-size: 18px; font-weight: 600; }
.tsheet-close {
  position: absolute; top: 10px; right: 10px;
  width: 32px; height: 32px; border: 0; border-radius: 8px;
  background: transparent; color: var(--ts-text-2); font-size: 22px; line-height: 1; cursor: pointer;
}
.tsheet-close:hover { background: var(--ts-bg3); color: var(--ts-text); }
.tsheet-body { display: flex; flex-direction: column; gap: 10px; }
.tsheet-form { display: flex; flex-direction: column; gap: 10px; }
.tsheet-btn {
  display: flex; flex-direction: column; gap: 3px; align-items: flex-start; text-align: left;
  width: 100%; padding: 12px 14px;
  background: var(--ts-bg3); color: var(--ts-text);
  border: 1px solid var(--ts-border); border-radius: var(--ts-radius);
  font-family: var(--ts-sans); font-size: 14px; cursor: pointer;
}
.tsheet-btn span { color: var(--ts-text-2); font-size: 12.5px; }
.tsheet-btn:hover { border-color: var(--ts-green); }
.tsheet-btn:disabled { opacity: 0.6; cursor: progress; }
.tsheet-btn-primary { background: var(--ts-green); color: #000; border-color: var(--ts-green); }
.tsheet-btn-primary span { color: rgba(0, 0, 0, 0.7); }
.tsheet-input {
  width: 100%; padding: 12px 14px; box-sizing: border-box;
  background: var(--ts-bg); color: var(--ts-text);
  border: 1px solid var(--ts-border); border-radius: var(--ts-radius);
  font-family: var(--ts-mono); font-size: 15px;
}
.tsheet-input:focus { outline: none; border-color: var(--ts-green); }
.tsheet-code { letter-spacing: 0.3em; text-align: center; font-size: 20px; }
.tsheet-note { margin: 0; color: var(--ts-text-2); font-size: 13px; line-height: 1.45; }
.tsheet-err { margin: 0; min-height: 1em; color: #f59e0b; font-size: 13px; }
.tsheet-links { display: flex; gap: 14px; }
.tsheet-link {
  background: none; border: 0; padding: 0; color: var(--ts-green);
  font-family: var(--ts-sans); font-size: 13px; cursor: pointer; text-decoration: underline;
}
.tsheet-link:disabled { color: var(--ts-text-3); cursor: default; text-decoration: none; }
.tsheet-rows { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; background: var(--ts-bg); border: 1px solid var(--ts-border); border-radius: var(--ts-radius); }
.tsheet-row { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
.tsheet-k { color: var(--ts-text-2); flex: 0 0 auto; }
.tsheet-v { text-align: right; word-break: break-word; }
.tsheet-mono { font-family: var(--ts-mono); font-size: 12px; }
.tsheet-actions { display: flex; flex-direction: column; gap: 8px; }
.tsheet-adv { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; background: var(--ts-bg); border: 1px dashed var(--ts-border); border-radius: var(--ts-radius); }
.tsheet-adv.hidden { display: none !important; }
.tsheet-adv-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13px; color: var(--ts-text-2); }
.tsheet-adv-in { width: 55%; padding: 8px 10px; font-size: 13px; }
.tsheet-link:disabled { color: var(--ts-text-3); cursor: default; text-decoration: none; }
.tsheet-addr {
  display: block; padding: 10px 12px; word-break: break-all;
  background: var(--ts-bg); border: 1px solid var(--ts-border); border-radius: var(--ts-radius);
  font-family: var(--ts-mono); font-size: 13px;
}
`;
  function injectStyles() {
    if (document.getElementById("tsheet-style")) return;
    const st = document.createElement("style");
    st.id = "tsheet-style";
    st.textContent = SHEET_CSS;
    document.head.appendChild(st);
  }

  function mount() {
    if (_sheet) return;
    injectStyles();
    _title = h("h3", { id: "tsheet-title", class: "tsheet-title" });
    _body  = h("div", { class: "tsheet-body" });
    const card = h("div", { class: "tsheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "tsheet-title" },
      h("button", { class: "tsheet-close", type: "button", "aria-label": "Close", onclick: () => close(null) }, "×"),
      _title, _body);
    _sheet = h("div", { class: "tsheet-backdrop hidden", onclick: (e) => { if (e.target === _sheet) close(null); } }, card);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && _sheet && !_sheet.classList.contains("hidden")) close(null); });
    document.body.appendChild(_sheet);
  }

  // Open the sheet with a title; resolves with whatever close() is given.
  function open(title) {
    mount();
    _title.textContent = title;
    _body.replaceChildren();
    _sheet.classList.remove("hidden");
    return new Promise((resolve) => { _onClose = resolve; });
  }

  function close(value) {
    if (!_sheet) return;
    _sheet.classList.add("hidden");
    const fn = _onClose; _onClose = null;
    if (fn) fn(value);
  }
  // Resolve the open promise but keep the sheet visible (pending state).
  function settle(value) {
    const fn = _onClose; _onClose = null;
    if (fn) fn(value);
  }

  function setBody(...nodes) {
    _body.replaceChildren(...nodes);
    const first = _body.querySelector("input, button");
    if (first) setTimeout(() => first.focus(), 30);
  }

  function errLine() { return h("p", { class: "tsheet-err", role: "alert" }); }

  // Method chooser: shown only when both a browser wallet and email are possible.
  function chooseMethod({ hasInjected } = {}) {
    const p = open("Connect to TimbSwap");
    const nodes = [];
    if (hasInjected) {
      nodes.push(h("button", { class: "tsheet-btn tsheet-btn-primary", type: "button", onclick: () => close("injected") },
        h("strong", { text: "Browser wallet" }),
        h("span", { text: "MetaMask, Brave, Coinbase or any injected wallet." })));
    }
    nodes.push(h("button", { class: "tsheet-btn", type: "button", onclick: () => close("email") },
      h("strong", { text: "Continue with email" }),
      h("span", { text: "No extension needed. A wallet is created for you and lives with your email." })));
    nodes.push(h("p", { class: "tsheet-note", text: "Either way TimbSwap only ever sees your public wallet address. You can switch methods any time from Disconnect." }));
    setBody(...nodes);
    return p;
  }

  // Full email flow: email → code → "wallet ready". Resolves { provider, address } or null.
  function login() {
    const p = open("Sign in with email");
    let email = "";

    function stepEmail(prefill) {
      const input = h("input", { class: "tsheet-input", type: "email", autocomplete: "email", inputmode: "email",
        placeholder: "you@example.com", value: prefill || "", "aria-label": "Email address" });
      const err = errLine();
      const btn = h("button", { class: "tsheet-btn tsheet-btn-primary", type: "submit" }, h("strong", { text: "Send code" }));
      const form = h("form", { class: "tsheet-form", onsubmit: async (e) => {
        e.preventDefault();
        email = input.value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = "Enter a valid email address."; return; }
        btn.disabled = true; btn.firstChild.textContent = "Sending…"; err.textContent = "";
        try {
          await sendCode(email);
          stepCode();
        } catch (ex) {
          err.textContent = friendly(ex, "Couldn't send the code. Check the address and try again.");
          btn.disabled = false; btn.firstChild.textContent = "Send code";
        }
      } }, input, err, btn);
      setBody(
        h("p", { class: "tsheet-note", text: "We'll email you a one-time code. Your email is handled by Privy; TimbSwap never stores it." }),
        form);
    }

    function stepCode() {
      const input = h("input", { class: "tsheet-input tsheet-code", type: "text", inputmode: "numeric", autocomplete: "one-time-code",
        pattern: "[0-9]*", maxlength: "6", placeholder: "6-digit code", "aria-label": "One-time code" });
      const err = errLine();
      const btn = h("button", { class: "tsheet-btn tsheet-btn-primary", type: "submit" }, h("strong", { text: "Verify" }));
      const resend = h("button", { class: "tsheet-link", type: "button", onclick: async () => {
        resend.disabled = true; err.textContent = "";
        try { await sendCode(email); resend.textContent = "Code re-sent"; }
        catch (ex) { err.textContent = friendly(ex, "Couldn't re-send. Try again in a moment."); resend.disabled = false; }
      } }, "Re-send code");
      const back = h("button", { class: "tsheet-link", type: "button", onclick: () => stepEmail(email) }, "Change email");
      const form = h("form", { class: "tsheet-form", onsubmit: async (e) => {
        e.preventDefault();
        const code = input.value.replace(/\D/g, "");
        if (code.length !== 6) { err.textContent = "Enter the 6-digit code from the email."; return; }
        btn.disabled = true; btn.firstChild.textContent = "Verifying…"; err.textContent = "";
        try {
          const w = await verifyCode(email, code);
          stepReady(w);
        } catch (ex) {
          err.textContent = friendly(ex, "That code didn't match. Try again.");
          btn.disabled = false; btn.firstChild.textContent = "Verify";
          input.select();
        }
      } }, input, err, btn, h("div", { class: "tsheet-links" }, resend, back));
      setBody(
        h("p", { class: "tsheet-note" }, "Code sent to ", h("strong", { text: email }), ". It expires in a few minutes."),
        form);
    }

    function stepReady(w) {
      const addr = h("code", { class: "tsheet-addr", text: w.address });
      const copy = h("button", { class: "tsheet-link", type: "button", onclick: async () => {
        try { await navigator.clipboard.writeText(w.address); copy.textContent = "Copied"; } catch (_e) { copy.textContent = "Select and copy the address above"; }
      } }, "Copy address");
      setBody(
        h("p", { class: "tsheet-note", text: "Your wallet is ready. This is its address on " + chainName() + ":" }),
        addr,
        h("div", { class: "tsheet-links" }, copy),
        h("p", { class: "tsheet-note", text: "It starts empty. To enter a ticket it needs a little ETH for gas and the entry cost — send some to this address first. Come back here any time with the same email." }),
        h("p", { class: "tsheet-note", text: "Every transaction or signature from this wallet asks you to confirm on this site first. Keep only what you are playing with in it." }),
        h("button", { class: "tsheet-btn tsheet-btn-primary", type: "button", onclick: () => close(w) }, h("strong", { text: "Continue" })));
    }

    stepEmail("");
    return p;
  }

  function chainName() {
    return (typeof CHAIN_NAME !== "undefined" && CHAIN_NAME) ? CHAIN_NAME : "Arbitrum";
  }

  // Map SDK errors to something a person can act on; fall back to `dflt`.
  function friendly(ex, dflt) {
    const m = String((ex && (ex.message || ex.privyErrorCode)) || "").toLowerCase();
    if (/rate|too many|429/.test(m))         return "Too many attempts. Wait a minute and try again.";
    if (/invalid.*code|incorrect|expired/.test(m)) return "That code didn't match or has expired. Try again.";
    if (/allowlist|not allowed|denied/.test(m)) return "This email isn't allowed to sign in here.";
    if (/network|fetch|failed to fetch|load/.test(m)) return "Network problem reaching the sign-in service. Try again.";
    if (/storage/.test(m))                   return "Your browser is blocking storage for this site (private mode or shields). Allow it and retry.";
    return dflt;
  }

  window.TimbEmailWallet = { available, chooseMethod, login, restore, logout, guard, registerCalls, registerContracts, get address() { return _address; } };
})();
