// Entry for vendor/hpke.js (see scripts/build-vendor.mjs).
// HPKE (RFC 9180) for the email wallet's private-key export: the page makes a
// P-256 key pair, hands the public key to Privy's export frame, and Privy
// returns the key encrypted to it (DHKEM-P256 + HKDF-SHA256, ChaCha20-Poly1305
// by default, AES-256-GCM as the alternative). Decryption happens in this
// page; nothing leaves it. Loaded only on the reveal step.
import { CipherSuite, DhkemP256HkdfSha256, HkdfSha256, Aes256Gcm } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";

function suite(aead) {
  return new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: aead === "aes" ? new Aes256Gcm() : new Chacha20Poly1305() });
}
const b64 = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
  dec: (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).buffer,
};

/** A fresh recipient key pair; `publicKeyDer` is base64 SPKI (what Privy expects). */
export async function generateRecipient() {
  const kp = await suite("chacha").kem.generateKeyPair();
  const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
  return { privateKey: kp.privateKey, publicKeyDer: b64.enc(spki) };
}

/** Decrypt Privy's export payload. Tries ChaCha20-Poly1305, then AES-256-GCM. Returns bytes. */
export async function decryptExport({ ciphertext, encapsulatedKey, privateKey }) {
  let lastErr = null;
  for (const aead of ["chacha", "aes"]) {
    try {
      const ctx = await suite(aead).createRecipientContext({ recipientKey: privateKey, enc: b64.dec(encapsulatedKey) });
      return new Uint8Array(await ctx.open(b64.dec(ciphertext)));
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("decrypt failed");
}

/** Test helper (the smoke suite's fake export page uses it): encrypt `bytes` to a base64-SPKI recipient. */
export async function sealForRecipient(publicKeyDer, bytes, aead = "chacha") {
  const s = suite(aead);
  const pub = await crypto.subtle.importKey("spki", b64.dec(publicKeyDer), { name: "ECDH", namedCurve: "P-256" }, true, []);
  const ctx = await s.createSenderContext({ recipientPublicKey: pub });
  const ct = await ctx.seal(bytes);
  return { ciphertext: b64.enc(ct), encapsulatedKey: b64.enc(ctx.enc) };
}
