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
      }
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
          btn.disabled = false;
          btn.textContent = label;
        }
      })
      .catch(function () {
        showMsg("Network hiccup — please try again.");
        btn.disabled = false;
        btn.textContent = label;
      });
  });
})();
