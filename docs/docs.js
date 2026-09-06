// docs.js — TimbSwap documentation page.
// Static content page: renders the verified contract-address table from the
// same ADDRESSES config the live app uses (so it can never drift from reality),
// drives the sidebar scroll-spy, and mirrors the shared nav/wallet controls.

// ─── Verified contract addresses ───────────────────────────────────────────────
// Rendered from config so the doc always matches what the dApp actually calls.
// Order is curated (core protocol first, then tokens) with friendly labels.
const ADDR_ROWS = [
  ["TIMBS Token",              "TIMBSToken"],
  ["Factory",                  "TimbSwapFactory"],
  ["Router",                   "TimbSwapRouter"],
  ["Staking (Farm rewards)",   "TimbStaking"],
  ["Farm",                     "TimbFarm"],
  ["Prize (Scroll game)",      "TimbPrize"],
  ["Game Registry",            "GameRegistry"],
  ["Eligible-Token Registry",  "EligibleTokenRegistry"],
  ["Yield Vault",              "TimbYieldVault"],
  ["Governance",               "TimbGovernance"],
  ["WETH",                     "WETH"],
  ["USDC (test)",              "USDC"],
  ["USDT (test)",              "USDT"],
  ["LINK (test)",              "LINK"],
  ["DAPP (test)",              "DAPP"],
];

function renderAddresses() {
  const tbody = document.getElementById("addr-tbody");
  if (!tbody || typeof ADDRESSES === "undefined") return;
  const rows = ADDR_ROWS
    .filter(([, key]) => ADDRESSES[key])
    .map(([name, key]) => {
      const addr = ADDRESSES[key];
      const url = "https://arbiscan.io/address/" + addr;
      return `<tr>
        <td class="docs-td-name">${name}</td>
        <td class="docs-td-addr" title="View on Arbiscan"
            onclick="window.open('${url}','_blank')">${addr}</td>
      </tr>`;
    })
    .join("");
  tbody.innerHTML = rows || '<tr><td colspan="2" class="docs-td-muted">No addresses configured</td></tr>';
}

// ─── Sidebar scroll-spy ─────────────────────────────────────────────────────────
function initScrollSpy() {
  const links = Array.from(document.querySelectorAll(".toc-link"));
  const map = new Map();
  for (const link of links) {
    const id = link.getAttribute("href").slice(1);
    const sec = document.getElementById(id);
    if (sec) map.set(sec, link);
  }
  if (!map.size || !("IntersectionObserver" in window)) return;

  let activeLink = null;
  const setActive = (link) => {
    if (link === activeLink) return;
    if (activeLink) activeLink.classList.remove("toc-active");
    if (link) link.classList.add("toc-active");
    activeLink = link;
  };

  const observer = new IntersectionObserver((entries) => {
    // Pick the topmost section currently intersecting the viewport.
    const visible = entries
      .filter(e => e.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (visible.length) setActive(map.get(visible[0].target));
  }, { rootMargin: "-80px 0px -70% 0px", threshold: 0 });

  for (const sec of map.keys()) observer.observe(sec);

  // Short sections at the very bottom (Disclaimer) can never reach the
  // observer's activation band — when the page is scrolled to the end,
  // hand the highlight to the last link explicitly.
  window.addEventListener("scroll", () => {
    const atBottom = window.innerHeight + window.scrollY >=
                     document.documentElement.scrollHeight - 8;
    if (atBottom) setActive(links[links.length - 1]);
  }, { passive: true });
}

// ─── Wallet (optional — nav parity only; the page has no gated content) ─────────
async function handleConnect() {
  const ok = await connectWallet();
  if (!ok) return;
  DebugHub.startSession(userAddress);
  document.getElementById("connect-btn").classList.add("hidden");
  document.getElementById("wallet-info").classList.remove("hidden");
  document.getElementById("network-badge").classList.remove("hidden");
  document.getElementById("wallet-addr").textContent = fmtAddr(userAddress);
  listenForAccountChanges((newAddr) => {
    if (!newAddr) { handleDisconnect(); return; }
    document.getElementById("wallet-addr").textContent = fmtAddr(newAddr);
  });
}

function handleDisconnect() {
  DebugHub.endSession();
  disconnectWallet();
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
}

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
  if (nav && btn && !nav.contains(e.target) && !btn.contains(e.target)) {
    nav.classList.remove("open");
  }
  const wi = document.getElementById("wallet-info");
  if (wi && !wi.contains(e.target)) wi.classList.remove("open");
});

// ─── Init ───────────────────────────────────────────────────────────────────────
(async () => {
  DebugHub.logCheckpoint("Docs:Page Loaded", "pass");
  renderAddresses();
  initScrollSpy();

  // Reflect a saved connection if present — the page works fully disconnected.
  try {
    const addr = await autoReconnect();
    if (addr) {
      document.getElementById("connect-btn")?.classList.add("hidden");
      document.getElementById("wallet-info")?.classList.remove("hidden");
      document.getElementById("network-badge")?.classList.remove("hidden");
      const el = document.getElementById("wallet-addr");
      if (el) el.textContent = fmtAddr(addr);
      DebugHub.startSession(addr);
    }
  } catch {}
})();
