# "Continue with email" — Privy embedded wallets

Email one-time-code sign-in that yields a normal Ethereum address, so a player
with no wallet extension (most phones) can still connect, mint a ticket and
claim from the faucet. Nothing on-chain changes: the embedded wallet is an EOA
and every contract keys on `msg.sender` as before.

Status: **ON — live site** (`window.PRIVY_APP_ID` set in `config.js` to the
"TimbSwapArb" Privy app, allowed origin `https://timbswap.xyz`). Setting it to
`""` hides the option completely and leaves every page behaving exactly as
before — that is the kill switch. The dev mirror (TimbSwap repo) runs its own
Privy app and passed the checklist below first (phone browser without an
extension, Brave with its built-in wallet).

## How it fits the existing connect flow

```
Connect Wallet  →  _pickConnectMethod()
                     ├─ PRIVY_APP_ID unset      → "injected" (old behaviour, no sheet)
                     ├─ no window.ethereum       → "email"
                     └─ both possible            → chooser sheet, on every fresh connect
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
| `assets/email-login.js` | the sheet (chooser, email, code, wallet-ready, confirm, authenticator prompt, Wallet security) + the Privy bridge (`window.TimbEmailWallet`). Injected on demand by `config.js`. |
| `vendor/privy-core.js` | `@privy-io/js-sdk-core` bundled (ESM, ~800 KB). `import()`-ed only when a user picks email. **Generated** by `scripts/build-vendor.mjs`; never edit. |
| `vendor/webauthn.js` | `@simplewebauthn/browser` bundled (ESM, ~9 KB). `import()`-ed only on the passkey steps (register / authenticate). **Generated**; never edit. |
| `vendor/hpke.js` | `@hpke/core` + `@hpke/chacha20poly1305` bundled (ESM, ~43 KB). `import()`-ed only on the key-export reveal step. **Generated**; never edit. |
| `vendor/qrcode.js` | `qrcode-generator` bundled (ESM, ~20 KB). `import()`-ed only on the authenticator enrolment step, to draw the `otpauth://` QR. **Generated**; never edit. |
| `tables/wallet.js` | the SwapTables pages' bridge to the above (chooser / email / restore, chip icons incl. Wallet security for email sessions). |
| `package.json` | dev-only: pins the SDK + QR library versions and esbuild. The site still has no build step. |

Loading cost: extension users load nothing new. Email users load the sheet
script (~10 KB) on the first connect and the SDK bundle only after choosing
email.

## What the user gets

- **An embedded EOA.** A plain `0x…` address. The key is split between Privy's
  iframe (`auth.privy.io`, mounted hidden on the page) and this browser; Privy
  cannot sign alone and neither can the page. Recovery is Privy-managed by
  default (same email on another device restores the wallet). The key can be
  exported to MetaMask from Wallet security (below).
- **Session.** Privy keeps its own session in `localStorage`; ours records
  `timbswap_wallet_kind = "email"` next to the saved address so `autoReconnect`
  rehydrates the Privy provider first. A manual Disconnect logs out of Privy. Every
  fresh connect shows the chooser again when both methods are possible (no
  remembered choice — a saved session still auto-reconnects without it).
- **Idle timeout — 360 minutes, every wallet kind.** `config.js` stamps the
  last interaction (pointer / key / touch / scroll, at most every 15 s) in
  `sessionStorage`; a connected session whose stamp is older than 6 h is torn
  down (email wallets log out of Privy) and the page hard-refreshes to the
  gated view (a cache-busting `?_r=` reload, so it also picks up the latest
  site files). Checked on every page load, once a minute, and when the tab comes
  back into view.
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
  of the page could still drive the sheet. The out-of-page answer is the
  authenticator app below.
- **Transaction MFA — authenticator app (TOTP) or passkey.** Optional per user, offered
  on the wallet-ready step after sign-in and any time under **Wallet
  security** (wallet dropdown on the main pages; the shield icon on the
  SwapTables chip). Enrolment: `privy.mfa.initEnrollMfa({method:"totp"})`
  returns the secret + `otpauth://` URI, shown as a QR (`vendor/qrcode.js`),
  the key with Copy, and an "Open in authenticator app" link; the first code
  from the app goes to `submitEnrollMfa`. Once enrolled, **Privy's iframe
  refuses every signing request until it gets the current 6-digit code**: the
  SDK emits `mfaRequired` on `privy.mfaPromises`, `email-login.js` swaps the
  sheet's "Sending…" state for the code prompt, and resolves
  `mfaPromises.rootPromise.current` with `{ mfaMethod: "totp", mfaCode,
  relyingParty }`. Each try is reported through `mfaPromises.submitPromise`
  (a fresh `{resolve, reject}` pair is installed before every submit): a wrong
  code shows "didn't match" in place; SDK limits are 3 codes per request and
  5 minutes per prompt, after which the request fails with a plain reason
  ("Too many wrong authenticator codes…" / "Timed out…"). Cancel / Escape /
  × in the prompt rejects the request with the same 4001 error as Reject.
  The check runs inside Privy's iframe — nothing on the page can sign
  without the phone. Privy caches a verification for 15 minutes (dashboard
  "Custom cache duration"), so within that window further transactions go
  from Confirm straight to the wallet; the sheet copy says "at most once
  every 15 minutes" — update it if you change the cache.
  **Passkey** (Face ID / fingerprint / device PIN, WebAuthn): same prompt,
  answered with an assertion instead of a code. Enrolment (Wallet security →
  "Set up a passkey", or on the wallet-ready step): Privy stores passkeys as
  linked accounts, so `auth.passkey.generateRegistrationOptions()` →
  `startRegistration` (`vendor/webauthn.js`, @simplewebauthn/browser) →
  `auth.passkey.linkWithPasskey(response, relying_party)` links one, then
  `mfa.submitEnrollMfa({ method: "passkey", credentialIds })` enrols its
  credential id. Verification: `mfa.passkey.generateAuthenticationOptions()`
  → `startAuthentication` → the assertion, snake-cased, goes to
  `rootPromise.resolve({ mfaMethod: "passkey", mfaCode, relyingParty:
  window.origin })`. With both methods enrolled the prompt shows the code
  field plus "Use passkey instead". Removal: `submitEnrollMfa({ method:
  "passkey", credentialIds: [] })` (asks for one last verification). Options
  and responses cross the wire in snake_case; the site converts to/from the
  camelCase JSON WebAuthn wants, exactly as Privy's React SDK does. The key
  export's pre-check accepts either method. Device cancel shows "Passkey step
  cancelled" and leaves the prompt open. Removing the authenticator (`unenrollMfa("totp")`) asks
  for one last code. Only TOTP is offered: no phone number to hold, works
  offline, no regional SMS limits; SMS / passkey enrolment is not built (a
  wallet that somehow has only those gets a "can't collect yet" message).
  The Privy dashboard must have MFA turned on for the app (setup step 7).
  Note the wallet-ready copy still tells users to keep only what they are
  playing with in the wallet.
- **Private key export.** Wallet security → **Export private key**, three
  steps, nothing leaves the browser:
  1. *Warnings + disclaimer* (control is absolute and irrevocable; never
     paste into a site / chat / email; nothing is recoverable; the key is
     decrypted in this browser only and never sent to TimbSwap's servers or
     the email; clear the clipboard; TimbSwap is not a custodian and accepts
     no liability). "Send a code" stays disabled until the checkbox is
     ticked.
  2. *Code by email*: Privy's one-time code to the wallet's email
     (`auth.email.sendCode` → `loginWithCode(email, code, "no-signup")`,
     which re-verifies the same account). The email carries the code only —
     the key is never emailed (an email cannot have a working copy button
     and would keep the key forever in inboxes and backups).
  3. *Reveal*. With an authenticator enrolled, `privy.mfa.verifyMfa()` first
     (the same prompt as a transaction; Privy's React SDK forces this before
     its export screen and without it the export page answers "Invalid JWT
     token provided"). TEE-stack wallet (`account.id` + `recovery_method
     "privy-v2"`): Privy's **client export** — the page makes a P-256 key
     pair (`vendor/hpke.js`), loads Privy's export page hidden
     (`/apps/<appId>/embedded-wallets/export?v=1-unified&wallet_id=…&mode=client-export#token=…`),
     — the `#token=` is **Privy's access token** (`getAccessTokenInternal()`,
     what the wallet iframe and Privy's React SDK use), not the customer
     token from `getAccessToken()`, which the export page rejects as
     "Invalid JWT"; a rejected token gets one retry after a session refresh —
     posts `CLIENT_EXPORT_REQUEST { recipientPublicKey }` (base64 SPKI) and
     gets `CLIENT_EXPORT_RESPONSE { ciphertext, encapsulatedKey }` back,
     HPKE (DHKEM-P256 / HKDF-SHA256 / ChaCha20-Poly1305, AES-256-GCM tried
     second) decrypted in the page. Shown **masked** (`0x1234••••abcd`),
     Show / Hide, **Copy key** (with a "clear your clipboard" reminder),
     Done wipes it. Older wallet (no client export): Privy's own hosted copy
     button in a 44 px frame (`v=1` + entropy ids + palette; the key is
     copied from inside Privy's origin). Client export is a per-app switch in
     the Privy dashboard ("Client wallet export is not enabled" until it is
     on; Wallet infrastructure → Advanced, or ask Privy to enable it); until
     then the reveal falls back to the hosted copy button. Privy's page asks
     for MFA itself when enrolled.
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
   ("TimbSwap Dev", development mode). Live site: `cmu3ofl2r01h90clecz8wtrhc`
   ("TimbSwapArb").
7. **MFA:** Authentication → MFA (the wallet / "Multi-factor authentication"
   section) → enable it for the app and make sure the **Authenticator app
   (TOTP)** method is allowed, and tick **Passkey** as well. Passkey
   enrolment links a passkey to the user's account first; if Privy rejects
   the link with a "passkeys not enabled" style error, also enable Passkeys
   under Login methods (the site never offers passkey *login*, only MFA).
   Do not pick "require for all users" unless you
   want sign-in itself to insist on it — the site offers enrolment on the
   wallet-ready step and under Wallet security, and Privy enforces the code
   on every signing request for users who enrolled. Without this switch,
   `initEnrollMfa` fails and the sheet says "Authenticator setup isn't
   enabled for this app yet".

## Rebuilding the vendored SDK

```
npm ci
npm run build:vendor      # writes vendor/privy-core.js, vendor/qrcode.js, vendor/hpke.js, vendor/webauthn.js
```

Bump the pinned `@privy-io/js-sdk-core` (or `qrcode-generator`) in
`package.json` first when upgrading. `scripts/vendor/privy.entry.js`
re-exports only the six names the bridge uses, so a rename upstream fails the
build instead of a user's browser; `scripts/vendor/qrcode.entry.js` exports
one `qrSvg()`. Commit only the bundle you meant to change — a different
esbuild build re-minifies the other one into a no-op diff.

## Test checklist (dev mirror, before the live site)

- [ ] `PRIVY_APP_ID = ""`: every page connects exactly as before; no sheet, no
      extra network requests (check DevTools → Network for `privy`).
- [ ] App ID set, browser **without** an extension (phone Safari / a clean
      profile): Connect → goes straight to the email step; code arrives;
      "wallet ready" shows an address; nav shows connected; refresh keeps it;
      Disconnect logs out; next Connect asks again.
- [ ] App ID set, browser **with** MetaMask: chooser shows both on every fresh
      connect; pick browser wallet → identical to today.
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
- [ ] **Authenticator app:** dashboard MFA on. Sign in → wallet-ready offers
      "Add an authenticator app" → QR scans in Google Authenticator / Authy →
      first code turns it on. Then a ticket mint: Confirm → "Approve with your
      authenticator" → wrong code says "didn't match" in place → right code
      sends. Cancel in the prompt behaves like Reject (no error sheet). Wallet
      dropdown shows **Wallet security** (email sessions only) with On/Off,
      remove asks for a code; SwapTables chip shows the shield icon.
- [ ] **Passkey:** Wallet security → Set up a passkey → device prompt →
      "Passkey On"; a ticket mint asks "Use passkey" (or, with the
      authenticator also on, shows the code field plus "Use passkey
      instead"); device cancel → "Passkey step cancelled"; Remove passkey asks
      for one last verification. Works on the phone (Face ID / fingerprint)
      and on desktop Chrome / Safari with a platform authenticator.
- [ ] **Key export:** Wallet security → Export private key → tick the
      acknowledgement → code arrives by email → masked key with Show and Copy
      (TEE wallet) or Privy's copy button (older wallet); MetaMask → Import
      account → the same address. Done wipes the key from the page.

## Not in this drop

- The three `tables/*` pages — done in the live repo (`tables/wallet.js`);
  SwapTables is not carried in this repo.
- Recovery password UI — **struck.** It is for Privy's older split-key
  wallets: a user passcode that encrypts the recovery share so Privy alone
  cannot rebuild the wallet (new device → password; lost password + lost
  device → wallet gone). The SDK refuses it for TEE-stack wallets
  (`unsupported_recovery_method`), which is where this app's wallets are;
  their protections are the authenticator and key export (in — see above).
- SMS MFA — **struck by decision:** no phone numbers; the less identity data
  the better. (Passkey MFA is in — see above.)
- Smart accounts / batching — **not planned.** A smart account is a different
  address (a contract, not the EOA), so every player would get a new identity
  on the game contracts; folding approve + enter into one confirmation is not
  worth that. Sponsorship and session keys were the other reasons to want one,
  and both are off by decision.
- Gas sponsorship: built and closed unmerged by decision (TestSwap #432) —
  participants hold their own gas.
