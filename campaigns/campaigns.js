// competition.js — USDT Prize Week: live prize-wallet verification + receipts.
//
// ── Fill these in to go live (everything else is automatic) ──────────────────
// PRIZE_WALLET: the Arbitrum One address holding the prize USDT. Once set, the
// page shows it, links Arbiscan, and reads its live USDT balance client-side.
// COMP_DATES: shown in the hero status pill, e.g. "JUL 14 – JUL 20 · ends Sunday 23:59 UTC".
// RECEIPTS: append one entry per payout — it renders with an Arbiscan link.
const PRIZE_WALLET = "";              // e.g. "0xYourPrizeWallet"
const COMP_DATES   = "";              // e.g. "JUL 14 – JUL 20 · ends Sunday 23:59 UTC"
const PRIZE_POOL   = "$25 grand · 5 × $5 raffle";
const RECEIPTS     = [
  // { label: "Grand prize — $25 to 0x1234…abcd", tx: "0x…" },
];

// Canonical USDT on Arbitrum One (6 decimals) + public mainnet RPC.
const ARB_ONE_RPC  = "https://arb1.arbitrum.io/rpc";
const USDT_ARB_ONE = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
const ERC20_MIN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

async function refreshPrizeWallet() {
  if (!PRIZE_WALLET) return; // pre-announcement state: placeholders stand
  const short = PRIZE_WALLET.slice(0, 6) + "…" + PRIZE_WALLET.slice(-4);
  const walletEl = document.getElementById("cv-wallet");
  if (walletEl) {
    walletEl.innerHTML = `<a href="https://arbiscan.io/address/${PRIZE_WALLET}" target="_blank" rel="noopener">${short} ↗︎</a>`;
  }
  const scan = document.getElementById("cv-arbiscan");
  if (scan) scan.href = `https://arbiscan.io/address/${PRIZE_WALLET}#tokentxns`;
  try {
    const prov = new ethers.providers.JsonRpcProvider(ARB_ONE_RPC);
    const usdt = new ethers.Contract(USDT_ARB_ONE, ERC20_MIN_ABI, prov);
    const bal  = await usdt.balanceOf(PRIZE_WALLET);
    setText("cv-balance", parseFloat(ethers.utils.formatUnits(bal, 6)).toFixed(2) + " USDT");
  } catch {
    setText("cv-balance", "check Arbiscan ↗︎");
  }
}

function renderReceipts() {
  if (RECEIPTS.length === 0) return; // keep the empty-state message
  const list = document.getElementById("receipts-list");
  if (!list) return;
  list.innerHTML = "";
  for (const r of RECEIPTS) {
    const div = document.createElement("div");
    div.className = "receipt-row";
    div.innerHTML = `
      <span class="receipt-label">${r.label}</span>
      <a class="receipt-tx" href="https://arbiscan.io/tx/${r.tx}" target="_blank" rel="noopener">${r.tx.slice(0, 10)}…${r.tx.slice(-6)} ↗︎</a>
    `;
    list.appendChild(div);
  }
}

(function init() {
  if (COMP_DATES) setText("comp-status", COMP_DATES);
  setText("cv-pool", PRIZE_POOL);
  renderReceipts();
  refreshPrizeWallet();
  // Only poll the balance while the tab is visible; refresh on focus.
  setInterval(() => { if (!document.hidden) refreshPrizeWallet(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshPrizeWallet(); });
})();
