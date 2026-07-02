// frontend/config.js
// Single source of truth for all contract addresses, chain config,
// and shared ethers setup. Every page imports from here.

// ─── Chain ───────────────────────────────────────────────────────────────────

const CHAIN_ID   = 421614;
const CHAIN_NAME = "Arbitrum Sepolia";
const RPC_URL    = "https://sepolia-rollup.arbitrum.io/rpc";

const CHAIN_CONFIG = {
  chainId:   "0x" + CHAIN_ID.toString(16),
  chainName: CHAIN_NAME,
  nativeCurrency: { name: "Ethereum", symbol: "ETH", decimals: 18 },
  rpcUrls:        [RPC_URL],
  blockExplorerUrls: ["https://sepolia.arbiscan.io"]
};

// ─── Contract Addresses ───────────────────────────────────────────────────────

const ADDRESSES = {
  PrizeEscrow:          "0x865C50d933e63BbE388EEAFa017AE634B0A6fB6D",
  TIMBSToken:           "0x2Aaa61E2c08Ff61c93E960EcCd5Dd7fedF0bfaAa",
  TimbSwapFactory:      "0xCCd6d3f0A86042d2B7056eDd381d367126628AF5",
  TimbSwapRouter:       "0x781833D60800b93C3a9EFf234b15934F9AE0C5E7",
  EligibleTokenRegistry:"0xbFF59a3408B2574AcE948F130f0fA2f2CB149F04",
  GameRegistry:         "0xf6fC4c726071Bd2Ce32826324E52dfC5A24FCb97",
  TimbPrize:            "0x257F3658e29a7026CeebdcB352509d82A0993e4b",
  TimbStaking:          "0xe776c7b700B190ED8248741F9b518B08d8733C8F",
  TimbFarm:             "0xE319E2206F71A5cD8dd2c411C6F29712935f9011",
  TimbLockVault:        "0x0157086E7670D1eFb15DC6b5158eE78279927a41",
  TimbTreasury:         "0x486Fa4D8351EF81136E83340eA1e3aa2272c9955",
  TimbGovernance:       "0x8a324EfDc457BfB9Cf3D077E4CBC5A16a1c6a061",
  TimbsEthPair:         "0x5a911CBfD2808Ad5214E842a0E8ae34d8199BB95",
  WETH:                 "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73",
  DAPP:                 "0x3d0cB8929c22F93A9dd33921E6f43C1621FCfC04",
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
  }
];

// ─── Ethers Setup ─────────────────────────────────────────────────────────────

// Loaded from CDN in each HTML page:
// <script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js"></script>

let provider = null;
let signer   = null;
let userAddress = null;

// ─── Session Persistence ──────────────────────────────────────────────────────
// Keeps wallet connected across page navigations without re-prompting.
// sessionStorage clears when the browser tab is closed — no stale state.

const SESSION_KEY = "timbswap_wallet";

function _saveSession(address) {
  try { sessionStorage.setItem(SESSION_KEY, address); } catch {}
}

function _clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
}

function _getSavedAddress() {
  try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; }
}

async function _initProvider() {
  provider    = new ethers.providers.Web3Provider(window.ethereum);
  signer      = provider.getSigner();
  userAddress = await signer.getAddress();
}

async function _ensureChain() {
  const network = await provider.getNetwork();
  if (Number(network.chainId) === CHAIN_ID) return;

  // Wrong chain — try to switch
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_CONFIG.chainId }]
    });
  } catch (switchErr) {
    if (switchErr.code === 4902) {
      // Chain not added yet — add it
      try {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [CHAIN_CONFIG]
        });
      } catch (addErr) {
        alert("Could not add Arbitrum Sepolia to your wallet.\nPlease add it manually:\nChain ID: 421614\nRPC: https://sepolia-rollup.arbitrum.io/rpc");
        throw addErr;
      }
    } else if (switchErr.code === 4001) {
      // User rejected the switch
      alert("Please switch to Arbitrum Sepolia (Chain ID: 421614) in your wallet before connecting.");
      throw switchErr;
    } else {
      // Silent switch failures (common on mobile) — alert with manual instruction
      alert("Please switch your wallet to Arbitrum Sepolia (Chain ID: 421614) and tap Connect again.\n\nIf Arbitrum Sepolia is not in your wallet, add it:\nRPC: https://sepolia-rollup.arbitrum.io/rpc\nChain ID: 421614");
      throw switchErr;
    }
  }
  await _initProvider();
}

async function connectWallet() {
  if (!window.ethereum) {
    alert("No wallet detected. Please use MetaMask or Brave Wallet.");
    return false;
  }
  try {
    await _initProvider();
    await provider.send("eth_requestAccounts", []);
    await _initProvider();
    await _ensureChain();
    _saveSession(userAddress);
    return true;
  } catch (err) {
    console.error("connectWallet failed:", err);
    // Log chain ID at point of failure for DebugHub diagnosis
    try {
      const failNet = await provider.getNetwork();
      console.warn("connectWallet: wallet was on chainId", failNet.chainId.toString(), "— needs 421614");
    } catch {}
    return false;
  }
}

/**
 * Call on every page load to silently reconnect if the user was already
 * connected. Returns the connected address or null.
 * Usage in each page's init:
 *   const addr = await autoReconnect();
 *   if (addr) { showWalletUI(addr); loadUserData(); }
 */
async function autoReconnect() {
  if (!window.ethereum) return null;
  const saved = _getSavedAddress();
  if (!saved) return null;

  try {
    // Check wallet still has the account active (no popup)
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    if (!accounts || accounts.length === 0) { _clearSession(); return null; }
    if (accounts[0].toLowerCase() !== saved.toLowerCase()) {
      _clearSession(); return null;
    }
    await _initProvider();
    await _ensureChain();
    return userAddress;
  } catch {
    _clearSession();
    return null;
  }
}

function getContract(name, signerOrProvider) {
  const address = ADDRESSES[name];
  if (!address) throw new Error(`Unknown contract: ${name}`);
  // ABI loaded separately per page to avoid loading all ABIs everywhere
  throw new Error(`getContract: load ABI for ${name} before calling`);
}

// ─── Gas Helpers (ecosystem pattern) ─────────────────────────────────────────

async function getGasParams() {
  const feeData = await provider.getFeeData();
  return {
    maxFeePerGas:         feeData.maxFeePerGas.mul(130).div(100),
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas.mul(130).div(100),
  };
}

async function getPendingNonce() {
  return provider.getTransactionCount(userAddress, "pending");
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

function listenForAccountChanges(onChangeCallback) {
  if (!window.ethereum) return;
  window.ethereum.on("accountsChanged", async (accounts) => {
    if (accounts.length === 0) {
      provider    = null;
      signer      = null;
      userAddress = null;
      _clearSession();
    } else {
      provider    = new ethers.providers.Web3Provider(window.ethereum);
      signer      = provider.getSigner();
      userAddress = accounts[0];
      _saveSession(userAddress);
    }
    if (onChangeCallback) onChangeCallback(userAddress);
  });
  window.ethereum.on("chainChanged", () => window.location.reload());
}

// ─── DebugHub Stub ────────────────────────────────────────────────────────────
// Loaded by SDK script tag in each page. Fallback stub defined here
// so DebugHub never breaks TimbSwap if the SDK fails to load.

window.DEBUGHUB_CONFIG = { appName: "TimbSwap" };

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
