// faucet.js — TimbSwap faucet claim page.
//
// The page never sends on-chain. handleClaim() POSTs { address, cfTurnstileToken }
// to the same-origin Worker route /api/faucet-claim (→ Supabase faucet-claim edge
// fn), which validates eligibility + Turnstile, reserves a 24h slot, and returns
// 202. The keeper (scripts/faucet-worker.js) then calls GasFaucet.dispense().
//
// Shared globals come from config.js: connectWallet, disconnectWallet,
// autoReconnect, listenForAccountChanges, userAddress, fmtAddr, applyWalletChrome.

const FAUCET_ENDPOINT = "/api/faucet-claim";

let turnstileToken = "";
let turnstileWidgetId = null;

// ─── Shared nav controls ────────────────────────────────────────────────────────
function toggleMobileNav() {
  document.getElementById("mobile-nav").classList.toggle("open");
}
function toggleWalletMenu(e) {
  e.stopPropagation();
  document.getElementById("wallet-info").classList.toggle("open");
}
document.addEventListener("click", function (e) {
  const nav = document.getElementById("mobile-nav");
  const btn = document.querySelector(".nav-hamburger");
  if (nav && btn && !nav.contains(e.target) && !btn.contains(e.target)) nav.classList.remove("open");
  const wi = document.getElementById("wallet-info");
  if (wi && !wi.contains(e.target)) wi.classList.remove("open");
});

// fmtAddr is defined in config.js; fall back defensively.
function _fmt(a) {
  try { return fmtAddr(a); } catch { return a ? a.slice(0, 6) + "…" + a.slice(-4) : ""; }
}

// ─── Turnstile ──────────────────────────────────────────────────────────────────
function renderTurnstile() {
  const siteKey = window.TURNSTILE_SITE_KEY;
  const el = document.getElementById("turnstile-widget");
  if (!el || !siteKey || !window.turnstile || turnstileWidgetId !== null) return;
  try {
    turnstileWidgetId = window.turnstile.render("#turnstile-widget", {
      sitekey: siteKey,
      callback: (t) => { turnstileToken = t; },
      "expired-callback": () => { turnstileToken = ""; },
      "error-callback": () => { turnstileToken = ""; },
      theme: "auto",
    });
  } catch (_e) { /* widget optional */ }
}
function resetTurnstile() {
  turnstileToken = "";
  try { if (turnstileWidgetId !== null) window.turnstile.reset(turnstileWidgetId); } catch (_e) {}
}
// The api.js loads async; poll briefly until turnstile is ready, then render.
(function waitForTurnstile(tries) {
  if (window.turnstile) { renderTurnstile(); return; }
  if (tries <= 0) return;
  setTimeout(() => waitForTurnstile(tries - 1), 300);
})(40);

// ─── Claim button state ─────────────────────────────────────────────────────────
function setClaimEnabled(on, label) {
  const b = document.getElementById("faucet-claim-btn");
  if (!b) return;
  b.disabled = !on;
  if (label) b.textContent = label;
}
function setStatus(msg, kind) {
  const s = document.getElementById("faucet-status");
  if (!s) return;
  s.textContent = msg || "";
  s.className = "faucet-status" + (kind ? " " + kind : "");
}

// ─── Connect / disconnect ─────────────────────────────────────────────────────────
async function handleConnect() {
  DebugHub.logCheckpoint("Wallet Connect Requested", "pass");
  const ok = await connectWallet();
  if (!ok) { DebugHub.logCheckpoint("Wallet Connect Failed", "fail"); return; }

  DebugHub.startSession(userAddress);
  DebugHub.logCheckpoint("Wallet Connected", "pass");
  onConnected(userAddress);

  listenForAccountChanges(async (newAddr) => {
    if (!newAddr) { handleDisconnect(); return; }
    document.getElementById("wallet-addr").textContent = _fmt(newAddr);
    onConnected(newAddr);
  });
}

// What a claim pays: ETH in the capped beta (TIMBS not yet distributed).
const CLAIM_LABEL = TIMBS_LIVE ? "Claim testnet TIMBS" : "Claim ETH";

const FAUCET_READ_ABI = [
  "function lastClaimAt(address) view returns (uint256)",
  "function resetGrantedAt(address) view returns (uint256)",
];

// Top trader of a round gets their cooldown lifted (GasFaucet.grantReset).
// Tell them, so the reset doesn't go unused.
async function showResetNotice(addr) {
  try {
    const f = new ethers.Contract(ADDRESSES.GasFaucet, FAUCET_READ_ABI, sharedReadProvider());
    const [last, grant] = await Promise.all([f.lastClaimAt(addr), f.resetGrantedAt(addr)]);
    if (!last.isZero() && last.lt(grant) && addr === userAddress) {
      setStatus("Top trader last round: your cooldown is reset. Claim again now.", "ok");
    }
  } catch (_e) { /* older faucet without resets: nothing to show */ }
}

function onConnected(addr) {
  document.getElementById("connect-btn").classList.add("hidden");
  document.getElementById("wallet-info").classList.remove("hidden");
  document.getElementById("network-badge").classList.remove("hidden");
  document.getElementById("wallet-addr").textContent = _fmt(addr);
  document.getElementById("faucet-addr").textContent = addr;
  setClaimEnabled(true, CLAIM_LABEL);
  setStatus("");
  showResetNotice(addr);
}

function handleDisconnect() {
  DebugHub.endSession();
  disconnectWallet();
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
  document.getElementById("faucet-addr").textContent = "Connect a wallet to claim.";
  setClaimEnabled(false, "Connect wallet to claim");
  setStatus("");
}

// ─── Claim ────────────────────────────────────────────────────────────────────────
async function handleClaim() {
  if (!userAddress) { setStatus("Connect a wallet first.", "warn"); return; }
  if (window.TURNSTILE_SITE_KEY && !turnstileToken) {
    setStatus("Complete the human check above, then claim.", "warn");
    return;
  }
  setClaimEnabled(false, "Claiming…");
  setStatus("Reserving your claim…");
  DebugHub.logCheckpoint("Faucet Claim Requested", "pass");

  try {
    const res = await fetch(FAUCET_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: userAddress, cfTurnstileToken: turnstileToken }),
    });
    let body = {};
    try { body = await res.json(); } catch (_e) {}

    if (res.status === 202 || body.ok) {
      setStatus(TIMBS_LIVE
        ? "Your testnet TIMBS is on the way — it lands in your wallet within a minute. 🌲"
        : "Your ETH is on the way, with a matching share to the pot. It lands within a minute.", "ok");
      DebugHub.logCheckpoint("Faucet Claim Queued", "pass");
      setClaimEnabled(false, "Queued ✓");
    } else {
      const msg = body.error || "Couldn't claim right now — try again shortly.";
      setStatus(msg, "warn");
      DebugHub.logCheckpoint("Faucet Claim Rejected", "fail");
      setClaimEnabled(true, CLAIM_LABEL);
    }
  } catch (e) {
    setStatus("Network error — please try again.", "warn");
    DebugHub.logError("handleClaim", e);
    setClaimEnabled(true, CLAIM_LABEL);
  } finally {
    resetTurnstile(); // one solve per attempt
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────────
(async function init() {
  setClaimEnabled(false, "Connect wallet to claim");
  // Reveal the "+ real TIMB" explainer only when the airdrop leg is live.
  try {
    if (window.AIRDROP_ENABLED) {
      const a = document.getElementById("faucet-airdrop");
      if (a) a.hidden = false;
    }
  } catch (_e) {}
  try {
    const addr = await autoReconnect();
    if (addr) {
      DebugHub.startSession(addr);
      onConnected(addr);
      listenForAccountChanges(async (newAddr) => {
        if (!newAddr) { handleDisconnect(); return; }
        onConnected(newAddr);
      });
    }
  } catch (_e) {}
})();
