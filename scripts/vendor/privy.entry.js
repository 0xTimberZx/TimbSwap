// Entry for vendor/privy-core.js (see scripts/build-vendor.mjs).
// Re-export only what assets/email-login.js uses, so the surface we depend on
// is explicit and a version bump that renames any of these fails at build time
// rather than in a user's browser.
import Privy, {
  LocalStorage,
  getUserEmbeddedEthereumWallet,
  getEntropyDetailsFromAccount,
  arbitrumSepolia,
  arbitrum,
  rpc,
} from "@privy-io/js-sdk-core";

// `rpc` is the wallet-API call (POST /v1/wallets/{id}/rpc, signed by the
// user's signer) that email-login.js uses for gas-sponsored sends.
export {
  Privy,
  LocalStorage,
  getUserEmbeddedEthereumWallet,
  getEntropyDetailsFromAccount,
  arbitrumSepolia,
  arbitrum,
  rpc,
};
