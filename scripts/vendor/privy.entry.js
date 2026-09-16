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
} from "@privy-io/js-sdk-core";

export {
  Privy,
  LocalStorage,
  getUserEmbeddedEthereumWallet,
  getEntropyDetailsFromAccount,
  arbitrumSepolia,
  arbitrum,
};
