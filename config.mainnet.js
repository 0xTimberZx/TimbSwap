// config.mainnet.js — Arbitrum One overrides for the ETH-only capped beta.
//
// NOT loaded on the testnet site. `NET=mainnet sh scripts/build-site.sh`
// prepends this file to config.js in the deployed bundle, so every page keeps
// its single config.js script tag and config.js's network constants pick these
// values up (they read window.TIMBSWAP_NET when present, Sepolia otherwise).
// The keepers regex-read the deployed config.js and take the FIRST match per
// key, so they see these addresses too.
//
// Addresses: MAINNET_ADDRESSES.md. The six beta contracts (marked) are filled
// in from the DeployBeta output before the mainnet bundle is built.
// Design: dev-docs/BETA_ETH_ONLY.md.
window.TIMBSWAP_NET = {
  chainId:   42161,
  chainName: "Arbitrum One",
  explorer:  "https://arbiscan.io",

  // Wallet add-chain uses only PUBLIC endpoints. App reads still go through the
  // same-origin /api/rpc proxy — the Worker's ALCHEMY_RPC_URL secret must be a
  // MAINNET endpoint (https://arb-mainnet.g.alchemy.com/v2/<key>) for this build.
  publicRpcs: [
    "https://arb1.arbitrum.io/rpc",
    "https://arbitrum-one-rpc.publicnode.com",
    "https://arbitrum.drpc.org",
  ],

  // Mainnet Privy app ("Continue with email"). Leave "" to hide the option.
  privyAppId: "",

  addresses: {
    // ── Beta deploy (scripts/DeployBeta.s.sol) — fill from its output ──
    GameRegistry:         "0x0000000000000000000000000000000000000000", // beta
    TimbPrize:            "0x0000000000000000000000000000000000000000", // beta
    PrizeVRFEntropy:      "0x0000000000000000000000000000000000000000", // beta
    TimbTreasury:         "0x0000000000000000000000000000000000000000", // beta
    GasFaucet:            "0x0000000000000000000000000000000000000000", // beta
    TimbSwapRouter:       "0x0000000000000000000000000000000000000000", // beta — new router (TS-009); the Phase-1 router 0x4f33…62b5fe is paused by DeployBeta

    // ── Live Phase 1 + Phase 2 (reused) ──
    TimbSwapFactory:      "0x60d4f18fe205c0ed38507a8fbf89aaa1bd2ce183",
    WETH:                 "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    TIMBSToken:           "0x44bc0ab521191e839c3cb5bb20c9d044c8471ea1",
    PrizeEscrow:          "0xa9355021cef39be7b67fb81a1c91df53fce0dd32",
    EligibleTokenRegistry:"0x0fd3777190380a12f106f57c67913f7159bc8c34",
    TimbYieldVault:       "0x73a33dbe76908cb2b05055931258878b0ae9b3cc",
    TimbsEthPair:         "0x6103c1145a0090ec0e39e9e75e6efb3c0099b86f",

    // ── Deployed, not part of the beta (hidden while TIMBS_LIVE is false) ──
    TimbStaking:          "0xed8d6d5fe6eedcd173dbc09ef9b6474e4f155a83",
    TimbFarm:             "0x1cb001784bc085fea2873782c1a0e71f4208a91f",
    TimbLockVault:        "0x6bdc48bb03ecedf958a5163d34d47c23655b461c",
    TimbGovernance:       "0x26d1e27132d1d5cdb449d641938c7da26cd5be63",

    // ── Not on mainnet ──
    TimbBoostFarm:        "0x0000000000000000000000000000000000000000",
    SegmentBoard:         "0x0000000000000000000000000000000000000000",
    PoolLedger:           "0x0000000000000000000000000000000000000000",
    VRFEntropy:           "0x0000000000000000000000000000000000000000",
    CommitRevealEntropy:  "0x0000000000000000000000000000000000000000",
    UnderwriteReserve:    "0x0000000000000000000000000000000000000000",
    DDJackpot:            "0x0000000000000000000000000000000000000000",
    SeedRegistry:         "0x0000000000000000000000000000000000000000",
    SegmentCrank:         "0x0000000000000000000000000000000000000000",
    USDC:                 "0x0000000000000000000000000000000000000000",
    LINK:                 "0x0000000000000000000000000000000000000000",
    USDT:                 "0x0000000000000000000000000000000000000000",
    DAPP:                 "0x0000000000000000000000000000000000000000",
  },
};
