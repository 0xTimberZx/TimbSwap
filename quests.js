// quests.js — Timber Points leaderboard + "check my rank".
//
// Reads the same-origin Worker route POST /api/quests (workers/timbswap-api.js),
// which relays to the Supabase `quests` edge function. Read-only, standalone, no
// ethers dependency: the board loads for everyone; the "your standing" lookup uses
// either the connected wallet or a pasted address, and the minute refresh
// re-checks whichever address was looked up last. config.js declares
// `let userAddress` at the top level of a classic script, which is a global
// binding but NOT a property of window, so it is read by name below.
// Degrades safely on any failure.
(function () {
  var API = "/api/quests";
  var board    = document.getElementById("qs-board");
  var seasonEl = document.getElementById("qs-season");
  var youWrap  = document.getElementById("qs-you");
  var addrIn   = document.getElementById("qs-addr");
  var checkBtn = document.getElementById("qs-check");

  var WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

  // Wallets with an accepted report in the testnet bug bounty (closed
  // 2026-10-26), plus its two goodwill credits: the payout addresses,
  // lowercased. Addresses only, never names.
  var HUNTERS = {
    "0x121189da04911de3e435d647ec9d4013e557b719": 1,
    "0x19759f22e87503aeb420513c56d8d9a1258016b2": 1,
    "0x1be63f23b7e98f63958b8383414921cf44084012": 1,
    "0x2d18c50ff5d3def2267d67aee33ee4133c626a11": 1,
    "0x34048f45c1956f3980b8e574fd2327407917dc32": 1,
    "0x43617ef72a6e416719293def2a654b4f35a51a52": 1,
    "0x4518250ee857783e82e77834e127d4026effa0e6": 1,
    "0x466c3fd811569b8bc92c74a3962db4cb43541152": 1,
    "0x494132bd5c224b3ef910d660d3bf047693acfd5f": 1,
    "0x4bbf51d66488360a956efb4a885337f99cfb6af0": 1,
    "0x4f7e3465e24eb35c3a5759d04b6c4e44b0e4fe60": 1,
    "0x507fd90dd7377743f65ca5fd03a113f490ea8ba1": 1,
    "0x53a5770718fce6e7c7bd78294b10e2b967d452c1": 1,
    "0x598c6a4aa26360e186cae27ae090acbeae7a5fe5": 1,
    "0x6a97c7f229a61864b224479986ed5d1821cd6055": 1,
    "0x800f6001ed9f177f6842cfdba473b0cfaca9f18a": 1,
    "0x8640b015e64772e9ccc023ea62869187dce54d2d": 1,
    "0x8714ef88e4db4c536fa8e55eae9c96599c59e44a": 1,
    "0x8d597222cfc0eec1b0b635706792a5a7106fbf59": 1,
    "0x8d640d8e9e02446b9fb519c16f07d04dc332dbcf": 1,
    "0x95ae4ae2c150930aba8930826dc6b8fe26bd377b": 1,
    "0x9621de4630a891cd494d316dc7a3099b0dcf5474": 1,
    "0x9c4dba59965a3689c22627348add60b29de164a9": 1,
    "0x9cd1e8e953ed018bfb5af4c75f2efe4bdfaf616a": 1,
    "0x9ed2f406cb1735fe1cb2cdfbf67c6fe71a19800d": 1,
    "0xa40bea7c289599e907ed73538331474e1cf5bc8f": 1,
    "0xa867dd7ca3aabdab29e7ab7574a9964d7d6b0b9a": 1,
    "0xa97339a54ddd31d30b151aa3e1692a5e7864021d": 1,
    "0xac81d62552a537d20c7a9a5ff051dc9e0ca5b4d7": 1,
    "0xb4ec97d4abd67af7ffca146265e098477ffbcea3": 1,
    "0xb5dd286935e295efd0e96661f0f9def6385b8011": 1,
    "0xb62ca5b9e36264e99df5adff75771b09f45a93e7": 1,
    "0xb6c9a4b6b17ef39d909be8ebf82c32c73a98453d": 1,
    "0xb924d8f1b294b3152eb37db0e0cffb529b47fc13": 1,
    "0xbda087645f96b8c64f15b08875332edb8bc19611": 1,
    "0xcd6fd689dfb9b8a17f5e78b93be81ca01428c701": 1,
    "0xdc3a32ef58e61cfc41604bda06ae72e8a2cd0cc4": 1,
    "0xde0868270bde486c1fffb83ed3e752a924990ffd": 1,
    "0xe62b12129a5a9a5a25b32b343af3db650d59ead3": 1,
    "0xe98f5fabac3dce7652721bd71abc668cb2a1523d": 1,
    "0xea56cabcc558d2ca29ca990401cc1ab1c9ba97f1": 1,
    "0xed49eada97f9053aabb6506797208bb81d1ef5ad": 1,
    "0xedb8279130e9815d510b261291d60024fc2fcae9": 1,
    "0xf17031c2aeb1ac3b55d076c235a0cf0f2bd64a37": 1,
    "0xf7b6dbd705f71d3ccd3d43e5bbb78d31a5c7bbca": 1,
    "0xfa33a22d2cc6f497888036f3b34dde59e6e79533": 1,
    "0xfd06e9421f737024b3216afffcfe5f4f8341526a": 1
  };
  function isHunter(a) { return HUNTERS[String(a || "").toLowerCase()] === 1; }
  var HUNTER_BADGE = ' <span class="qs-badge" title="Bug bounty hunter: accepted report in the testnet bounty" aria-label="Bug bounty hunter">🛡️</span>';
  var lastAddr = null; // last address whose standing was looked up
  function connectedAddress() {
    try { if (typeof userAddress !== "undefined" && userAddress) return userAddress; } catch (e) {}
    return window.userAddress || null;
  }
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
            + (isHunter(r.address) ? HUNTER_BADGE : '')
            + (r.diversity ? ' <span class="qs-badge" title="Explorer: used 3+ TimbSwap features" aria-label="Explorer">⚡</span>' : '') + '</td>'
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
      youWrap.innerHTML = '<div class="qs-you-card"><div class="qs-you-h">No points yet for ' + short(you.address) + (isHunter(you.address) ? HUNTER_BADGE : '')
        + '</div><div class="qs-you-sub">Make an eligible swap and enter a round to get on the board.</div></div>';
      return;
    }
    youWrap.innerHTML = '<div class="qs-you-card">'
      + '<div class="qs-you-h">' + short(you.address) + (isHunter(you.address) ? HUNTER_BADGE : '') + ' — <strong>' + tp(you.display_tp) + ' TP</strong>'
        + (you.rank ? ' · rank #' + you.rank : '') + '</div>'
      + '<div class="qs-you-sub">' + you.rounds_played + ' rounds · ' + you.swap_count + ' swaps · streak '
        + (you.best_streak || 0) + (you.diversity ? ' · explorer ⚡' : '') + '</div></div>';
  }

  function load(address) {
    if (address) lastAddr = address;
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
  setInterval(function () { if (!document.hidden) load(lastAddr || connectedAddress() || undefined); }, 60000);
})();
