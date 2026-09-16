# "Continue with email" — Privy embedded wallets

Email one-time-code sign-in that yields a normal Ethereum address, so a player
with no wallet extension (most phones) can still connect, mint a ticket and
claim from the faucet. Nothing on-chain changes: the embedded wallet is an EOA
and every contract keys on `msg.sender` as before.

Status: **built, off by default.** `window.PRIVY_APP_ID` in `config.js` is
`""`, which hides the option completely and leaves every page behaving exactly
as before. Setting it turns the feature on for that deployment.

## How it fits the existing connect flow

```
Connect Wallet  →  _pickConnectMethod()
                     ├─ PRIVY_APP_ID unset      → "injected" (old behaviour, no sheet)
                     ├─ remembered choice        → that
                     ├─ no window.ethereum       → "email"
                     └─ both possible            → chooser sheet (asked once, remembered)
                  →  "email": TimbEmailWallet.login()  (sheet: email → code → wallet ready)
                              ⇒ _embeddedProvider = Privy EIP-1193 provider
                  →  the normal tail: eth_requestAccounts → _initProvider → _ensureChain → _saveSession(addr, kind)
```

The whole integration is one indirection in `config.js`: while
`_embeddedProvider` is set, `injectedProviders()` / `injectedProvider()` return
it, so `_initProvider`, `_ensureChain`, `autoReconnect`,
`listenForAccountChanges`, `handleSwitchAccount` and the DebugHub provider
label all work for email users without their own branches. The 12 per-page
`handleConnect()` functions are untouched — they call `connectWallet()` and
read `userAddress`, as always.

Files:

| File | Role |
|---|---|
| `config.js` | `PRIVY_APP_ID`, `SITE_ROOT`, `_embeddedProvider`, `_pickConnectMethod`, `_loadEmailLogin`, session kind + remembered method, email branches in `connectWallet` / `autoReconnect` / `disconnectWallet` / `handleSwitchAccount` |
| `assets/email-login.js` | the sheet (chooser, email, code, wallet-ready) + the Privy bridge (`window.TimbEmailWallet`). Injected on demand by `config.js`. |
| `vendor/privy-core.js` | `@privy-io/js-sdk-core` bundled (ESM, ~800 KB). `import()`-ed only when a user picks email. **Generated** by `scripts/build-vendor.mjs`; never edit. |
| `style.css` | `.tsheet-*` styles |
| `package.json` | dev-only: pins the SDK version + esbuild. The site still has no build step. |

Loading cost: extension users load nothing new. Email users load the sheet
script (~10 KB) on the first connect and the SDK bundle only after choosing
email.

## What the user gets

- **An embedded EOA.** A plain `0x…` address. The key is split between Privy's
  iframe (`auth.privy.io`, mounted hidden on the page) and this browser; Privy
  cannot sign alone and neither can the page. Recovery is Privy-managed by
  default (same email on another device restores the wallet). Exporting the key
  to MetaMask is a Privy feature we have not surfaced yet.
- **Session.** Privy keeps its own session in `localStorage`; ours records
  `timbswap_wallet_kind = "email"` next to the saved address so `autoReconnect`
  rehydrates the Privy provider first. A manual Disconnect logs out of Privy and
  forgets the remembered method (that is how you switch methods).
- **Signing.** The headless SDK signs when the page asks — there is no Privy
  confirmation modal. Each page's button already states what it is about to do.
- **Cold start.** The wallet starts with 0 ETH, so it cannot mint a first
  ticket. The "wallet ready" step shows the address with a copy button and says
  so. Gas sponsorship (ERC-4337 / paymaster) is the phase-two answer; it is not
  in this drop.

## Privy dashboard setup (per environment)

One Privy app per deployment (dev mirror and live site), because allowed
origins and analytics are per app. App IDs are public; the app **secret** is
never needed by the frontend and must not be put anywhere in this repo.

1. dashboard.privy.io → New app → name it (e.g. "TimbSwap dev mirror").
2. **Login methods:** Email only. Turn everything else off.
3. **Embedded wallets → Ethereum:** enabled. "Create on login" can stay off —
   `email-login.js` calls `create()` itself when a user has no wallet.
4. **Allowed origins / domains:** this deployment's origin
   (`https://0xtimberzx.github.io` for the mirror, `https://timbswap.xyz` for
   live). Missing this = the iframe refuses to load.
5. **Chains:** add Arbitrum Sepolia (421614) now, Arbitrum One (42161) when the
   site moves. `email-login.js` picks the one matching `CHAIN_ID`.
6. Copy the **App ID** into `config.js` → `window.PRIVY_APP_ID`.

## Rebuilding the vendored SDK

```
npm ci
npm run build:vendor      # writes vendor/privy-core.js
```

Bump the pinned `@privy-io/js-sdk-core` in `package.json` first when
upgrading. `scripts/vendor/privy.entry.js` re-exports only the six names the
bridge uses, so a rename upstream fails the build instead of a user's browser.

## Test checklist (dev mirror, before the live site)

- [ ] `PRIVY_APP_ID = ""`: every page connects exactly as before; no sheet, no
      extra network requests (check DevTools → Network for `privy`).
- [ ] App ID set, browser **without** an extension (phone Safari / a clean
      profile): Connect → goes straight to the email step; code arrives;
      "wallet ready" shows an address; nav shows connected; refresh keeps it;
      Disconnect logs out; next Connect asks again.
- [ ] App ID set, browser **with** MetaMask: chooser shows both; pick browser
      wallet → identical to today; Disconnect → chooser returns.
- [ ] **Brave with Shields up** (our main tested browser): the Privy iframe
      needs third-party storage. If sign-in fails with the "storage" message,
      document the Shields setting users need, or gate the option on a probe.
- [ ] Email wallet funded with a little Sepolia ETH: mint a ticket from
      `/compete/`, claim from `/faucet/` (the claim edge fn sees a normal
      address), swap on `/swap/`. Confirm `confirmTx` resolves (receipts come
      from the public RPC, not the wallet).
- [ ] Wrong-chain path: not reachable for email wallets (the provider is pinned
      to `CHAIN_ID`), but confirm `_ensureChain` returns cleanly.
- [ ] DebugHub label reads `privy-email` on the connect checkpoint.

## Not in this drop

- The three `tables/*` pages (SwapTables) use their own provider code with
  direct `window.ethereum` calls and ethers v6 — same treatment, separate PR.
- Gas sponsorship / smart accounts; key export UI; MFA / recovery password UI.
- The live site (`TestSwap`): port after the mirror pass above.
