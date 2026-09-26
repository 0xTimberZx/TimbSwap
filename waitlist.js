// waitlist.js — mainnet capture layer.
//
// Posts to the same-origin Worker route POST /api/waitlist (workers/timbswap-api.js),
// which relays to the Supabase `waitlist` edge function. Same-origin so Brave
// Shields / adblockers treat the signup as first-party (same reasoning as the RPC
// proxy in config.js). Degrades safely: any failure shows an inline retry message
// and never throws past the handler. No wallet, no ethers — standalone.
(function () {
  var form = document.getElementById("wl-form");
  if (!form) return;

  var STORE_KEY = "timbswap_waitlist_done";
  var emailEl  = document.getElementById("wl-email");
  var walletEl = document.getElementById("wl-wallet");
  var tgEl     = document.getElementById("wl-tg");
  var btn      = document.getElementById("wl-submit");
  var msgEl    = document.getElementById("wl-msg");
  var okEl     = document.getElementById("wl-success");

  // ── Turnstile (anti-bot). Renders only when config.js sets TURNSTILE_SITE_KEY;
  // the waitlist function verifies the token once its TURNSTILE_SECRET is set.
  // With no site key the form behaves exactly as before.
  var tsToken = "";
  var tsWidget = null;
  function renderTurnstile() {
    var key = window.TURNSTILE_SITE_KEY;
    var el = document.getElementById("wl-turnstile");
    if (!el || !key || !window.turnstile || tsWidget !== null) return;
    try {
      tsWidget = window.turnstile.render("#wl-turnstile", {
        sitekey: key,
        callback: function (t) { tsToken = t; },
        "expired-callback": function () { tsToken = ""; },
        "error-callback": function () { tsToken = ""; },
        theme: "dark"
      });
    } catch (e) { /* widget optional */ }
  }
  function resetTurnstile() {
    tsToken = "";
    try { if (tsWidget !== null) window.turnstile.reset(tsWidget); } catch (e) {}
  }
  (function waitForTurnstile(tries) {
    if (window.turnstile) { renderTurnstile(); return; }
    if (tries <= 0) return;
    setTimeout(function () { waitForTurnstile(tries - 1); }, 300);
  })(40);

  // ── Attribution: capture UTM + referrer once, on first landing, and keep it in
  // sessionStorage so it survives to whichever page the visitor submits from.
  var ATTR_KEY = "timbswap_attr";
  function captureAttribution() {
    try {
      if (sessionStorage.getItem(ATTR_KEY)) return;
      var q = new URLSearchParams(location.search);
      var attr = {
        utm_source:   q.get("utm_source")   || "",
        utm_medium:   q.get("utm_medium")   || "",
        utm_campaign: q.get("utm_campaign") || "",
        ref:          (document.referrer || "").slice(0, 300),
        landing:      (location.pathname || "/").slice(0, 200),
        ts:           Date.now()
      };
      sessionStorage.setItem(ATTR_KEY, JSON.stringify(attr));
    } catch (e) { /* private mode — attribution is best-effort */ }
  }
  function readAttribution() {
    try { return JSON.parse(sessionStorage.getItem(ATTR_KEY) || "{}"); }
    catch (e) { return {}; }
  }
  captureAttribution();

  function showMsg(text) {
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.hidden = false;
  }
  function clearMsg() { if (msgEl) msgEl.hidden = true; }

  function showSuccess() {
    form.hidden = true;
    if (okEl) okEl.hidden = false;
  }

  // Escape hatch: shared device or a second address. Clears the remembered
  // flag and brings the form back; the server still dedupes by email.
  var resetEl = document.getElementById("wl-reset");
  if (resetEl) resetEl.addEventListener("click", function (e) {
    e.preventDefault();
    try { localStorage.removeItem(STORE_KEY); } catch (e2) {}
    if (okEl) okEl.hidden = true;
    form.hidden = false;
    resetTurnstile();
    clearMsg();
    if (emailEl) { emailEl.value = ""; emailEl.focus(); }
  });

  // If this browser already joined, show the thank-you and skip the form.
  try {
    if (localStorage.getItem(STORE_KEY)) showSuccess();
  } catch (e) { /* storage blocked — just show the form */ }

  var EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    clearMsg();

    var email = (emailEl.value || "").trim();
    if (!EMAIL_RE.test(email)) {
      showMsg("Please enter a valid email address.");
      emailEl.focus();
      return;
    }

    var wallet = ((walletEl && walletEl.value) || "").trim();
    if (wallet && !WALLET_RE.test(wallet)) {
      showMsg("That wallet doesn't look right — leave it blank or use a 0x… address.");
      return;
    }
    var tg = ((tgEl && tgEl.value) || "").trim().replace(/^@+/, "").slice(0, 40);

    if (tsWidget !== null && !tsToken) {
      showMsg("Please complete the human check first.");
      return;
    }

    var attr = readAttribution();
    var payload = {
      email: email,
      wallet: wallet || null,
      telegram: tg || null,
      source: "landing",
      ref: attr.ref || "",
      landing: attr.landing || location.pathname,
      utm: {
        source:   attr.utm_source   || "",
        medium:   attr.utm_medium   || "",
        campaign: attr.utm_campaign || ""
      },
      cfTurnstileToken: tsToken || ""
    };

    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = "Joining…";

    fetch("/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, body: b }; });
      })
      .then(function (res) {
        if (res.ok && res.body && res.body.ok) {
          try { localStorage.setItem(STORE_KEY, "1"); } catch (e) {}
          showSuccess();
        } else {
          var reason = (res.body && res.body.error) || "Something went wrong. Please try again in a moment.";
          showMsg(reason);
          resetTurnstile();
          btn.disabled = false;
          btn.textContent = label;
        }
      })
      .catch(function () {
        showMsg("Network hiccup — please try again.");
        resetTurnstile();
        btn.disabled = false;
        btn.textContent = label;
      });
  });
})();
