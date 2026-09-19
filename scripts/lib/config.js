// lib/config.js — readers for config.js, the one input every keeper shares.
//
// config.js is the frontend's source of truth for addresses and RPCs, and the
// keepers read it directly so the site and the automation can never disagree
// about which contract is live. Reading it by regex is brittle by nature (the
// multi-RPC refactor once turned `const RPC_URL = "https://…"` into
// `const RPC_URL = PUBLIC_RPCS[0]` and a keeper's literal-only pattern matched
// nothing), so every reader here tries the current shape, then the previous
// one, then a known-good default — and says so when it falls through.

const fs   = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const CONFIG_PATH   = path.join(__dirname, "..", "..", "config.js");
const CANONICAL_RPC = "https://sepolia-rollup.arbitrum.io/rpc";

/** The raw text of config.js (or another file, for tests). Throws if unreadable. */
function configSrc(file = CONFIG_PATH) {
  return fs.readFileSync(file, "utf8");
}

/**
 * ADDRESSES.<key> as a checksummed address.
 * Throws when the key is missing or, unless `allowZero`, when it is the zero
 * address: a keeper pointed at 0x0 must stop, not silently no-op.
 */
function addrFromConfig(key, { allowZero = false, src } = {}) {
  const text = src ?? configSrc();
  const m = text.match(new RegExp("\\b" + key + '\\s*:\\s*"(0x[0-9a-fA-F]{40})"'));
  if (!m) throw new Error(`Address "${key}" not found in config.js`);
  const a = ethers.getAddress(m[1]);
  if (!allowZero && a === ethers.ZeroAddress) throw new Error(`"${key}" is the zero address in config.js`);
  return a;
}

/**
 * The canonical PUBLIC RPC for reads and event scans.
 *
 * Deliberately not the keyed/metered endpoint: those cap eth_getLogs to a
 * handful of blocks (observed live: 10) and epoch-wide or backfill scans are
 * tens of thousands wide. Transactions may use a keyed endpoint; reads should
 * not. Order: a literal `RPC_URL = "…"`, then PUBLIC_RPCS[0], then the
 * hard-coded canonical endpoint — a keeper that refuses to start is worse than
 * one on a known-good default.
 */
function rpcFromConfig({ src, quiet = false } = {}) {
  let text = "";
  try { text = src ?? configSrc(); }
  catch (e) {
    if (!quiet) console.warn(`config.js unreadable (${e.message}) — using canonical RPC`);
    return CANONICAL_RPC;
  }
  const lit = text.match(/\bRPC_URL\s*=\s*"(https?:\/\/[^"]+)"/);
  if (lit) return lit[1];
  const arr = text.match(/\bPUBLIC_RPCS\s*=\s*\[([\s\S]*?)\]/);
  if (arr) {
    const first = arr[1].match(/"(https?:\/\/[^"]+)"/);
    if (first) return first[1];
  }
  if (!quiet) console.warn("RPC_URL/PUBLIC_RPCS not parseable from config.js — using canonical RPC");
  return CANONICAL_RPC;
}

module.exports = { CONFIG_PATH, CANONICAL_RPC, configSrc, addrFromConfig, rpcFromConfig };
