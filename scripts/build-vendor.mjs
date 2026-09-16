// Builds the vendored browser bundles committed under vendor/.
//
// The site is static (GitHub Pages serves the repo as-is, no build step), so
// anything that only ships on npm has to be bundled once and committed. Run
// this after bumping a pinned version in package.json, then commit the output:
//
//   npm ci && npm run build:vendor
//
// Bundles:
//   vendor/privy-core.js  — @privy-io/js-sdk-core (email login + embedded
//                           wallet), ESM, minified. Loaded lazily by
//                           assets/email-login.js only when a user picks
//                           "Continue with email", so extension users never
//                           download it. Entry: scripts/vendor/privy.entry.js.
//   vendor/qrcode.js      — qrcode-generator, ESM, minified. Loaded by the
//                           email wallet's authenticator (MFA) enrollment step
//                           to draw the otpauth:// QR. Entry:
//                           scripts/vendor/qrcode.entry.js.
//   vendor/hpke.js        — @hpke/core + @hpke/chacha20poly1305, ESM, minified.
//                           Loaded by the private-key export's reveal step to
//                           decrypt Privy's client-export payload in the page.
//                           Entry: scripts/vendor/hpke.entry.js.

import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const privyVersion = pkg.devDependencies["@privy-io/js-sdk-core"];
const qrVersion = pkg.devDependencies["qrcode-generator"];
const hpkeVersion = pkg.devDependencies["@hpke/core"];

await build({
  entryPoints: ["scripts/vendor/privy.entry.js"],
  outfile: "vendor/privy-core.js",
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  banner: {
    js: `/* vendor/privy-core.js — @privy-io/js-sdk-core ${privyVersion}, bundled by scripts/build-vendor.mjs. Generated: do not edit. */`,
  },
  logLevel: "info",
});

await build({
  entryPoints: ["scripts/vendor/qrcode.entry.js"],
  outfile: "vendor/qrcode.js",
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  legalComments: "none",
  banner: {
    js: `/* vendor/qrcode.js — qrcode-generator ${qrVersion}, bundled by scripts/build-vendor.mjs. Generated: do not edit. */`,
  },
  logLevel: "info",
});

await build({
  entryPoints: ["scripts/vendor/hpke.entry.js"],
  outfile: "vendor/hpke.js",
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  legalComments: "none",
  banner: {
    js: `/* vendor/hpke.js — @hpke/core ${hpkeVersion} + @hpke/chacha20poly1305, bundled by scripts/build-vendor.mjs. Generated: do not edit. */`,
  },
  logLevel: "info",
});
