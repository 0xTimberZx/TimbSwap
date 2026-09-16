// frontend/config.js
// Single source of truth for all contract addresses, chain config,
// and shared ethers setup. Every page imports from here.

// ─── Chain ───────────────────────────────────────────────────────────────────

const CHAIN_ID   = 421614;
const CHAIN_NAME = "Arbitrum Sepolia";

// Cloudflare Turnstile site key (PUBLIC — safe in client JS) for the faucet claim
// page. Set to your real site key; leave "" to render the faucet with no human
// check (the edge function also skips verification when TURNSTILE_SECRET is unset,
// so both must be set together to enforce it). window.* so faucet.js can read it.
window.TURNSTILE_SITE_KEY = "";

// Privy app ID (PUBLIC — safe in client JS) for "Continue with email": email
// one-time-code sign-in that yields an embedded Ethereum wallet (a normal EOA),
// see assets/email-login.js. Leave "" to hide the option entirely — every page
// then behaves exactly as before (browser-extension wallets only). Use a
// separate Privy app per environment (dev mirror vs live site); the app's
// allowed origins must include this site's origin.
window.PRIVY_APP_ID = "cmu3mq0in04v90bjyc1y38iij"; // "TimbSwap Dev" app (dev mirror only; the live site gets its own)

// Where this site is served from ("https://host/" or "https://host/sub/"),
// derived from this script's own URL so lazily-loaded assets (the email login
// sheet, the vendored Privy bundle) resolve on both root and sub-path hosting.
const SITE_ROOT = (function () {
  try { return new URL("./", document.currentScript.src).href; } catch { return "/"; }
})();

// Cache-buster for the lazily-loaded assets (assets/email-login.js and the
// vendored Privy bundle). config.js itself is always fetched fresh (?t=now),
// so bumping this one string is what makes browsers and the CDN pick up a
// new version of those files — GitHub Pages serves them with a 10-minute
// max-age that Cloudflare honours. Bump on every change to either file.
window.ASSET_VER = "20260916g";

// Resolve a root-absolute site path ("/compete/") against SITE_ROOT, so JS
// navigation works on sub-path hosting too. Anything else passes through.
function siteUrl(path) {
  return (typeof path === "string" && path.startsWith("/") && !path.startsWith("//"))
    ? SITE_ROOT + path.slice(1) : path;
}

// The pages link with root-absolute hrefs ("/swap/"), which is right on the
// custom domain but leaves the site on sub-path hosting (the dev mirror lives
// at github.io/TimbSwap/ → "/swap/" 404s at the github.io root). Rewrite those
// hrefs once the DOM is in; a no-op when the site is served from "/".
(function () {
  let root = "/";
  try { root = new URL(SITE_ROOT).pathname; } catch {}
  if (root === "/") return;
  const fix = () => {
    document.querySelectorAll('a[href^="/"]:not([href^="//"])').forEach((a) => {
      const h = a.getAttribute("href");
      if (!h.startsWith(root)) a.setAttribute("href", SITE_ROOT + h.slice(1));
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fix);
  else fix();
})();

// Faucet UI mirror of the mainnet-TIMB airdrop leg. Set true ONLY once the
// airdrop-dispatch function is live and AIRDROP_ENABLED is set on the faucet-claim
// edge function — this just shows/hides the "+ real TIMB" explainer on the faucet
// page; the edge function's own flag is what actually enqueues payouts.
window.AIRDROP_ENABLED = false;

// Independent public RPCs for READ traffic. Free public endpoints rate-limit
// per-IP under heavy browsing (several tabs polling), which stalls reads on
// every page ("fine at first, spoils after exploring"). makeReadProvider()
// spreads reads across all of them so no single endpoint's throttling freezes
// the UI. Order = priority.
const PUBLIC_RPCS = [
  "https://sepolia-rollup.arbitrum.io/rpc",        // official Arbitrum Sepolia
  "https://arbitrum-sepolia-rpc.publicnode.com",   // PublicNode
  "https://arbitrum-sepolia.drpc.org",             // dRPC
  "https://arbitrum-sepolia.gateway.tenderly.co",  // Tenderly gateway
];

// Dedicated read endpoint. Reads route through our OWN SAME-ORIGIN RPC proxy —
// a Cloudflare Worker on `timbswap.xyz/api/*` (workers/timbswap-api.js) that
// relays to a single keyed Alchemy backend.
// Why same-origin: Brave Shields / adblockers throttle or block third-party
// requests (g.alchemy.com dashed every read in Brave; functions.supabase.co was
// allowed for single calls but throttled the connected read burst). Served from
// the site's own origin under /api/*, these are first-party — Brave never touches
// them, and the browser skips CORS entirely. Relaying to ONE Alchemy node keeps
// reads consistent (no divergent-head reverts — see the note below). Upstream
// Alchemy URL lives in the Worker's ALCHEMY_RPC_URL secret (defaults to the
// public keyed URL, which a frontend RPC exposes regardless). While the app runs
// on Arbitrum SEPOLIA that secret MUST be a Sepolia endpoint, e.g.
//   https://arb-sepolia.g.alchemy.com/v2/<key>
// or the pinned StaticJsonRpcProvider (CHAIN_ID 421614) rejects the mainnet head.
// NB: the faucet page does not use this proxy — it only POSTs /api/faucet-claim.
// (The Supabase-hosted `rpc` function remains deployed as a manual fallback.)
const DEDICATED_RPC = "https://timbswap.xyz/api/rpc";
const _hasDedicated = typeof DEDICATED_RPC === "string" &&
                      DEDICATED_RPC.startsWith("http");

// App reads: when a dedicated (keyed) endpoint exists, use it ALONE — do NOT
// mix it into a FallbackProvider with the public endpoints. Mixing was the
// source of the "header not found" / "historical state is not available" /
// "RPC endpoint not found" CALL_EXCEPTIONs seen in DebugHub (on loadLiveMetrics,
// loadVault, loadRecentSwaps, loadClaims). Those aren't contract reverts: the
// public Arbitrum-Sepolia nodes run divergent heads and prune state, and ethers'
// FallbackProvider pins each call to the highest block it has seen, then on an
// Alchemy stall (>stallTimeout) races the publics and returns whichever settles
// first — often a public node's FAST ERROR for a block it lacks or pruned.
// ethers v5 surfaces that node error as CALL_EXCEPTION with data="0x", which
// mimics a revert but is a node failure (nested error.data.code -32000/-32002).
// A single consistent node has one head and keeps recent state, so the whole
// class vanishes. Publics remain the resilient fallback only when no key is set.
// (If Alchemy itself ever proves flaky, add a SECOND keyed provider here rather
// than the public nodes — heterogeneous public heads are what break consistency.)
const RPC_URLS = _hasDedicated ? [DEDICATED_RPC] : PUBLIC_RPCS;
// Wallet add-chain uses only PUBLIC endpoints — never route a visitor's wallet
// traffic through our keyed quota.
const RPC_URL = PUBLIC_RPCS[0];

const CHAIN_CONFIG = {
  chainId:   "0x" + CHAIN_ID.toString(16),
  chainName: CHAIN_NAME,
  nativeCurrency: { name: "Ethereum", symbol: "ETH", decimals: 18 },
  rpcUrls:        PUBLIC_RPCS,
  blockExplorerUrls: ["https://sepolia.arbiscan.io"]
};

// ─── Resilient read provider ──────────────────────────────────────────────────
// Reads go through a FallbackProvider across RPC_URLS with quorum 1: the
// highest-priority endpoint answers, and any that rate-limits or stalls is
// transparently skipped for the next — so one flaky RPC can't blank the page.
// StaticJsonRpcProvider pins the network (skips a per-call eth_chainId) since
// the chain is fixed. Signing still uses the wallet's own provider, never this.
// Callers cache the result (one provider per page); this only builds it.
//
// With a keyed endpoint we run it ALONE (see the RPC_URLS note above — mixing
// public nodes reintroduces divergent-head fake reverts). Resilience against a
// transient keyed blip (rate-limit / momentary stall) comes from a retry
// wrapper, NOT public fallbacks: a failed read is retried a couple of times
// with short backoff before the caller falls back to "—". Real contract reverts
// (CALL_EXCEPTION) are never retried — they propagate immediately.
function makeReadProvider() {
  let base;
  if (RPC_URLS.length === 1) {
    // Batch reads: ethers collapses every eth_call issued in the same tick into a
    // SINGLE JSON-RPC POST. A page load fired ~16 rapid POSTs, which (a) tripped
    // Brave's volume heuristic on our RPC proxy (the proxy returned 200 with valid
    // data, but Brave dropped the burst client-side → all-dashes on refresh) and
    // (b) ran up Supabase edge invocations. One batched POST behaves like the
    // single faucet-claim POST that Brave allows, and slashes edge cost.
    // Pin the network like StaticJsonRpcProvider so it never sends eth_chainId.
    const NET = { chainId: CHAIN_ID, name: CHAIN_NAME };
    base = new ethers.providers.JsonRpcBatchProvider(RPC_URLS[0], NET);
    base.detectNetwork = async () => NET;
  } else {
    const configs = RPC_URLS.map((url, i) => ({
      provider:     new ethers.providers.StaticJsonRpcProvider(url, CHAIN_ID),
      priority:     i + 1,  // lower number = tried first
      weight:       1,
      stallTimeout: 2500,   // ms to wait on a slow endpoint before trying the next
    }));
    base = new ethers.providers.FallbackProvider(configs, 1); // quorum 1
  }
  return _withReadRetry(base);
}

// Retry transient read failures on the (single, consistent) read provider so a
// momentary Alchemy rate-limit or stall doesn't blank the page. Read-only, so a
// retry is always safe. A genuine revert (CALL_EXCEPTION) is thrown at once —
// with a single keyed endpoint there are no divergent-head "fake reverts", so a
// CALL_EXCEPTION is real and must not be retried.
function _withReadRetry(provider) {
  const _send = provider.send.bind(provider);
  provider.send = async (method, params) => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await _send(method, params); }
      catch (e) {
        lastErr = e;
        if (e && e.code === "CALL_EXCEPTION") throw e; // real revert — don't retry
        if (attempt === 2) break;
        await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    throw lastErr;
  };
  return provider;
}

// ─── Display pricing ──────────────────────────────────────────────────────────
// Fixed USD-per-ETH for the marketing "Win the Pot" USD figure on the landing.
// Testnet ETH has no market price, so we value it as if it were real ETH at
// this rate rather than reading a meaningless testnet pool. Adjust to track ETH.
const ETH_USD_PRICE = 3000;

// ─── Contract Addresses ───────────────────────────────────────────────────────

const ADDRESSES = {
  PrizeEscrow:          "0x0000000000000000000000000000000000000000",
  TIMBSToken:           "0x0000000000000000000000000000000000000000",
  TimbSwapFactory:      "0x0000000000000000000000000000000000000000",
  TimbSwapRouter:       "0x0000000000000000000000000000000000000000", // v8 — multi-hop path routing
  EligibleTokenRegistry:"0x0000000000000000000000000000000000000000",
  GameRegistry:         "0x474d43efb4184f8c0c12f3f69394257da524c71f", // gen-3 Sepolia registry (permissionless activateRoundEntries). Keepers read this; the faucet edge fn checks the SAME address. Prev (gen-2, retired): 0xbab1cbaf0de094322a49b379d0ac4510d1f78530
  TimbPrize:            "0x53ac69cf33b0a4ffdcb8d18d5f16ecedb571101b", // gen-3 Sepolia prize, bound to the new registry + VRFEntropy. settler.js drives settleSegment here. Prev (gen-2, retired): 0x35976f4d2260127848a6274d2ec89ee054412432
  PrizeVRFEntropy:      "0x25297387ba089357c687572b66b295f58223ac93", // gen-3 dedicated VRF draw per prize segment (TablesVRF sub). Consumer must be added on the sub before segment arm.
  TimbStaking:          "0x0000000000000000000000000000000000000000",
  TimbFarm:             "0x0000000000000000000000000000000000000000",
  TimbBoostFarm:        "0x0000000000000000000000000000000000000000", // boosted extra-pair farms (USDT/LINK/DAPP…), TIMBS emission funded by the epoch-keeper waterfall boost tier
  TimbLockVault:        "0x0000000000000000000000000000000000000000",
  TimbYieldVault:       "0x0000000000000000000000000000000000000000", // fresh deploy — clears stranded/colliding weight
  TimbTreasury:         "0x0000000000000000000000000000000000000000", // v4 — three-way buyback split (burn/reserve/waterfall) + protocol-owned liquidity
  TimbGovernance:       "0x0000000000000000000000000000000000000000",
  GasFaucet:            "0xbaf1441bcfc7de699ef2965bae0cf96111c1b619", // Sepolia — keep-alive testnet-TIMBS drip, bound to the gen-3 registry (redeployed for the migration). Prev (gen-2): 0xe6ce84664e92581afa928d79c6902a120aa03941
  TimbsEthPair:         "0x0000000000000000000000000000000000000000",
  WETH:                 "0x0000000000000000000000000000000000000000",

  // ── SwapTables segment tables — generation 9, the seed-reroute generation (deployed 2026-08-05) ──
  // The entropy module changes and nothing else does. Gens 1-7 drew a character
  // from a commit-reveal with a 64-block blockhash fallback, which handed the
  // wallet holding the secret a SELECTION EDGE: once the lock block was public
  // it could compute both the reveal outcome and the fallback outcome, then
  // choose between them by acting or not acting (a
  // Colour bet worth 50% honestly became 75% with the pick). Gen-8 removes the
  // second path rather than policing it: one Chainlink VRF v2.5 draw per
  // segment, no secret, no fallback, so there is nothing to choose between.
  //
  // armSegment(id, seg) fires one draw; lockSegment(id, seg) is permissionless
  // and argument-free. One request per SEGMENT, not per round — a fulfilled
  // word is public the instant the callback lands, so six at once would publish
  // the whole round and kill the drumroll.
  //
  // Gen-9 keeps gen-8's VRF entropy and its ENTIRE external ABI unchanged — the
  // only difference is internal fund flow: the 100-TIMBS table seed no longer
  // enters any pool (two wallets hedging Red/Black would Sybil-farm it, see
  // dev-docs/AUDIT_SEED_FARM.md) and is swept whole to the UnderwriteReserve at
  // retire. Honest winners still land on stake x fair x 0.90. Because the ABI is
  // identical, segmentState(uint256,uint8) still detects the board as gen-8-shaped
  // and the pages need no logic change — only these addresses.
  // Gen-8 (board 0x89eE2553…, ledger 0x9195803e…, reserve 0x69C9E840…, entropy
  //   0xD982C721…) retired 2026-08-05; its ledger still pays withdrawals.
  // Gen-7 (0xf3FF3448…) retired 2026-08-04; its ledger still pays withdrawals.
  // Everything below gen-7 is unchanged: the bonus-chip full-load rule, gen-5's
  // adaptive timing (gen-9 dials 2400/300/120/300/900), monotonic underwrite (caps
  // 1000/pool, 1500/round, 10% of float), rake split (half reserve / half
  // Treasury), dead pots to the reserve, and dealer tips.
  SegmentBoard:         "0x0000000000000000000000000000000000000000", // gen-9 — seed routed to the reserve (§9 farm closed)
  PoolLedger:           "0x0000000000000000000000000000000000000000", // gen-9
  VRFEntropy:           "0x0000000000000000000000000000000000000000", // gen-9 — one VRF draw per segment
  CommitRevealEntropy:  "0x0000000000000000000000000000000000000000", // gen-7's, retired — kept for reading old rounds
  UnderwriteReserve:    "0x0000000000000000000000000000000000000000", // gen-9 — top-up float + the whole table seed now; guardian halt + drain only
  DDJackpot:            "0x0000000000000000000000000000000000000000", // M2 rolling jackpot — deploy-once, cross-generation
  SeedRegistry:         "0x0000000000000000000000000000000000000000", // long-lived — spans generations
  // Stateless lock/retire batcher for generations 4-7 ONLY. It calls
  // lockSegment(uint256,uint8,bytes32) and lockSegmentFallback, neither of
  // which exists on the gen-8 VRF board — batching six locks into one
  // transaction would also collapse the staggered reveal the per-segment
  // design exists to produce. Every crank path in the apps is gen-gated;
  // retire(uint256) is the only call still shared with gen-8.
  SegmentCrank:         "0x0000000000000000000000000000000000000000",
  USDC:                 "0x0000000000000000000000000000000000000000", // Circle canonical (6 decimals)
  LINK:                 "0x0000000000000000000000000000000000000000", // Chainlink canonical (18 decimals)
  USDT:                 "0x0000000000000000000000000000000000000000", // TestUSDT — 6 decimals, 1M supply
  DAPP:                 "0x0000000000000000000000000000000000000000",
};

// ─── Token Default List ───────────────────────────────────────────────────────

const DEFAULT_TOKENS = [
  {
    symbol:  "TIMBS",
    name:    "TimbSwap Token",
    address: ADDRESSES.TIMBSToken,
    decimals: 18,
    logoChar: "T"
  },
  {
    symbol:  "WETH",
    name:    "Wrapped Ether",
    address: ADDRESSES.WETH,
    decimals: 18,
    logoChar: "Ξ"
  },
  {
    symbol:  "USDC",
    name:    "USD Coin",
    address: ADDRESSES.USDC,
    decimals: 6,
    logoChar: "$"
  },
  {
    symbol:  "USDT",
    name:    "Tether USD (Test)",
    address: ADDRESSES.USDT,
    decimals: 6,
    logoChar: "₮"
  },
  {
    symbol:  "LINK",
    name:    "Chainlink",
    address: ADDRESSES.LINK,
    decimals: 18,
    logoChar: "L"
  }
];

// ─── Ethers Setup ─────────────────────────────────────────────────────────────

// Loaded from CDN in each HTML page:
// <script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js"></script>

let provider = null;
let signer   = null;
let userAddress = null;

// ─── Shared read provider (keyed endpoint, never the wallet) ──────────────────
// All reads go through the keyed/public provider (RPC_URLS), NOT the connected
// wallet's own provider. Routing reads through the wallet used to avoid a per-IP
// rate limit on the shared PUBLIC nodes — but with a dedicated keyed endpoint
// (quota'd per-key, not per-IP, and pinned to CHAIN_ID) that concern is gone,
// and the wallet path caused a worse failure: a flaky wallet RPC (Brave after a
// "Shred site data") failed EVERY read and blanked the page to "—" while
// connected, only recovering once the user disconnected. The keyed endpoint is
// reliable and safe to poll, so we always use it. Writes still go through the
// wallet signer; `_walletChainOk` is kept only as a connect-time chain check.
let _walletChainOk = false;
let _publicRO = null;
function sharedReadProvider() {
  return _publicRO || (_publicRO = makeReadProvider());
}

// ─── Logs read provider (wide eth_getLogs ranges) ─────────────────────────────
// Event scans need an endpoint that serves WIDE block ranges. The keyed Alchemy
// endpoint — and many wallet RPCs — cap eth_getLogs to a tiny range (observed
// ~10 blocks; see scripts/epoch.js), so a multi-day event window fails there
// ("Could not load claims / swaps"). The canonical Arbitrum public endpoint
// serves large ranges (the same one epoch.js and the explore page already scan
// from browsers). So getLogs ALWAYS goes here, independent of the state-read
// provider (which is Alchemy or the wallet). eth_call consistency isn't a
// concern for getLogs — it's addressed by explicit fromBlock/toBlock below.
let _logsRO = null;
function logsReadProvider() {
  return _logsRO || (_logsRO = new ethers.providers.StaticJsonRpcProvider(PUBLIC_RPCS[0], CHAIN_ID));
}
// Cache the logs endpoint's own head briefly so a page's several event scans
// don't each pay a getBlockNumber. Resolving the head on the SAME endpoint that
// runs the getLogs is what prevents a cross-provider mismatch — a toBlock past
// the node's head returns "header not found" — now that state reads come from a
// different (possibly further-ahead) node.
let _logsHead = { block: 0, at: 0 };
async function logsHeadBlock(fallbackBlock) {
  const now = Date.now();
  if (_logsHead.block && now - _logsHead.at < 4000) return _logsHead.block;
  try {
    const b = await logsReadProvider().getBlockNumber();
    _logsHead = { block: b, at: now };
    return b;
  } catch {
    return fallbackBlock || _logsHead.block || 0;
  }
}

// ─── Injected Provider Selection (Brave-safe) ─────────────────────────────────
// When multiple wallet extensions inject, window.ethereum.providers is an
// array and window.ethereum itself is whichever extension won the injection
// race — requests could go to one wallet while events come from another.
// Prefer the provider that already owns an authorized account. When no
// provider is connected yet, prefer Brave Wallet, then MetaMask, then the
// first injected provider, so every request/listener targets one wallet.
let _activeInjectedProvider = null;

// "Continue with email" (assets/email-login.js) hands us an EIP-1193 provider
// for a Privy embedded wallet. While one is set it IS the wallet: every
// injected-provider lookup below returns it, so _initProvider / _ensureChain /
// autoReconnect / the account listeners work unchanged for email users.
let _embeddedProvider = null;

function injectedProviders() {
  if (_embeddedProvider) return [_embeddedProvider];
  const eth = window.ethereum;
  if (!eth) return [];
  return eth.providers && eth.providers.length ? eth.providers : [eth];
}

function injectedProvider() {
  if (_embeddedProvider) return _embeddedProvider;
  if (_activeInjectedProvider) return _activeInjectedProvider;
  const providers = injectedProviders();
  return providers.find((p) => p.isBraveWallet)
      || providers.find((p) => p.isMetaMask)
      || providers[0]
      || null;
}

async function selectInjectedProvider() {
  if (_activeInjectedProvider) return _activeInjectedProvider;
  const providers = injectedProviders();
  if (!providers.length) return null;

  // A provider can be injected globally while another extension owns the
  // connected account. Find the owner before sending the first popup request.
  const authorized = await Promise.all(providers.map(async (p) => {
    try {
      const accounts = await _withTimeout(p.request({ method: "eth_accounts" }), 1500, "eth_accounts");
      return accounts && accounts.length ? p : null;
    } catch { return null; }
  }));
  _activeInjectedProvider = authorized.find(Boolean) || injectedProvider();
  return _activeInjectedProvider;
}

// ─── Session Persistence ──────────────────────────────────────────────────────
// Keeps wallet connected across page navigations without re-prompting.
// sessionStorage clears when the browser tab is closed — no stale state.

const SESSION_KEY = "timbswap_wallet";
// Which kind of wallet the saved session is: "injected" (extension) or "email"
// (Privy embedded). autoReconnect needs it to know whether to rehydrate the
// embedded provider before it looks for window.ethereum.
const SESSION_KIND_KEY = "timbswap_wallet_kind";

function _saveSession(address, kind) {
  try { sessionStorage.setItem(SESSION_KEY, address); } catch {}
  try { if (kind) sessionStorage.setItem(SESSION_KIND_KEY, kind); } catch {}
  _touchActivity(); // a fresh connect starts the idle clock
}

function _getSessionKind() {
  try { return sessionStorage.getItem(SESSION_KIND_KEY) || "injected"; } catch { return "injected"; }
}

// One-time cleanup of the retired "remembered connect method" key.
try { localStorage.removeItem("timbswap_connect_method"); } catch {}

function _clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  try { sessionStorage.removeItem(SESSION_KIND_KEY); } catch {}
  // A cleared session means the optimistic chrome (below) must revert to the
  // gated "Connect Wallet" state — otherwise a genuine disconnect / account
  // switch would leave the nav showing connected.
  clearWalletChrome();
}

// ─── Optimistic wallet chrome ─────────────────────────────────────────────────
// On a refresh, the page renders gated first and only flips to connected once
// autoReconnect() confirms — a visible "Connect Wallet" flash even when a wallet
// is connected. If a session is saved, paint the connected nav chrome
// immediately (below, at load) so there's no flash; autoReconnect then confirms
// (idempotent) and _clearSession() reverts it if the wallet is really gone. Only
// the shared nav elements (same ids on every page) are touched — per-page data
// still fills in from the page's own reads.
function applyWalletChrome(addr) {
  try {
    document.getElementById("connect-btn")?.classList.add("hidden");
    document.getElementById("wallet-info")?.classList.remove("hidden");
    document.getElementById("network-badge")?.classList.remove("hidden");
    const a = document.getElementById("wallet-addr");
    if (a && addr) a.textContent = fmtAddr(addr);
  } catch {}
}
function clearWalletChrome() {
  try {
    document.getElementById("connect-btn")?.classList.remove("hidden");
    document.getElementById("wallet-info")?.classList.add("hidden");
    document.getElementById("network-badge")?.classList.add("hidden");
  } catch {}
}

// Full teardown for a MANUAL disconnect (the wallet-menu "Disconnect" on every
// page). Pages used to only null provider/signer/userAddress, leaving the saved
// sessionStorage address behind — so navigating to another page silently
// auto-reconnected the wallet the user just disconnected. Clear the session and
// reset the chain/provider flags too, so a manual disconnect actually sticks.
function disconnectWallet() {
  _endSession();
}

// Shared teardown (manual Disconnect and idle expiry alike).
function _endSession() {
  // Decide by session KIND, not by whether the Privy provider happens to be
  // loaded: on a fresh page load (idle expiry in autoReconnect) it isn't yet,
  // and the Privy session must still be ended.
  const wasEmail = !!_embeddedProvider || _getSessionKind() === "email";
  provider = null;
  signer = null;
  userAddress = null;
  _walletChainOk = false;
  _activeInjectedProvider = null;
  _embeddedProvider = null;
  if (wasEmail) {
    // End the Privy session too, so the next connect genuinely asks again.
    _loadEmailLogin().then((ok) => { if (ok) window.TimbEmailWallet.logout(); }).catch(() => {});
  }
  _clearSession();
  try { sessionStorage.removeItem(LAST_ACTIVE_KEY); } catch {}
}

// ─── Idle timeout ─────────────────────────────────────────────────────────────
// Any connected session (extension or email) ends after IDLE_TIMEOUT_MS with no
// user interaction in this tab. "Interaction" = pointer / key / touch / scroll,
// stamped at most every 15 s into sessionStorage (same scope as the session:
// per tab, gone when the tab closes). Checked on every page load, once a
// minute while the page is open, and when the tab comes back into view. On
// expiry: full teardown (for email wallets that logs out of Privy too) and a
// reload, so every page's own connected-state UI resets to gated.
const IDLE_TIMEOUT_MS = 360 * 60 * 1000;
const LAST_ACTIVE_KEY = "timbswap_last_active";
let _lastTouch = 0;

function _touchActivity() {
  _lastTouch = Date.now();
  try { sessionStorage.setItem(LAST_ACTIVE_KEY, String(_lastTouch)); } catch {}
}
function _idleFor() {
  try {
    const t = Number(sessionStorage.getItem(LAST_ACTIVE_KEY));
    return t > 0 ? Date.now() - t : 0;
  } catch { return 0; }
}
function _idleExpired() { return _idleFor() > IDLE_TIMEOUT_MS; }
function _expireSession() {
  try { DebugHub.logCheckpoint("Session expired (idle " + Math.round(IDLE_TIMEOUT_MS / 60000) + " min)", "pass"); } catch {}
  _endSession();
  clearWalletChrome();
  // Hard refresh: a new URL (cache-busting query) makes the browser and the CDN
  // fetch the page fresh, so an expired session also lands on the latest site.
  const u = new URL(window.location.href);
  u.searchParams.set("_r", String(Date.now()));
  window.location.replace(u.toString());
}
(function () {
  const onActivity = () => { if (Date.now() - _lastTouch > 15000) _touchActivity(); };
  for (const ev of ["pointerdown", "keydown", "touchstart", "wheel", "scroll"]) {
    window.addEventListener(ev, onActivity, { passive: true, capture: true });
  }
  setInterval(() => { if (userAddress && _idleExpired()) _expireSession(); }, 60000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && userAddress && _idleExpired()) _expireSession();
  });
})();

// ─── "Continue with email" plumbing ───────────────────────────────────────────
// The sheet + Privy bridge live in assets/email-login.js and are injected on
// demand; nothing loads unless PRIVY_APP_ID is set AND a connect could use it.
let _emailLoginLoad = null;
function _loadEmailLogin() {
  if (!window.PRIVY_APP_ID) return Promise.resolve(false);
  if (window.TimbEmailWallet) return Promise.resolve(true);
  if (_emailLoginLoad) return _emailLoginLoad;
  _emailLoginLoad = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = SITE_ROOT + "assets/email-login.js?v=" + window.ASSET_VER;
    s.async = true;
    s.onload = () => resolve(!!window.TimbEmailWallet);
    s.onerror = () => { _emailLoginLoad = null; resolve(false); };
    document.head.appendChild(s);
  });
  return _emailLoginLoad;
}

// Decide how this connect should happen: "injected" (extension), "email"
// (Privy embedded wallet) or null (user dismissed the chooser). With no
// PRIVY_APP_ID this is exactly the old behaviour. With one set: no extension
// → straight to email; otherwise the chooser, EVERY time a session is started
// (a saved session auto-reconnects without it; only a fresh connect asks).
// The earlier "remember the last choice" shortcut was dropped: with both
// wallet kinds on one browser it silently locked users into whichever they
// picked first.
async function _pickConnectMethod() {
  const hasInjected = !!window.ethereum;
  if (!window.PRIVY_APP_ID) {
    if (hasInjected) return "injected";
    alert("No wallet detected. Please use MetaMask or Brave Wallet.");
    return null;
  }
  if (!(await _loadEmailLogin())) {
    // The sheet failed to load (offline / blocked): fall back to the extension
    // if there is one, otherwise there is nothing to connect with.
    if (hasInjected) return "injected";
    alert("Sign-in isn't available right now. Try again, or use a wallet extension.");
    return null;
  }
  if (!hasInjected) return "email";
  return window.TimbEmailWallet.chooseMethod({ hasInjected });
}

function _getSavedAddress() {
  try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; }
}

async function _initProvider() {
  provider    = new ethers.providers.Web3Provider(injectedProvider());
  signer      = provider.getSigner();
  userAddress = await signer.getAddress();
}

async function _ensureChain() {
  // getNetwork() sends eth_chainId to the injected wallet; Brave can leave that
  // pending indefinitely after a data-shred, hanging the connect on the very
  // first read. Bound it so a wedged wallet fails cleanly instead of freezing
  // the "Connecting…" button (matches the timeout autoReconnect already uses).
  const network = await _withTimeout(provider.getNetwork(), 15000, "getNetwork");
  if (network.chainId === CHAIN_ID) { _walletChainOk = true; return; }
  // Attempt the switch, but never let its popup HANG the connect — time-bound
  // each wallet request so a prompt the wallet fails to surface (or the user
  // leaves open) settles instead of freezing the button. On failure this throws
  // and connectWallet turns it into a clean "wrong network" failure the user can
  // retry, rather than an indefinite spinner.
  try {
    await _withTimeout(injectedProvider().request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_CONFIG.chainId }]
    }), 60000, "switchChain");
  } catch (switchErr) {
    if (switchErr && switchErr.code === 4902) {
      await _withTimeout(injectedProvider().request({
        method: "wallet_addEthereumChain",
        params: [CHAIN_CONFIG]
      }), 60000, "addChain");
    } else {
      throw switchErr;
    }
  }
  await _withTimeout(_initProvider(), 15000, "initProvider");
  // Some mobile in-app wallets resolve wallet_switchEthereumChain without
  // actually switching. Verify, and fail the connect loudly instead of
  // letting the session run against the wrong network.
  const net = await _withTimeout(provider.getNetwork(), 15000, "getNetwork");
  if (net.chainId !== CHAIN_ID) {
    DebugHub.logSecurity?.("Chain Check", "fail");
    throw new Error(`Wallet stayed on chain ${net.chainId} — switch to ${CHAIN_NAME} (${CHAIN_ID}) and reconnect.`);
  }
  _walletChainOk = true; // verified on the right chain — reads may use the wallet
}

// Connect the wallet. Modeled on the SwapTables flow, which connects reliably in
// Brave: fire eth_requestAccounts on EVERY tap (no in-flight promise caching).
// The old de-dupe returned a stale promise while one attempt was pending — so if
// the wallet never surfaced its prompt, _connectInFlight stayed set and every
// later tap hit a DEAD promise (the button did nothing until a full reload). A
// second request while a popup is genuinely open just returns -32002 ("already
// processing"), which is benign, so re-firing is safe and actually re-triggers a
// prompt that failed to surface.
async function connectWallet() {
  const method = await _pickConnectMethod();
  if (!method) return false;

  if (method === "email") {
    // Email → one-time code → embedded wallet, all inside the sheet. On
    // success the Privy provider becomes THE injected provider (see
    // _embeddedProvider) and the normal connect tail below runs against it.
    _setConnectBtn("Signing in…", true, { watchdogMs: 10 * 60 * 1000 });
    let w = null;
    try {
      if (!(await _loadEmailLogin())) throw new Error("email-login unavailable");
      w = await window.TimbEmailWallet.login();
    } catch (err) {
      try { DebugHub.logError("connectWallet:email", err); } catch {}
      _setConnectFail("Email sign-in failed — try again.");
      return false;
    }
    if (!w) { _setConnectBtn("Connect Wallet", false); return false; } // cancelled
    _embeddedProvider = w.provider;
    _activeInjectedProvider = null;
  } else {
    if (!window.ethereum) {
      alert("No wallet detected. Please use MetaMask or Brave Wallet.");
      return false;
    }
    _embeddedProvider = null;
    await selectInjectedProvider();
  }
  // Feedback on the shared connect button (same id every page) — a locked-wallet
  // tap previously looked dead while eth_requestAccounts sat pending.
  _setConnectBtn(method === "email" ? "Connecting…" : "Connecting… check your wallet", true);
  // Which wallet are we actually talking to? When several extensions inject,
  // injectedProvider() picks one — and a request sent to a provider the user
  // isn't actually using never surfaces a prompt and never rejects. Recording
  // the pick makes that case visible in telemetry instead of indistinguishable
  // from a slow wallet.
  try { DebugHub.logCheckpoint("Wallet Target " + _providerLabel(), "pass"); } catch {}
  try {
    // Request account authorization FIRST. _initProvider() calls signer.getAddress(),
    // which throws "unknown account #0" in ethers v5 before any account is authorized.
    // Timeout so a never-answered request still settles (button always recovers).
    // 25s, not 60s. A wallet that is going to prompt does so in under a second;
    // past ~20s it is wedged, and the old minute-long wait meant the user always
    // navigated away before the rejection could fire. Every observed hang in
    // telemetry is "Wallet Connect Requested" with nothing after it, because the
    // page died first — the timeout was correct and simply never got to run.
    await _withTimeout(
      injectedProvider().request({ method: "eth_requestAccounts" }), 25000, "eth_requestAccounts");
    // eth_requestAccounts resolving does NOT mean later wallet reads will. Brave
    // (especially after "Shred site data") can leave signer.getAddress() /
    // getNetwork() pending forever — the button then sat on "Connecting…" with
    // no failure logged (confirmed in DebugHub: "Wallet Connect Requested" with
    // nothing after it). Bound every wallet read so the connect always resolves
    // to success or a clean, retryable failure. _ensureChain() is itself bounded.
    await _withTimeout(_initProvider(), 15000, "initProvider");
    await _ensureChain();
    _saveSession(userAddress, method);
    return true;
  } catch (err) {
    // Log the failure HERE, not only in the caller. A stage-labelled event is the
    // difference between "the connect hung" and "eth_chainId hung on Brave Wallet
    // while MetaMask held the accounts" — the second is actionable, the first is
    // what we had.
    const stage = _timeoutStage(err);
    try {
      if (stage) DebugHub.logCheckpoint("Wallet Connect Timeout: " + stage, "fail");
      DebugHub.logError("connectWallet", err);
    } catch {}
    if (err && (err.code === -32002 || /already processing/i.test(err.message || ""))) {
      console.warn("connectWallet: a request is already open in your wallet — approve it there");
      _setConnectFail("Approve the request in your wallet, then tap again.");
    } else if (stage) {
      // Silent hangs used to leave the user with a button that just went back to
      // "Connect Wallet" and no idea why. Say what happened.
      _setConnectFail("Your wallet didn't respond (" + stage + "). Unlock it or switch wallets, then retry.");
    } else {
      console.error("connectWallet failed:", err);
      // Any other settled failure still leaves a tappable, retryable button
      // rather than a stale "Connecting…".
      _setConnectFail("Couldn't connect — try again.");
    }
    return false;
  } finally {
    // Only clear a lingering PENDING state (e.g. success, which the page handler
    // then hides). On failure the catch already left a retryable message via
    // _setConnectFail — don't clobber it back to a bare "Connect Wallet", which
    // read as "nothing happened".
    const b = document.getElementById("connect-btn");
    if (b && b.classList.contains("is-connecting")) _setConnectBtn("Connect Wallet", false);
  }
}

// Update the shared connect button (id "connect-btn" on every page). No-op if
// the page has no such button. The per-page success handler hides the button
// after a connect; this only drives the pending/failed states.
let _connectWatchdog = null;
function _setConnectBtn(text, disabled, opts) {
  try {
    const b = document.getElementById("connect-btn");
    if (!b) return;
    b.textContent = text;
    b.disabled = !!disabled;
    b.classList.toggle("is-connecting", !!disabled);
    // A fresh attempt clears a previous failure's amber state + tooltip.
    if (disabled) { b.classList.remove("is-failed"); b.title = ""; }
    // Guarantee recovery. Every wallet read in connectWallet is timeout-bounded,
    // but if one ever hangs with no rejection (seen on Brave after a data-shred),
    // neither catch nor finally runs and the button would sit disabled on
    // "Connecting…" forever. Arm a watchdog when we enter the pending state; any
    // later state change clears it. If it fires while still pending, force the
    // button back to a tappable, retryable state.
    // The email sheet (type an email, wait for the code, type it) legitimately
    // takes minutes, so its caller passes a long watchdog instead of the 30 s
    // that suits a wallet popup — otherwise the button flipped to "try again"
    // while the user was still typing the code.
    const watchdogMs = (opts && opts.watchdogMs) || 30000;
    clearTimeout(_connectWatchdog);
    if (disabled) {
      _connectWatchdog = setTimeout(() => {
        const el = document.getElementById("connect-btn");
        if (!el || !el.classList.contains("is-connecting")) return;
        el.classList.remove("is-connecting");
        el.classList.add("is-failed");
        el.disabled = false;
        el.textContent = "Connect Wallet — try again";
        el.title = "Your wallet didn't respond. Unlock it or switch wallets, then tap again.";
      }, watchdogMs);
    }
  } catch {}
}

// Which injected wallet injectedProvider() resolved to, for telemetry. Several
// extensions can inject at once and only one of them holds the user's accounts.
function _providerLabel() {
  try {
    if (_embeddedProvider) return "privy-email";
    const p = injectedProvider();
    if (!p) return "none";
    const multi = (window.ethereum && window.ethereum.providers &&
                   window.ethereum.providers.length) ? "multi:" : "";
    if (p.isBraveWallet) return multi + "brave";
    if (p.isMetaMask)    return multi + "metamask";
    if (p.isCoinbaseWallet) return multi + "coinbase";
    return multi + "unknown";
  } catch { return "error"; }
}

// _withTimeout rejects with "<label> timeout". Pull the label back out so we can
// say WHICH wallet call hung — request, initProvider or getNetwork are three very
// different failures and were previously indistinguishable.
function _timeoutStage(err) {
  const m = /^(\S+) timeout$/.exec((err && err.message) || "");
  return m ? m[1] : null;
}

// Leave a failure message on the connect button instead of silently resetting it
// to "Connect Wallet", which read as "nothing happened". Reverts on the next tap.
function _setConnectFail(msg) {
  try {
    clearTimeout(_connectWatchdog);
    const b = document.getElementById("connect-btn");
    if (!b) return;
    b.textContent = msg;
    b.disabled = false;
    b.classList.remove("is-connecting");
    b.classList.add("is-failed");
    b.title = msg;
  } catch {}
}

/**
 * Call on every page load to silently reconnect if the user was already
 * connected. Returns the connected address or null.
 * Usage in each page's init:
 *   const addr = await autoReconnect();
 *   if (addr) { showWalletUI(addr); loadUserData(); }
 */
// Bound any wallet call so a stalled injected wallet can't hang the page.
// Brave's wallet can leave eth_accounts / eth_chainId pending indefinitely on a
// refresh; without a timeout that freezes init() before the first round-state
// read (the "stale/Loading after refresh" bug).
function _withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error((label || "wallet") + " timeout")), ms)),
  ]);
}

async function autoReconnect() {
  const saved = _getSavedAddress();
  if (!saved) return null;

  // Idle expiry on load: a saved session whose last interaction is older than
  // the timeout is ended instead of restored (email wallets log out of Privy).
  if (_idleExpired()) {
    try { DebugHub.logCheckpoint("Session expired (idle " + Math.round(IDLE_TIMEOUT_MS / 60000) + " min)", "pass"); } catch {}
    _endSession();
    clearWalletChrome();
    return null;
  }
  // Sessions saved before the idle clock existed have no stamp: start it now.
  if (_idleFor() === 0) _touchActivity();

  if (_getSessionKind() === "email") {
    // Email session: rehydrate the Privy provider silently (its own session
    // lives in localStorage). If Privy no longer has a session, the saved
    // address is stale — clear it so we don't retry on every page.
    if (!_embeddedProvider) {
      let p = null;
      try { if (await _loadEmailLogin()) p = await window.TimbEmailWallet.restore(); } catch { p = null; }
      if (!p) { _clearSession(); return null; }
      _embeddedProvider = p;
      _activeInjectedProvider = null;
    }
  } else if (!window.ethereum) {
    return null;
  }

  // Retry the reconnect a couple of times: Brave often has eth_accounts /
  // getNetwork hiccup on a soft refresh, and one failed attempt used to drop the
  // user to the gated view even though the wallet is connected. The session is
  // preserved across attempts; reads work meanwhile via the keyed provider.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await selectInjectedProvider();
      // Check the wallet still has the account active (no popup), with a timeout.
      const accounts = await _withTimeout(
        injectedProvider().request({ method: "eth_accounts" }), 4000, "eth_accounts");
      // A DIFFERENT account is authorized → the saved session is genuinely stale
      // (a real switch, not a hiccup): clear it and stop.
      if (accounts && accounts.length && accounts[0].toLowerCase() !== saved.toLowerCase()) {
        _clearSession();
        return null;
      }
      // No authorized account right now — locked, or Brave briefly returning []
      // on a refresh. Treat as transient (retry); NEVER clear here. A real revoke
      // fires accountsChanged, which ends the session explicitly.
      if (!accounts || !accounts.length) throw new Error("no-accounts");

      await _withTimeout(_initProvider(), 4000, "initProvider");
      // Silent reconnect must NEVER trigger a chain-switch POPUP (it hangs the
      // page on refresh). Verify the chain read-only; if it's wrong, stay gated
      // (don't clear) and let the user reconnect explicitly (that path switches).
      const net = await _withTimeout(provider.getNetwork(), 4000, "getNetwork");
      // Wrong chain: stay gated (don't clear the session) but revert the
      // optimistic nav chrome so the real Connect button returns — the explicit
      // connect path is what switches the chain.
      if (net.chainId !== CHAIN_ID) { clearWalletChrome(); return null; }
      _walletChainOk = true; // verified on the right chain
      return userAddress;
    } catch {
      // Transient wallet read failure/timeout (flaky Brave on soft refresh). The
      // wallet is connected; the read just hiccuped. Retry before giving up FOR
      // THIS LOAD — the session is preserved either way, so the next load
      // reconnects and reads work meanwhile via the keyed provider.
      if (attempt < 2) { await new Promise(r => setTimeout(r, 500)); continue; }
      // Reconnect failed for this load. Revert the optimistic nav chrome (session
      // kept) so the nav shows a real Connect button instead of a stuck
      // "connected" state with a hidden button — this is the general fix for the
      // #374 optimistic-chrome half-state on EVERY page. (The !window.ethereum
      // early-return above is left alone to avoid a false revert during a late
      // wallet injection.)
      clearWalletChrome();
      return null;
    }
  }
  clearWalletChrome();
  return null;
}

function getContract(name, signerOrProvider) {
  const address = ADDRESSES[name];
  if (!address) throw new Error(`Unknown contract: ${name}`);
  // ABI loaded separately per page to avoid loading all ABIs everywhere
  throw new Error(`getContract: load ABI for ${name} before calling`);
}

// ─── Gas Helpers (ecosystem pattern) ─────────────────────────────────────────

// Mobile in-app wallets (MetaMask, Brave) can drop the injected provider after a
// background/tab-switch/reload while the session (userAddress) persists — leaving
// a tx handler running with provider/signer = null. Re-establish silently before
// any write, and fail with a clear message if the wallet truly isn't available
// (instead of "null is not an object (evaluating 'provider.getTransactionCount')").
async function ensureSigner() {
  if (provider && signer) return true;
  try { await autoReconnect(); } catch {}
  return !!(provider && signer);
}

// Build a signer-bound contract for a WRITE, guaranteeing the signer is live
// FIRST. ensureSigner() may silently reconnect after a mobile provider drop,
// which reassigns the global `signer`; a contract constructed *before* that ran
// would stay bound to the stale/null signer even after reconnect (the
// "null is not an object (evaluating 'provider.getTransactionCount')" crash
// seen in the DebugHub logs). Always `await writeContract(addr, abi)` for
// writes instead of `new ethers.Contract(addr, abi, signer)`.
async function writeContract(address, abi) {
  if (!(await ensureSigner())) throw new Error("Wallet disconnected — reconnect and try again.");
  return new ethers.Contract(address, abi, signer);
}

async function getGasParams() {
  if (!(await ensureSigner())) throw new Error("Wallet disconnected — reconnect and try again.");
  // getFeeData() from a mobile in-app wallet's injected node can return null
  // for maxPriorityFeePerGas (Arbitrum's tip is ~0) or even maxFeePerGas.
  // Calling .mul() on null threw "null is not an object" for EVERY write —
  // swap, advance, entry — before the wallet was ever asked to sign. Tolerate
  // the gaps: prefer EIP-1559 when a maxFeePerGas is reported (priority 0 is
  // valid on Arbitrum), fall back to legacy gasPrice, and finally let the
  // wallet fill fees itself rather than crash.
  let feeData;
  try { feeData = await provider.getFeeData(); }
  catch { return {}; }

  const bump = (v) => (v && v.mul) ? v.mul(130).div(100) : null;
  const maxFee = bump(feeData.maxFeePerGas);
  if (maxFee) {
    const prio = bump(feeData.maxPriorityFeePerGas);
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: prio || ethers.constants.Zero };
  }
  const gasPrice = bump(feeData.gasPrice);
  if (gasPrice) return { gasPrice };
  return {}; // nothing usable → wallet estimates its own fees
}

// Let the WALLET assign the nonce. Forcing a manual nonce (from a "pending"
// count) desyncs with mobile MetaMask's own nonce tracking and throws
// NONCE_EXPIRED ("nonce too low") — seen in the mobile DebugHub logs. Every
// call site sends a single, awaited tx (no batching that needs sequential
// nonces), so undefined is correct: ethers/the wallet fills the right nonce.
// Kept as a function (not removed) so all ~25 `{ ...gas, nonce }` call sites
// keep working unchanged, and so the ensureSigner guard still runs pre-tx.
async function getPendingNonce() {
  if (!(await ensureSigner())) throw new Error("Wallet disconnected — reconnect and try again.");
  return undefined;
}

// ─── Transaction Confirmation (ecosystem pattern) ────────────────────────────

// Dedicated read-only provider on the canonical Arbitrum Sepolia RPC. Used to
// confirm transactions independently of the wallet's in-app provider.
let _confirmProv = null;
function _confirmProvider() {
  return _confirmProv || (_confirmProv = makeReadProvider());
}

// Confirm a submitted tx by polling the canonical public RPC for its receipt,
// instead of awaiting the wallet's own tx.wait(). Mobile in-app wallets often
// never push the receipt back to the page, which leaves a button stuck in its
// loading state ("Adding liquidity…", "Staking…", "Voting…") long after the tx
// has actually mined. The public RPC is authoritative: this resolves the
// moment the receipt lands, and throws on a reverted tx (status 0) or after a
// ~3-minute ceiling. `tx` is an ethers TransactionResponse (needs `.hash`).
async function confirmTx(tx, { tries = 90, intervalMs = 2000 } = {}) {
  const prov = _confirmProvider();
  for (let i = 0; i < tries; i++) {
    try {
      const r = await prov.getTransactionReceipt(tx.hash);
      if (r && r.blockNumber) {
        if (r.status === 0) throw Object.assign(new Error("transaction reverted"), { receipt: r });
        return r;
      }
    } catch (e) { if (e && e.receipt) throw e; /* transient RPC read — keep polling */ }
    await new Promise(res => setTimeout(res, intervalMs));
  }
  throw new Error("confirmation timeout — check the explorer");
}

// ─── Event-Scan Block Windows ────────────────────────────────────────────────

// Arbitrum Sepolia mints blocks on demand — lately ~3/second (≈270k/day), so a
// fixed block count is meaningless as a time window (50k blocks is ~4½ hours,
// not days). Calibrate blocks-per-second from two real block timestamps once
// per page load, then convert time windows into block counts from that.
let _blocksPerSec = null;
async function blocksPerSecond(prov) {
  if (_blocksPerSec) return _blocksPerSec;
  try {
    const cur  = await prov.getBlockNumber();
    const span = Math.min(Math.max(cur - 1, 0), 200000);
    if (span > 0) {
      const [a, b] = await Promise.all([prov.getBlock(cur), prov.getBlock(cur - span)]);
      const dt = a.timestamp - b.timestamp;
      if (dt > 0) _blocksPerSec = span / dt;
    }
  } catch {}
  return _blocksPerSec || 3; // sane Arb Sepolia default if the probe fails
}

async function blocksForDays(prov, days) {
  return Math.round((await blocksPerSecond(prov)) * 86400 * days);
}

// Compact abbreviated "time ago" from a seconds delta: 30 → "30s", 5 → "5m",
// 2 → "2h", 3 → "3d". Used for activity tables. Approximate when fed a
// block-time estimate (blocks ÷ blocksPerSecond), which is fine for relative
// display.
function fmtAgo(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60)    return sec + "s";
  const m = Math.floor(sec / 60);    if (m < 60) return m + "m";
  const h = Math.floor(sec / 3600);  if (h < 24) return h + "h";
  return Math.floor(sec / 86400) + "d";
}

// "Nx ago" label for a block, given the current head and calibrated block rate
// (blocks/sec). Returns "" if inputs are missing.
function blockAge(block, currentBlock, bps) {
  if (!block || !currentBlock || !bps) return "";
  return fmtAgo((currentBlock - block) / bps);
}

// eth_getLogs over a multi-day window can exceed a public RPC's range/result
// limits. Try the wanted window first, then shrink (¼, then 1/20) before
// giving up, so a strict endpoint still yields the most recent slice of
// activity instead of nothing.
//
// The scan is routed through logsReadProvider() (the wide-range canonical
// endpoint), NOT the contract's own provider — that may be Alchemy or the
// wallet, both of which cap getLogs to a tiny range. `currentBlock` (the state
// node's head) is only a fallback for the toBlock; the real toBlock is the logs
// endpoint's own head, so it can never outrun that node ("header not found").
async function queryFilterWindow(contract, filter, currentBlock, windowBlocks) {
  const c    = contract.connect(logsReadProvider());
  const head = await logsHeadBlock(currentBlock);
  let lastErr = null;
  for (const f of [1, 0.25, 0.05]) {
    const from = Math.max(0, head - Math.round(windowBlocks * f));
    try { return await c.queryFilter(filter, from, head); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ─── Add Token to Wallet (EIP-747 wallet_watchAsset) ─────────────────────────

// Prompt the connected wallet to track an ERC-20 (MetaMask/Brave "Add token").
// `token` needs { address, symbol, decimals }. Symbol is capped at 11 chars
// (MetaMask rejects longer). Returns true if the wallet reports it was added.
// Safe to call from an onclick — it swallows the user-rejected case quietly.
async function addTokenToWallet(token) {
  if (!window.ethereum) { alert("No wallet detected. Open in a wallet browser or install MetaMask/Brave Wallet."); return false; }
  if (!token || !token.address || token.address === "native") return false;
  try {
    const wasAdded = await injectedProvider().request({
      method: "wallet_watchAsset",
      params: {
        type: "ERC20",
        options: {
          address:  token.address,
          symbol:   (token.symbol || "TOKEN").slice(0, 11),
          decimals: Number(token.decimals ?? 18)
        }
      }
    });
    return !!wasAdded;
  } catch (e) {
    console.warn("addTokenToWallet:", e && e.message);
    return false;
  }
}

// ─── Formatting Helpers ───────────────────────────────────────────────────────

function fmt(wei, decimals = 18, dp = 4) {
  if (!wei) return "0";
  return parseFloat(ethers.utils.formatUnits(wei, decimals)).toFixed(dp);
}

function fmtAddr(address) {
  if (!address) return "";
  return address.slice(0, 6) + "…" + address.slice(-4);
}

function fmtETH(wei, dp = 4) {
  return fmt(wei, 18, dp) + " ETH";
}

function fmtTIMBS(wei, dp = 2) {
  return fmt(wei, 18, dp) + " TIMBS";
}

// ─── Shared pair labeling (base/quote orientation) ────────────────────────────
// Single source of truth for how a pair reads: the higher-priority token is the
// QUOTE (denominator), shown second — stables > native (WETH) > everything else.
// So every pair reads consistently (X/USDC, X/WETH) instead of in arbitrary
// factory token0/token1 order. Used by explore, analytics, and the farm's
// boosted pools so the SAME pair labels the same way everywhere.
function pairQuoteRank(addr) {
  const a = (addr || "").toLowerCase();
  const is = (k) => ADDRESSES[k] && a === ADDRESSES[k].toLowerCase();
  if (is("USDC") || is("USDT")) return 3; // stables quote first
  if (is("WETH")) return 2;               // then native
  return 1;                               // then whitelisted / others
}
// Order two tokens base/quote by that priority (higher rank = quote, shown 2nd).
// Equal priority keeps the given order. Returns {base, quote} of {addr, sym}.
function orientPair(t0, sym0, t1, sym1) {
  const flip = pairQuoteRank(t0) > pairQuoteRank(t1);
  return flip
    ? { base: { addr: t1, sym: sym1 }, quote: { addr: t0, sym: sym0 } }
    : { base: { addr: t0, sym: sym0 }, quote: { addr: t1, sym: sym1 } };
}
// "BASE/QUOTE" label from token addresses + symbols.
function pairLabelFor(t0, sym0, t1, sym1) {
  const o = orientPair(t0, sym0, t1, sym1);
  return `${o.base.sym}/${o.quote.sym}`;
}

// ─── Shared USD price oracle ──────────────────────────────────────────────────
// Prices any listed token in USD off the live V2 pools, so any page can show an
// "≈ $" estimate. Stables = $1; WETH via the USDC/WETH pool; anything else via
// its USDC pair (direct), else its WETH pair × the ETH price. Cached with a
// short TTL so readouts track pool moves (other wallets' trades) on refresh
// without hammering the RPC. All reads hit the canonical public RPC.
const _PRICE_PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)"
];
const _PRICE_FACTORY_ABI = ["function getPairAddress(address a, address b) external view returns (address)"];
const _PRICE_TTL = 12000; // ms; a tick of ~12s keeps estimates live but cheap
const _usdCache = {};     // lowercased addr -> { px: number|null, ts }
let _priceProv = null;
function _priceProvider() {
  return _priceProv || (_priceProv = makeReadProvider());
}
function _tokenDecimals(lc) {
  const t = DEFAULT_TOKENS.find(x => x.address.toLowerCase() === lc);
  return t ? t.decimals : 18;
}
// USD value of one whole `quote` token = quoteUsd; returns USD-per-`token`, read
// off the token/quote pool. null if the pair doesn't exist or is empty.
async function _priceViaPair(prov, factory, token, quote, quoteUsd) {
  if (quoteUsd === null || quoteUsd === undefined) return null;
  const addr = await factory.getPairAddress(token, quote);
  if (!addr || addr === ethers.constants.AddressZero) return null;
  const pc = new ethers.Contract(addr, _PRICE_PAIR_ABI, prov);
  const [r, t0] = await Promise.all([pc.getReserves(), pc.token0()]);
  const tokLc  = token.toLowerCase();
  const tokIs0 = t0.toLowerCase() === tokLc;
  const tokRes = parseFloat(ethers.utils.formatUnits(tokIs0 ? r.reserve0 : r.reserve1, _tokenDecimals(tokLc)));
  const qRes   = parseFloat(ethers.utils.formatUnits(tokIs0 ? r.reserve1 : r.reserve0, _tokenDecimals(quote.toLowerCase())));
  if (tokRes <= 0 || qRes <= 0) return null;
  return (qRes / tokRes) * quoteUsd; // (quote per token) × (USD per quote)
}
// THE anchor. Every "≈ $" on the site resolves through this one number.
//
// It used to read the USDC/WETH pool. On a testnet that pool is unarbitraged,
// and it had drifted to imply ETH ≈ $700 — while landing.js and compete.js were
// using the fixed ETH_USD_PRICE ($3000) for the same currency. Two anchors ~4x
// apart, and which one you saw depended on the page. Testnet ETH has no market
// price to discover, so reading a pool for it was never buying us anything:
// take the declared rate, the same one the landing page quotes the pot in.
function _oracleEthUsd() {
  return ETH_USD_PRICE;
}
// NOTE: stables are deliberately NOT pinned to $1 here. On this testnet nothing
// arbitrages the pools, so USDC/USDT have drifted off a dollar — pinning them
// made the swap card's two "≈ $" lines incomparable (one a constant, one read
// from a pool), which is how a 1 USDT -> $0.38 quote could look like a 0.75%
// price impact. Everything, stables included, is now priced off the pools
// relative to one anchor. See _oracleEthUsd.
// USD per 1 whole token (number), or null if unpriceable. TTL-cached.
async function usdPriceOf(tokenAddr) {
  if (!tokenAddr) return null;
  const lc  = tokenAddr.toLowerCase();
  const now = Date.now();
  const c   = _usdCache[lc];
  if (c && now - c.ts < _PRICE_TTL) return c.px;
  let px = null;
  try {
    const prov    = _priceProvider();
    const factory = new ethers.Contract(ADDRESSES.TimbSwapFactory, _PRICE_FACTORY_ABI, prov);
    const ethUsd = _oracleEthUsd();
    if (lc === ADDRESSES.WETH.toLowerCase()) {
      px = ethUsd;                       // the anchor itself
    } else {
      // Everything hangs off WETH, so every readout shares one denominator.
      px = await _priceViaPair(prov, factory, tokenAddr, ADDRESSES.WETH, ethUsd);
      if (px === null) {
        // No direct WETH pair. Hop through USDC — but price USDC itself off its
        // OWN WETH pool rather than assuming a dollar, or we reintroduce the
        // mixed-denominator bug one level down.
        const usdcUsd = await _priceViaPair(prov, factory, ADDRESSES.USDC, ADDRESSES.WETH, ethUsd);
        px = await _priceViaPair(prov, factory, tokenAddr, ADDRESSES.USDC, usdcUsd);
      }
    }
  } catch {}
  _usdCache[lc] = { px, ts: now };
  return px;
}
// "≈ $X.XX" for `amountFloat` of the token at `tokenAddr`, or "" if unpriceable.
async function usdEst(tokenAddr, amountFloat) {
  const a = parseFloat(amountFloat);
  if (!isFinite(a) || a <= 0) return "";
  const px = await usdPriceOf(tokenAddr);
  if (px === null || px === undefined) return "";
  const v = a * px;
  if (v === 0) return "≈ $0";
  if (v < 0.01) return "≈ $" + v.toPrecision(2);
  return "≈ $" + v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// bytes6 → readable string (e.g. 0x414243 → "ABC")
function fmtBytes6(bytes6) {
  if (!bytes6 || bytes6 === "0x000000000000") return "——";
  try {
    return ethers.utils.toUtf8String(bytes6).replace(/\0/g, "");
  } catch {
    // fallback: manual hex decode
    const hex = bytes6.replace("0x", "");
    let result = "";
    for (let i = 0; i < hex.length; i += 2) {
      const code = parseInt(hex.slice(i, i + 2), 16);
      if (code > 0) result += String.fromCharCode(code);
    }
    return result;
  }
}

// ─── Account Switch / Disconnect Listeners ────────────────────────────────────

// Any accountsChanged event — whether the wallet was disconnected or the
// user picked a different account — ends the session instead of silently
// carrying on under the new address. Acting on a wallet swap without an
// explicit reconnect risks running the old page state (approvals, pending
// tx context) against the wrong account, so we always require a fresh
// Connect Wallet click afterward.
let _walletListenersBound = false;

function listenForAccountChanges(onChangeCallback) {
  const eth = injectedProvider();
  // Bind once — a second call (re-connect, re-init) would stack a duplicate
  // accountsChanged handler and fire session teardown twice per event.
  if (!eth || _walletListenersBound) return;
  // Brave (and some multi-wallet / EIP-6963 setups) wrap window.ethereum in a
  // Proxy whose `on` is a read-only, non-configurable property; merely READING
  // `eth.on` then throws a V8 proxy-invariant TypeError ("'get' on proxy:
  // property 'on' is a read-only and non-configurable data property ... but the
  // proxy did not return its actual value"). This binding is non-essential
  // account/chain-change UX and must NEVER abort page init — an unguarded throw
  // here aborted the connected-load init before loadAllPools(), blanking every
  // read to "—" on Brave. Guard every access; on failure we simply skip the
  // listeners (an account switch then needs a manual reload, a minor degrade).
  try {
    eth.on("accountsChanged", async () => {
      provider    = null;
      signer      = null;
      userAddress = null;
      _activeInjectedProvider = null;
      _walletChainOk = false; // drop back to the public read provider
      _clearSession();
      if (onChangeCallback) onChangeCallback(null);
    });
    eth.on("chainChanged", () => window.location.reload());
    _walletListenersBound = true; // only mark bound once both succeeded
  } catch (e) {
    console.warn("listenForAccountChanges: wallet event binding unavailable (provider proxy):", e && e.message);
  }
}

// Prompts the wallet's own account picker. MetaMask pops one straight
// from wallet_requestPermissions, but Brave Wallet resolves that call
// silently when the site already holds the eth_accounts permission — no
// popup, so "Switch Account" looked dead in Brave. Revoking the permission
// first (wallet_revokePermissions, EIP-2255) forces the wallet to show its
// connect/account picker on the next request. The revoke also fires
// accountsChanged, so the listener above ends the session immediately —
// by design, attempting a switch always ends the session and requires a
// fresh Connect Wallet, even if the picker is then cancelled.
async function handleSwitchAccount() {
  if (_embeddedProvider) {
    // An email wallet has exactly one account. "Switch" = sign out and let the
    // next Connect ask for a method / email again.
    disconnectWallet();
    window.location.reload();
    return;
  }
  const eth = injectedProvider();
  if (!eth) return;
  try {
    try {
      await eth.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }]
      });
    } catch (revokeErr) {
      // Wallet predates wallet_revokePermissions — requestPermissions
      // below still pops a picker on MetaMask-style wallets.
      console.warn("wallet_revokePermissions unavailable:", revokeErr?.message);
    }
    await eth.request({
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {} }]
    });
  } catch (err) {
    console.error("Switch account request failed:", err);
    alert("Switch accounts from your wallet extension, then reconnect.");
  }
}

// ─── Wallet chip: second tap copies the address ───────────────────────────────
// Every page defines its own toggleWalletMenu (open/close on tap). This
// capture-phase listener runs before that inline handler: when the dropdown is
// already open, a tap on the chip copies the connected address instead of
// closing the menu, with a brief "Copied" flash on the chip. Tapping anywhere
// else still closes the menu (the page's own outside-click handler).
document.addEventListener("click", (e) => {
  const btn = e.target && e.target.closest ? e.target.closest(".wallet-menu-btn") : null;
  if (!btn) return;
  const wi = document.getElementById("wallet-info");
  if (!wi || !wi.classList.contains("open") || !userAddress) return;
  e.stopPropagation();
  e.preventDefault();
  _copyWalletAddress();
}, true);

let _copyFlash = null;
async function _copyWalletAddress() {
  const addr = userAddress;
  if (!addr) return;
  let ok = false;
  try { await navigator.clipboard.writeText(addr); ok = true; } catch {}
  if (!ok) {
    // Older / restricted contexts: fall back to the selection API.
    try {
      const ta = document.createElement("textarea");
      ta.value = addr; ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
      document.body.appendChild(ta); ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    } catch {}
  }
  const el = document.getElementById("wallet-addr");
  if (!el) return;
  clearTimeout(_copyFlash);
  el.textContent = ok ? "Copied ✓" : "Copy failed";
  _copyFlash = setTimeout(() => { if (userAddress) el.textContent = fmtAddr(userAddress); }, 1200);
}

// ─── Theme (dark default, light optional) ─────────────────────────────────────
// The palette lives in CSS variables; data-theme="light" on <html> swaps it.
// An inline snippet in each page's <head> applies the saved theme before
// first paint (no dark flash); this section owns the toggle + button label.

const THEME_KEY = "timbswap_theme";

function _currentTheme() {
  try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; }
  catch { return "dark"; }
}

function _applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = theme === "light" ? "Dark Mode" : "Light Mode";
}

function toggleTheme() {
  const next = _currentTheme() === "light" ? "dark" : "light";
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  _applyTheme(next);
}

// Sync the attribute + button label on load (config.js runs after the DOM).
_applyTheme(_currentTheme());

// ─── DebugHub Stub ────────────────────────────────────────────────────────────
// Loaded by SDK script tag in each page. Fallback stub defined here
// so DebugHub never breaks TimbSwap if the SDK fails to load.
//
// CAPPED-BETA POSTURE: telemetry is localStorage-ONLY on mainnet. We deliberately
// omit telemetryUrl / supabaseUrl / supabaseKey, so the SDK's transmit() is a
// no-op (see assets/dh.js: "Omit them and the SDK behaves exactly like 1.1.0 —
// localStorage only"). Nothing about user wallets or activity leaves the device.
//
// Why: the network sink shipped a real off-chain surface on the money origin —
// every user's wallet address + chain id + events POSTed to a backend whose table
// allowed public anon SELECT. That is user-data exposure we don't want live while
// real value is at stake, and it contradicted the bug bounty's "telemetry is out
// of scope / never touch user data" stance (see SECURITY.md). Per-user debugging
// still works via the local #debug snapshot path — no backend required.
//
// To re-enable an AGGREGATED hub post-audit, first harden the backend (no public
// anon SELECT; read behind service-role/auth; hash or drop wallet addresses;
// rate-limit the relay) AND bring it explicitly into the bounty scope. Until then
// the same-origin relay route (workers/timbswap-api.js:/api/debughub_events)
// should stay disabled so there is no live sink to reach.

window.DEBUGHUB_CONFIG = {
  appName: "TimbSwap"
  // No telemetryUrl / supabaseUrl / supabaseKey during the capped beta →
  // localStorage-only. See the block above before adding a network sink back.
};

if (!window.DebugHub) {
  window.DebugHub = {
    startSession:  () => {},
    endSession:    () => {},
    logCheckpoint: () => {},
    logError:      () => {},
    logPerf:       () => {},
    logSecurity:   () => {}
  };
}

// Optimistic wallet chrome: config.js loads at the bottom of each page (after the
// nav), so the nav elements exist here. If a session is saved, show the
// connected nav immediately so a refresh never flashes the gated "Connect
// Wallet" state before autoReconnect() confirms. autoReconnect (in the page's
// init) then confirms it, or _clearSession() reverts it on a real disconnect.
try {
  const _savedAddr = _getSavedAddress();
  if (_savedAddr) applyWalletChrome(_savedAddr);
} catch {}
