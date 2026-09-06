/* ============================================================
   DebugHub SDK
  Version: 1.3.4  (#debug local-only; first-party relay with compatibility fallback)

   Drop-in replacement for MyDapp/debughub/sdk/debugger.js.

   Usage: add this script tag BEFORE your app.js, and define
     window.DEBUGHUB_CONFIG = {
       appName:     "TimbSwap",
      // Optional first-party relay and direct compatibility sink. When
      // configured the SDK POSTs
       // every event to Supabase in addition to localStorage, so the
       // hub can aggregate across origins AND devices. Omit them and
       // the SDK behaves exactly like 1.1.0 (localStorage only).
      telemetryUrl: "https://timbswap.xyz/api/debughub_events",
      supabaseUrl: "https://REPLACE_WITH_MAINNET_SUPABASE_REF.supabase.co",
       supabaseKey: "REPLACE_WITH_MAINNET_SUPABASE_PUBLISHABLE_KEY"
     };
   before it loads. supabaseUrl/Key are read lazily (at send time), so
   a later script (e.g. config.js) may fill them in after this SDK loads.

   Exposes window.DebugHub with:
     startSession() / endSession()
     logCheckpoint(name, status)   status: "pass" | "fail"
     logError(functionName, error)
     logPerf(label, durationMs)
     logSecurity(name, status)     status: "pass" | "fail"
     openSnapshot()                render + share this browser's own record

   Appending #debug (or #snapshot / ?debug) to the URL arms the viewer path:
   auto-starts a session, captures uncaught errors, and mounts a floating
   snapshot button. See dev-docs/debughub-network/NOTES.md §3.
   ============================================================ */

(function () {
  "use strict";

  var SDK_VERSION = "1.3.4"; // 1.3.4: Brave provider-proxy `.on` guard + export-before-wiring
  var MAX_EVENTS = 200;

  var config = window.DEBUGHUB_CONFIG || {};
  var APP_NAME = config.appName || "Unknown";
  var STORAGE_KEY = APP_NAME + "_sessions";

  var storageOk = true;
  var currentSession = null; // { id, wallet, chainId, startedAt }

  // ---------- storage helpers ----------

  function testStorage() {
    try {
      var k = "__debughub_test__";
      localStorage.setItem(k, "1");
      localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
  function b64decode(str) { return decodeURIComponent(escape(atob(str))); }

  function loadEvents() {
    if (!storageOk) return [];
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      return JSON.parse(b64decode(raw));
    } catch (e) {
      return [];
    }
  }

  function saveEvents(events) {
    if (!storageOk) return;
    try {
      if (events.length > MAX_EVENTS) events = events.slice(events.length - MAX_EVENTS);
      localStorage.setItem(STORAGE_KEY, b64encode(JSON.stringify(events)));
    } catch (e) {
      storageOk = false;
      warn("Could not write to storage");
    }
  }

  function pushEvent(event) {
    // Local ring buffer (offline fallback + the 1.1.0 behaviour).
    if (storageOk) {
      var events = loadEvents();
      events.push(event);
      saveEvents(events);
    }
    // Remote sink (no-op when unconfigured).
    transmit(event);
  }

  // ---------- remote sink ----------

  function truncate(s, n) {
    if (s == null) return null;
    s = String(s);
    return s.length > n ? s.slice(0, n) : s;
  }

  // Fire-and-forget POST to the first-party relay, falling back to Supabase
  // during rollout. Read endpoints lazily so
  // a config script that runs after this SDK can still supply it. `keepalive`
  // lets the session_end event flush during beforeunload. All failures are
  // swallowed — telemetry must never affect the host app, and the event is
  // already in localStorage as a fallback.
  function transmit(event) {
    // Private-viewer mode: when the page is armed with #debug the session is
    // strictly local — hold back the sink entirely so an unauthorized viewer's
    // events never leave their device (checked lazily so a #debug added mid-
    // session takes effect immediately). This is what makes the snapshot's
    // "nothing uploaded" assurance literally true.
    if (snapshotArmed()) return;
    var cfg = window.DEBUGHUB_CONFIG || config;
    var relayUrl = cfg.telemetryUrl;
    var supabaseUrl = cfg.supabaseUrl;
    var key = cfg.supabaseKey;
    if ((!relayUrl && (!supabaseUrl || !key)) || typeof fetch !== "function") return;
    try {
      var row = {
        app:         event.app,
        type:        event.type,
        session_id:  event.sessionId || null,
        wallet:      event.wallet || null,
        chain_id:    (typeof event.chainId === "number") ? event.chainId : null,
        sdk_version: event.sdkVersion || null,
        name:        truncate(event.name, 200),
        status:      event.status || null,
        fn:          event.function || null,
        code:        (event.code !== undefined && event.code !== null) ? String(event.code) : null,
        message:     truncate(event.message, 2000),
        label:       truncate(event.label, 200),
        duration_ms: (typeof event.durationMs === "number") ? Math.round(event.durationMs) : null,
        event_ts:    event.timestamp || null
      };
      var send = function (url, headers) {
        return fetch(url, {
          method: "POST",
          headers: headers,
          body: JSON.stringify(row),
          keepalive: true,
          mode: "cors"
        });
      };
      var directUrl = supabaseUrl && supabaseUrl.replace(/\/+$/, "") + "/rest/v1/debughub_events";
      var directHeaders = {
        "apikey": key,
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
      };
      var relay = relayUrl
        ? send(relayUrl.replace(/\/+$/, ""), { "Content-Type": "application/json" })
        : Promise.reject(new Error("first-party relay unavailable"));
      relay.then(function (res) {
        if (res.ok || !directUrl) return res;
        return send(directUrl, directHeaders);
      }).catch(function () {
        if (directUrl) return send(directUrl, directHeaders);
        throw new Error("telemetry relay unavailable");
      }).then(function (res) {
        if (!res || res.ok || _sinkWarned) return;
        _sinkWarned = true;
        warn("telemetry upload rejected (HTTP " + res.status + ")");
      }).catch(function (err) {
        if (!_sinkWarned) {
          _sinkWarned = true;
          warn("telemetry upload failed (network/blocked/CORS): " + ((err && err.message) || err));
        }
      });
    } catch (e) { /* never throw from telemetry */ }
  }
  // One-time guard so a failing sink logs its reason ONCE, never per event.
  var _sinkWarned = false;

  // ---------- console feedback (silent unless storage fails) ----------

  function warn(msg) { console.warn("❌ DebugHub: " + msg); }
  function ok(msg)   { console.log("✅ DebugHub: " + msg); }

  // ---------- wallet / chain detection ----------

  function getWallet() {
    try {
      if (window.ethereum && window.ethereum.selectedAddress) return window.ethereum.selectedAddress.toLowerCase();
    } catch (e) {}
    return null;
  }

  function getChainId() {
    try {
      if (window.ethereum && window.ethereum.chainId) return parseInt(window.ethereum.chainId, 16);
    } catch (e) {}
    return null;
  }

  // ---------- session id ----------

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function genSessionId(wallet) {
    var now = new Date();
    var mmss = pad2(now.getMinutes()) + pad2(now.getSeconds());
    var walletPrefix = wallet ? wallet.slice(0, 5) : "0xNNN";
    return APP_NAME.toLowerCase() + "-" + mmss + "-" + walletPrefix;
  }

  // ---------- base event shape ----------

  function baseEvent(type) {
    return {
      type: type,
      sessionId: currentSession ? currentSession.id : null,
      app: APP_NAME,
      sdkVersion: SDK_VERSION,
      wallet: currentSession ? currentSession.wallet : getWallet(),
      chainId: currentSession ? currentSession.chainId : getChainId(),
      timestamp: Date.now()
    };
  }

  // ---------- public API ----------

  function startSession(walletOverride) {
    // Normalize case so the same wallet from different sources (checksummed
    // override vs lowercase eth_accounts/selectedAddress) never double-logs.
    var wallet = walletOverride || getWallet();
    if (wallet) wallet = wallet.toLowerCase();
    var chainId = getChainId();

    currentSession = { id: genSessionId(wallet), wallet: wallet, chainId: chainId, startedAt: Date.now() };

    pushEvent(baseEvent("session_start"));

    // A wallet extension that hasn't exposed an account yet is the NORMAL
    // first-paint state (not connected, or selectedAddress not yet populated).
    // Only report a failure if the backfill genuinely finds no account —
    // otherwise every ordinary page load logged a permanent security "fail".
    if (!wallet && window.ethereum) {
      backfillWallet(currentSession);
    }
    return currentSession.id;
  }

  function backfillWallet(session) {
    function noAccount() {
      if (currentSession !== session || currentSession.wallet) return;
      var sec = baseEvent("security");
      sec.name = "Wallet Detect";
      sec.status = "fail";
      pushEvent(sec);
    }
    try {
      window.ethereum.request({ method: "eth_accounts" }).then(function (accounts) {
        if (accounts && accounts.length > 0) {
          if (currentSession === session && !currentSession.wallet) {
            currentSession.wallet = accounts[0].toLowerCase();
          }
        } else {
          noAccount();
        }
      }).catch(noAccount);
    } catch (e) { noAccount(); }
  }

  function endSession() {
    if (!currentSession) return;
    pushEvent(baseEvent("session_end"));
    currentSession = null;
  }

  function logCheckpoint(name, status) {
    if (!currentSession) startSession();
    var evt = baseEvent("checkpoint");
    evt.name = name;
    evt.status = status || "pass";
    pushEvent(evt);
  }

  function logError(functionName, error) {
    if (!currentSession) startSession();
    var evt = baseEvent("error");
    evt.function = functionName;
    if (error && typeof error === "object") {
      evt.code = error.code !== undefined ? error.code : null;
      evt.message = error.message || String(error);
    } else {
      evt.code = null;
      evt.message = String(error);
    }
    pushEvent(evt);
  }

  function logPerf(label, durationMs) {
    if (!currentSession) startSession();
    var evt = baseEvent("perf");
    evt.label = label;
    evt.durationMs = durationMs;
    pushEvent(evt);
  }

  function logSecurity(name, status) {
    if (!currentSession) startSession();
    var evt = baseEvent("security");
    evt.name = name;
    evt.status = status || "fail";
    pushEvent(evt);
  }

  // ---------- wallet event wiring ----------

  function wireWalletEvents() {
    if (!window.ethereum) return;
    // Brave (and some multi-wallet / EIP-6963 setups) wrap window.ethereum in a
    // Proxy whose `on` is a read-only, non-configurable property; merely READING
    // `window.ethereum.on` then throws a V8 proxy-invariant TypeError. Guard every
    // access — an unguarded throw here aborted the SDK IIFE before window.DebugHub
    // was exported, dropping the whole page to the no-op stub and silently
    // capturing ZERO telemetry on Brave. Wallet-event wiring is a nicety; it must
    // never break the SDK. (Also defensively wrapped at the call site.)
    try {
      if (typeof window.ethereum.on !== "function") return;
      window.ethereum.on("accountsChanged", function (accounts) {
        if (!accounts || accounts.length === 0) {
          if (currentSession) {
            var sec = baseEvent("security");
            sec.name = "Wallet Dropped";
            sec.status = "pass"; // user disconnected/locked — lifecycle, not a fault
            pushEvent(sec);
          }
          endSession();
          return;
        }
        endSession();
        startSession(accounts[0]);
      });
      window.ethereum.on("disconnect", function () { endSession(); });
    } catch (e) {
      warn("wallet event wiring unavailable (provider proxy): " + ((e && e.message) || e));
    }
  }

  window.addEventListener("beforeunload", function () { endSession(); });

  // ---------- init ----------

  storageOk = testStorage();
  if (!storageOk) warn("localStorage unavailable - events will not be logged");
  else ok("ready (" + APP_NAME + " · v" + SDK_VERSION + ")");

  // Export the API FIRST, before any wallet/DOM wiring that could throw. Every
  // method below is a hoisted function declaration, so this is safe here — and it
  // guarantees a real SDK (not the no-op page stub) even if wiring later fails.
  window.DebugHub = {
    startSession: startSession,
    endSession: endSession,
    logCheckpoint: logCheckpoint,
    logError: logError,
    logPerf: logPerf,
    logSecurity: logSecurity,
    openSnapshot: openSnapshot   // callable directly if a dapp wants its own button
  };

  try { wireWalletEvents(); } catch (e) { warn("wireWalletEvents failed: " + ((e && e.message) || e)); }

  // ---------- local snapshot (unauthorized viewer path) ----------
  //
  // A friend who is NOT connected and has NO special access can append the URL
  // suffix (#debug) to turn on a floating snapshot button. It reads THIS dapp's
  // siloed local telemetry only (STORAGE_KEY is app-scoped), renders it, and
  // shares it via the OS share sheet. No file is ever uploaded to us and none
  // is downloaded to their device — the share is outbound, initiated by them.

  // True when this page has a network sink wired, i.e. transmit() will POST
  // events to the operator. Read lazily, exactly like transmit() does, since
  // the config may load after this SDK.
  function sinkConfigured() {
    var cfg = window.DEBUGHUB_CONFIG || config;
    return !!(cfg && cfg.supabaseUrl && cfg.supabaseKey);
  }

  // A sink is only ACTIVE if it is both configured and not suppressed by the
  // private-viewer switch. When #debug is armed, transmit() is a no-op, so the
  // honest statement is "nothing uploaded" even on a page that wires a sink.
  function sinkActive() {
    return sinkConfigured() && !snapshotArmed();
  }

  function snapshotArmed() {
    try {
      var h = (location.hash || "").toLowerCase();
      var q = (location.search || "").toLowerCase();
      return /(?:^|[#&/])(debug|snapshot|dbg)\b/.test(h) || /[?&](debug|snapshot|dbg)\b/.test(q);
    } catch (e) { return false; }
  }

  function summarize() {
    var ev = loadEvents();
    var sessions = {}, checks = {pass:0, fail:0}, errs = [], perfs = [], sec = {pass:0, fail:0};
    var first = null, last = null, wallet = null, chainId = null;
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      if (e.sessionId) sessions[e.sessionId] = 1;
      if (e.wallet) wallet = e.wallet;
      if (typeof e.chainId === "number") chainId = e.chainId;
      if (e.timestamp) { if (first === null) first = e.timestamp; last = e.timestamp; }
      if (e.type === "checkpoint") checks[e.status === "fail" ? "fail" : "pass"]++;
      else if (e.type === "security") sec[e.status === "fail" ? "fail" : "pass"]++;
      else if (e.type === "error") errs.push((e.function || "?") + ": " + truncate(e.message, 80));
      else if (e.type === "perf") perfs.push((e.label || "?") + " " + Math.round(e.durationMs || 0) + "ms");
    }
    var sessCount = 0; for (var k in sessions) if (sessions.hasOwnProperty(k)) sessCount++;
    return {
      app: APP_NAME, sdk: SDK_VERSION, total: ev.length, sessions: sessCount,
      checks: checks, sec: sec, errors: errs.slice(-6), perfs: perfs.slice(-4),
      wallet: wallet ? (wallet.slice(0,6) + "\u2026" + wallet.slice(-4)) : "not connected",
      chainId: chainId, first: first, last: last, recent: ev.slice(-10)
    };
  }

  function fmtTime(ts) {
    if (!ts) return "\u2014";
    try { var d = new Date(ts); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()); }
    catch (e) { return "\u2014"; }
  }

  function textSummary(s) {
    var L = [];
    L.push("DebugHub \u00b7 " + s.app + " \u00b7 local snapshot");
    L.push("wallet " + s.wallet + (s.chainId ? " \u00b7 chain " + s.chainId : ""));
    L.push(s.sessions + " session(s) \u00b7 " + s.total + " events \u00b7 " + fmtTime(s.first) + "\u2013" + fmtTime(s.last));
    L.push("checkpoints " + s.checks.pass + "\u2713 / " + s.checks.fail + "\u2717 \u00b7 security " + s.sec.pass + "\u2713 / " + s.sec.fail + "\u2717");
    if (s.errors.length) { L.push("errors:"); for (var i=0;i<s.errors.length;i++) L.push("  \u2717 " + s.errors[i]); }
    if (s.perfs.length) L.push("perf: " + s.perfs.join(" \u00b7 "));
    return L.join("\n");
  }

  // Render the snapshot to a canvas so it can be shared as an image ("screenshot")
  // with no external library and no download.
  function renderCanvas(s) {
    var W = 720, pad = 28, line = 26, y = pad;
    var rows = 8 + s.errors.length + (s.perfs.length ? 1 : 0) + s.recent.length + 4;
    var H = pad * 2 + rows * line + 40;
    var c = document.createElement("canvas");
    var dpr = Math.min(3, window.devicePixelRatio || 1);
    c.width = W * dpr; c.height = H * dpr;
    var g = c.getContext("2d"); g.scale(dpr, dpr);
    g.fillStyle = "#0a130d"; g.fillRect(0, 0, W, H);
    g.fillStyle = "#d7b34c"; g.font = "700 22px Georgia, serif";
    g.fillText("DebugHub \u00b7 " + s.app, pad, y + 20); y += line + 8;
    g.font = "14px ui-monospace, Menlo, monospace"; g.fillStyle = "#cdd8cf";
    function row(t, col) { g.fillStyle = col || "#cdd8cf"; g.fillText(t, pad, y + 14); y += line; }
    row("wallet  " + s.wallet + (s.chainId ? "   chain " + s.chainId : ""), "#9fb4a4");
    row(s.sessions + " session(s)   " + s.total + " events   " + fmtTime(s.first) + "\u2013" + fmtTime(s.last), "#9fb4a4");
    row("checkpoints  " + s.checks.pass + " pass / " + s.checks.fail + " fail", s.checks.fail ? "#e88" : "#6fe0a0");
    row("security     " + s.sec.pass + " pass / " + s.sec.fail + " fail", s.sec.fail ? "#e88" : "#6fe0a0");
    y += 6;
    if (s.errors.length) { row("errors", "#e88"); for (var i=0;i<s.errors.length;i++) row("  \u2717 " + s.errors[i], "#e88"); }
    if (s.perfs.length) row("perf  " + s.perfs.join("   "), "#9fb4a4");
    y += 6; row("recent", "#8fa295");
    for (var j=0;j<s.recent.length;j++) {
      var e = s.recent[j];
      var lbl = e.type + (e.name ? " " + e.name : (e.function ? " " + e.function : (e.label ? " " + e.label : "")));
      var mark = e.status === "fail" ? "\u2717" : (e.status === "pass" ? "\u2713" : "\u00b7");
      row("  " + fmtTime(e.timestamp) + " " + mark + " " + truncate(lbl, 60),
          e.status === "fail" ? "#e88" : "#cdd8cf");
    }
    g.fillStyle = "#6d7a70"; g.font = "12px ui-monospace, monospace";
    g.fillText("SDK v" + s.sdk + "  \u00b7  " +
      (sinkActive() ? "snapshot is local, not uploaded" : "local only, nothing uploaded"), pad, H - 16);
    return c;
  }

  function overlay(canvas, s) {
    var wrap = document.createElement("div");
    wrap.setAttribute("style", "position:fixed;inset:0;z-index:2147483647;background:rgba(3,10,7,.86);" +
      "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:18px;overflow:auto");
    canvas.setAttribute("style", "max-width:100%;height:auto;border:1px solid #a98a34;border-radius:12px;box-shadow:0 20px 60px -20px #000");
    var btns = document.createElement("div");
    btns.setAttribute("style", "display:flex;gap:10px;flex-wrap:wrap;justify-content:center");
    function mk(label, primary) {
      var b = document.createElement("button");
      b.textContent = label;
      b.setAttribute("style", "font:600 14px Georgia,serif;padding:11px 20px;border-radius:9px;cursor:pointer;" +
        (primary ? "background:#d7b34c;color:#0c1712;border:1px solid #d7b34c" : "background:transparent;color:#d7b34c;border:1px solid #a98a34"));
      return b;
    }
    var shareBtn = mk("Share snapshot", true);
    var closeBtn = mk("Close", false);
    var note = document.createElement("div");
    note.setAttribute("style", "color:#9fb4a4;font:12px ui-monospace,monospace;text-align:center;max-width:60ch");
    // The SNAPSHOT is never uploaded \u2014 but the underlying events are, on any
    // page that configures a sink (transmit() POSTs each one as it happens).
    // Saying "nothing is uploaded" there would be false, so tell the truth per
    // page instead of asserting the SwapTables case everywhere.
    note.textContent = sinkActive()
      ? "This snapshot is never uploaded \u2014 sharing sends it out through your own apps. Note this app also reports its own diagnostics to the operator."
      : "Your local record only \u2014 nothing is uploaded or downloaded. Share sends it out through your own apps.";
    shareBtn.onclick = function () { shareCanvas(canvas, s, note); };
    closeBtn.onclick = function () { document.body.removeChild(wrap); };
    btns.appendChild(shareBtn); btns.appendChild(closeBtn);
    wrap.appendChild(canvas); wrap.appendChild(btns); wrap.appendChild(note);
    document.body.appendChild(wrap);
  }

  function shareCanvas(canvas, s, note) {
    // 1) image share (the "screenshot") where the device supports file sharing
    function textShare() {
      if (navigator.share) {
        navigator.share({ title: s.app + " \u00b7 DebugHub", text: textSummary(s) })
          .catch(function () { copyFallback(); });
      } else copyFallback();
    }
    function copyFallback() {
      // no Web Share at all (desktop): copy text, and the image is already on
      // screen for a manual OS screenshot. Never a file download.
      try {
        navigator.clipboard.writeText(textSummary(s));
        if (note) note.textContent = "Copied the summary \u2014 or screenshot the card above with your device.";
      } catch (e) {
        if (note) note.textContent = "Screenshot the card above with your device to share it.";
      }
    }
    try {
      canvas.toBlob(function (blob) {
        if (blob && navigator.canShare) {
          try {
            var file = new File([blob], s.app.toLowerCase() + "-debug.png", { type: "image/png" });
            if (navigator.canShare({ files: [file] })) {
              navigator.share({ files: [file], title: s.app + " \u00b7 DebugHub" })
                .catch(function () { textShare(); });
              return;
            }
          } catch (e) {}
        }
        textShare();
      }, "image/png");
    } catch (e) { textShare(); }
  }

  function openSnapshot() {
    var s = summarize();
    overlay(renderCanvas(s), s);
  }

  function mountSnapshotButton() {
    if (document.getElementById("__debughub_snap")) return;
    var b = document.createElement("button");
    b.id = "__debughub_snap";
    b.textContent = "\uD83D\uDC1B snapshot";
    b.setAttribute("style", "position:fixed;right:12px;bottom:12px;z-index:2147483646;" +
      "font:600 13px Georgia,serif;padding:10px 15px;border-radius:22px;cursor:pointer;" +
      "background:#0e1a13;color:#d7b34c;border:1px solid #a98a34;box-shadow:0 6px 18px -6px #000");
    b.onclick = openSnapshot;
    document.body.appendChild(b);
  }

  function armSnapshot() {
    if (!snapshotArmed()) return;
    // capture uncaught errors too, so even a lightly-instrumented page has a
    // useful local record for the viewer.
    window.addEventListener("error", function (e) {
      try { logError("window.onerror", (e && e.error) || (e && e.message) || e); } catch (x) {}
    });
    window.addEventListener("unhandledrejection", function (e) {
      try { logError("unhandledrejection", (e && e.reason) || e); } catch (x) {}
    });
    if (!currentSession) startSession();          // log without waiting for connect
    if (document.body) mountSnapshotButton();
    else window.addEventListener("DOMContentLoaded", mountSnapshotButton);
    window.addEventListener("hashchange", function () { if (snapshotArmed()) mountSnapshotButton(); });
  }

  // window.DebugHub was exported above, before wallet wiring, so a throw there
  // can never drop the page to the no-op stub.
  try { armSnapshot(); } catch (e) { warn("armSnapshot failed: " + ((e && e.message) || e)); }
})();
