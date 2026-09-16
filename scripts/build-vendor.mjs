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

import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const privyVersion = pkg.devDependencies["@privy-io/js-sdk-core"];

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
