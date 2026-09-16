# "Continue with email" — Privy embedded wallets

Email one-time-code sign-in that yields a normal Ethereum address, so a player
with no wallet extension (most phones) can still connect, mint a ticket and
claim from the faucet. Nothing on-chain changes: the embedded wallet is an EOA
and every contract keys on `msg.sender` as before.

Status: **built; ON for the dev mirror** (`window.PRIVY_APP_ID` set in
`config.js`). An empty value hides the option completely and leaves every page
behaving exactly as before, which is how the live site stays until its own
Privy app exists and the mirror pass below is done.

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
- **Signing — confirmation sheet.** The headless SDK has no popup of its own,
  so the provider handed to `config.js` is wrapped by `guard()` in
  `email-login.js`: every write request (`eth_sendTransaction`, `personal_sign`,
  typed data, chain add) opens a sheet first and only reaches Privy after
  Confirm. Reject / Escape throws the standard EIP-1193 4001 error every call
  site already handles. Reads pass straight through. The sheet shows:
  - the action, decoded with a human-readable ABI of the calls the site makes
    (`KNOWN_ABI`): ticket characters + escrow + extra rounds, swap "you pay /
    you receive ≥ min" with token symbols (known tokens from `ADDRESSES`,
    others read via `symbol()`/`decimals()`), recipient, deadline, meter
    nudge, approve spender + allowance ("Unlimited"), stake / farm / lock /
    vote params; unknown selectors fall back to "Contract call 0x…";
  - the fee: gas limit (`eth_estimateGas` unless the page set one), max fee per
    gas, network fee (max), total (max), current nonce, and a warning when
    amount + fee exceeds the wallet's balance; a failed estimate is shown as
    "this transaction would likely fail: <reason>";
  - **Advanced: gas & nonce** — gas limit, max fee (gwei) and nonce overrides,
    validated and applied to the request only on Confirm (reusing a pending
    nonce with a higher fee replaces that transaction);
  - after Confirm the sheet stays open in a "Sending…" state; on success it
    closes, on a wallet / node error it shows a plain-language reason
    (insufficient funds, nonce too low, replacement underpriced, revert
    reason, gas too low) with Close, and the call rejects with the original
    error so the page's own handling still runs.
  **Limit:** this stops bugs and accidental sends; a script with full control
  of the page could still drive the sheet. The out-of-page answer is Privy's
  transaction MFA (dashboard → Authentication → MFA; the headless SDK then
  needs an MFA prompt built on `privy.mfaPromises`) — phase two. Until then the
  wallet-ready copy tells users to keep only what they are playing with in it.
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
5. **Chains:** nothing to set in the dashboard. The headless SDK takes its chain
   list from code: `email-login.js` passes Arbitrum Sepolia (421614) or
   Arbitrum One (42161) to match `CHAIN_ID`, and the embedded wallet defaults
   to the first chain given. (Privy's dashboard chain settings only affect its
   React modal / funding UI, which this site does not use.)
6. Copy the **App ID** (App settings → Basics) into `config.js` →
   `window.PRIVY_APP_ID`. Dev mirror: `cmu3mq0in04v90bjyc1y38iij`
   ("TimbSwap Dev", development mode).

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
