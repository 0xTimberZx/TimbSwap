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
    return provider;
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
  // is always fresh. Injected once, before the sheet is built.
  const SHEET_CSS = `
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
  background: var(--bg2); color: var(--text);
  border: 1px solid var(--border); border-radius: 12px;
  padding: 20px 20px 18px; font-family: var(--sans);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
}
.tsheet-title { margin: 0 28px 12px 0; font-size: 18px; font-weight: 600; }
.tsheet-close {
  position: absolute; top: 10px; right: 10px;
  width: 32px; height: 32px; border: 0; border-radius: 8px;
  background: transparent; color: var(--text-2); font-size: 22px; line-height: 1; cursor: pointer;
}
.tsheet-close:hover { background: var(--bg3); color: var(--text); }
.tsheet-body { display: flex; flex-direction: column; gap: 10px; }
.tsheet-form { display: flex; flex-direction: column; gap: 10px; }
.tsheet-btn {
  display: flex; flex-direction: column; gap: 3px; align-items: flex-start; text-align: left;
  width: 100%; padding: 12px 14px;
  background: var(--bg3); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius);
  font-family: var(--sans); font-size: 14px; cursor: pointer;
}
.tsheet-btn span { color: var(--text-2); font-size: 12.5px; }
.tsheet-btn:hover { border-color: var(--green); }
.tsheet-btn:disabled { opacity: 0.6; cursor: progress; }
.tsheet-btn-primary { background: var(--green); color: #000; border-color: var(--green); }
.tsheet-btn-primary span { color: rgba(0, 0, 0, 0.7); }
.tsheet-input {
  width: 100%; padding: 12px 14px; box-sizing: border-box;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius);
  font-family: var(--mono); font-size: 15px;
}
.tsheet-input:focus { outline: none; border-color: var(--green); }
.tsheet-code { letter-spacing: 0.3em; text-align: center; font-size: 20px; }
.tsheet-note { margin: 0; color: var(--text-2); font-size: 13px; line-height: 1.45; }
.tsheet-err { margin: 0; min-height: 1em; color: #f59e0b; font-size: 13px; }
.tsheet-links { display: flex; gap: 14px; }
.tsheet-link {
  background: none; border: 0; padding: 0; color: var(--green);
  font-family: var(--sans); font-size: 13px; cursor: pointer; text-decoration: underline;
}
.tsheet-link:disabled { color: var(--text-3); cursor: default; text-decoration: none; }
.tsheet-addr {
  display: block; padding: 10px 12px; word-break: break-all;
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius);
  font-family: var(--mono); font-size: 13px;
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

  window.TimbEmailWallet = { available, chooseMethod, login, restore, logout, get address() { return _address; } };
})();
