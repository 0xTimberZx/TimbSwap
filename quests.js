// quests.js — Timber Points leaderboard + "check my rank".
//
// Reads the same-origin Worker route POST /api/quests (workers/timbswap-api.js),
// which relays to the Supabase `quests` edge function. Read-only, standalone, no
// ethers dependency: the board loads for everyone; the "your standing" lookup uses
// either the connected wallet (window.userAddress, set by config.js) or a pasted
// address. Degrades safely on any failure.
(function () {
  var API = "/api/quests";
  var board    = document.getElementById("qs-board");
  var seasonEl = document.getElementById("qs-season");
  var youWrap  = document.getElementById("qs-you");
  var addrIn   = document.getElementById("qs-addr");
  var checkBtn = document.getElementById("qs-check");

  var WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
  function short(a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : ""; }
  function tp(n) { return Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 }); }

  function renderBoard(d) {
    if (seasonEl) {
      seasonEl.textContent = d && d.season
        ? (d.season.name + " · " + d.season.status + (d.season.last_round ? " · through round " + d.season.last_round : ""))
        : "No active season yet — scoring opens soon.";
    }
    if (!board) return;
    var rows = (d && d.leaderboard) || [];
    if (!rows.length) {
      board.innerHTML = '<tr><td colspan="6" class="qs-empty">No scores yet — be the first: make an eligible swap and enter a round.</td></tr>';
      return;
    }
    board.innerHTML = rows.map(function (r) {
      return '<tr>'
        + '<td class="qs-rank">' + r.rank + '</td>'
        + '<td class="qs-addr" title="' + r.address + '">' + short(r.address)
            + (r.diversity ? ' <span class="qs-badge" title="Diversity bonus">✦</span>' : '') + '</td>'
        + '<td class="qs-tp">' + tp(r.display_tp) + '</td>'
        + '<td>' + r.rounds_played + '</td>'
        + '<td>' + r.swap_count + '</td>'
        + '<td>' + (r.best_streak || 0) + '</td>'
        + '</tr>';
    }).join("");
  }

  function renderYou(you) {
    if (!youWrap) return;
    if (!you) { youWrap.hidden = true; return; }
    youWrap.hidden = false;
    if (you.flagged) {
      youWrap.innerHTML = '<div class="qs-you-card flagged"><div class="qs-you-h">' + short(you.address)
        + '</div><div class="qs-you-sub">This wallet is under review and excluded from the board.</div></div>';
      return;
    }
    if (!you.display_tp) {
      youWrap.innerHTML = '<div class="qs-you-card"><div class="qs-you-h">No points yet for ' + short(you.address)
        + '</div><div class="qs-you-sub">Make an eligible swap and enter a round to get on the board.</div></div>';
      return;
    }
    youWrap.innerHTML = '<div class="qs-you-card">'
      + '<div class="qs-you-h">' + short(you.address) + ' — <strong>' + tp(you.display_tp) + ' TP</strong>'
        + (you.rank ? ' · rank #' + you.rank : '') + '</div>'
      + '<div class="qs-you-sub">' + you.rounds_played + ' rounds · ' + you.swap_count + ' swaps · streak '
        + (you.best_streak || 0) + (you.diversity ? ' · diversity ✦' : '') + '</div></div>';
  }

  function load(address) {
    var body = address ? JSON.stringify({ address: address }) : "{}";
    return fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: body })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) throw new Error("bad");
        renderBoard(d);
        if (address) renderYou(d.you);
        return d;
      })
      .catch(function () {
        if (board && !board.children.length) {
          board.innerHTML = '<tr><td colspan="6" class="qs-empty">Leaderboard unavailable right now — try again shortly.</td></tr>';
        }
      });
  }

  if (checkBtn) {
    checkBtn.addEventListener("click", function () {
      var a = (addrIn && addrIn.value || "").trim();
      if (WALLET_RE.test(a)) load(a);
      else renderYou({ address: a || "that address", display_tp: 0, rounds_played: 0, swap_count: 0, best_streak: 0, diversity: false, flagged: false });
    });
  }

  // The page's wallet-connect glue calls this once an address is known.
  window.questsCheck = function (addr) { if (addr && WALLET_RE.test(addr)) load(addr); };

  load();
  setInterval(function () { if (!document.hidden) load(window.userAddress || undefined); }, 60000);
})();
