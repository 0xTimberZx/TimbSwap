// bounty.js — Bug bounty pool verification: live USDT balance of the bounty wallet.
//
// Same trust model as the campaigns page: the balance is read from Arbitrum One
// in the visitor's own browser, never from our servers, so the number on the page
// is one they can reproduce on Arbiscan.
//
// BOUNTY_WALLET: the Arbitrum One address holding the bounty USDT. This wallet is
// funded progressively — the page says so, and shows the live balance rather than
// implying the $500 tier cap is sitting there.
const BOUNTY_WALLET = "0x6dc9380d32Bd7CaA16Cc079073fb54D644C6138C";

// Canonical USDT on Arbitrum One (6 decimals) + public mainnet RPC.
const BB_ARB_ONE_RPC  = "https://arb1.arbitrum.io/rpc";
const BB_USDT_ARB_ONE = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
const BB_ERC20_ABI    = ["function balanceOf(address) view returns (uint256)"];

function bbSetText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

async function refreshBountyWallet() {
  if (!BOUNTY_WALLET) return; // unfunded state: the placeholders stand
  const short = BOUNTY_WALLET.slice(0, 6) + "…" + BOUNTY_WALLET.slice(-4);
  const walletEl = document.getElementById("bb-wallet");
  if (walletEl) {
    walletEl.innerHTML = `<a href="https://arbiscan.io/address/${BOUNTY_WALLET}" target="_blank" rel="noopener">${short} ↗︎</a>`;
  }
  const scan = document.getElementById("bb-arbiscan");
  if (scan) scan.href = `https://arbiscan.io/address/${BOUNTY_WALLET}#tokentxns`;
  if (!window.ethers) { bbSetText("bb-balance", "check Arbiscan ↗︎"); return; }
  try {
    const prov = new ethers.providers.JsonRpcProvider(BB_ARB_ONE_RPC);
    const usdt = new ethers.Contract(BB_USDT_ARB_ONE, BB_ERC20_ABI, prov);
    const bal  = await usdt.balanceOf(BOUNTY_WALLET);
    bbSetText("bb-balance", parseFloat(ethers.utils.formatUnits(bal, 6)).toFixed(2) + " USDT");
  } catch {
    bbSetText("bb-balance", "check Arbiscan ↗︎");
  }
}

(function initBounty() {
  if (!document.getElementById("bb-balance")) return; // not the bounty page
  refreshBountyWallet();
  // Only poll while the tab is visible; refresh on focus.
  setInterval(() => { if (!document.hidden) refreshBountyWallet(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshBountyWallet(); });
})();
