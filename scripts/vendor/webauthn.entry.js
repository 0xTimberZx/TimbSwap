// Entry for vendor/webauthn.js (see scripts/build-vendor.mjs).
// WebAuthn helpers for passkey MFA in the email wallet: turn Privy's
// registration / authentication options into navigator.credentials calls and
// hand back JSON the SDK accepts. Loaded only on the passkey steps.
export {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
} from "@simplewebauthn/browser";
