// seed-pools.js — seed blue-chip liquidity pools on the mainnet DEX.
//
// Plain pools, nothing else: no emissions, no farm seat, no game hook. The DEX
// (Phase 1, live since 2026-09-11) should have real markets before the prize
// game starts and long before the airdrop, so that the first thing a visitor
// can do on timbswap.xyz is trade. Pair creation is permissionless and the
// router creates a missing pair on the first add, so this is a wallet with
// tokens calling addLiquidity four times — with the guards that make that safe.
//
// THE RISK THIS SCRIPT EXISTS FOR: the first add to a new pool SETS its price.
// Seed WBTC/WETH at the wrong ratio and an arbitrage bot takes the difference
// in the next block, out of the LP's pocket. So every amount here is derived
// from a Chainlink price feed at run time, never typed by hand, and an EXISTING
// pool whose ratio has drifted more than SEED_MAX_DEVIATION_BPS from the feed is
// refused rather than joined (adding at a mispriced ratio loses value too).
//
// What it checks before spending anything:
//   • chain id is Arbitrum One (42161)
//   • every token address returns the symbol and decimals it is supposed to,
//     so a mistyped address fails loudly instead of seeding the wrong asset
//   • every feed returns the description it is supposed to ("BTC / USD"), has
//     8 decimals, a positive answer, and an update younger than SEED_FEED_MAX_AGE
//   • the wallet holds enough of every token for the whole plan, and prints the
//     shortfall per token if not
//
// Dry run by default: prints the plan and sends nothing. --execute sends.
//
// Env (env.mainnet.example has the block):
//   SEED_RPC                 Arbitrum One RPC (default https://arb1.arbitrum.io/rpc)
//   SEED_PRIVATE_KEY         the LP wallet key; --execute only; never pasted anywhere
//   SEED_ROUTER, SEED_FACTORY   MAINNET_ADDRESSES.md Phase 1 (defaults below)
//   TOKEN_WBTC, TOKEN_WETH, TOKEN_USDC, TOKEN_USDT, TOKEN_LINK   canonical tokens
//   FEED_BTC_USD, FEED_ETH_USD, FEED_USDC_USD, FEED_USDT_USD, FEED_LINK_USD   Chainlink
//   SEED_PAIRS               default "WBTC/WETH,WBTC/USDC,WETH/USDT,LINK/WETH"
//   SEED_USD_PER_SIDE        USD of EACH token per pool — REQUIRED, a per-run decision
//   SEED_LP_TO               LP token recipient (default: the sending wallet; use the Safe)
//   SEED_SLIPPAGE_BPS        min-amount tolerance on the add (default 100 = 1 %)
//   SEED_MAX_DEVIATION_BPS   refuse an existing pool further than this from the feed (default 50)
//   SEED_FEED_MAX_AGE        seconds a feed answer may be old (default 3600)
//   SEED_DEADLINE_SEC        tx deadline (default 600)
//
// Flags: --self-test (pure math, no network)  --execute (send)

const { ethers } = require("ethers");

const SELF_TEST = process.argv.includes("--self-test");
const EXECUTE   = process.argv.includes("--execute");

const BPS = 10_000n;

// Expected identity of each token and feed. A wrong address must fail here,
// not on-chain with the wrong asset in a pool.
const TOKENS = {
  WBTC: { env: "TOKEN_WBTC", symbol: "WBTC", decimals: 8,  feed: "BTC_USD" },
  WETH: { env: "TOKEN_WETH", symbol: "WETH", decimals: 18, feed: "ETH_USD" },
  USDC: { env: "TOKEN_USDC", symbol: "USDC", decimals: 6,  feed: "USDC_USD" },
  USDT: { env: "TOKEN_USDT", symbol: "USDT", decimals: 6,  feed: "USDT_USD" },
  LINK: { env: "TOKEN_LINK", symbol: "LINK", decimals: 18, feed: "LINK_USD" },
};
const FEEDS = {
  BTC_USD:  { env: "FEED_BTC_USD",  description: "BTC / USD" },
  ETH_USD:  { env: "FEED_ETH_USD",  description: "ETH / USD" },
  USDC_USD: { env: "FEED_USDC_USD", description: "USDC / USD" },
  USDT_USD: { env: "FEED_USDT_USD", description: "USDT / USD" },
  LINK_USD: { env: "FEED_LINK_USD", description: "LINK / USD" },
};

const DEFAULTS = {
  rpc:       "https://arb1.arbitrum.io/rpc",
  chainId:   42161,
  router:    "0x4f33df838c0d357c7f1a44ffb5ee0fc49a62b5fe",   // MAINNET_ADDRESSES.md Phase 1
  factory:   "0x60d4f18fe205c0ed38507a8fbf89aaa1bd2ce183",
  pairs:     "WBTC/WETH,WBTC/USDC,WETH/USDT,LINK/WETH",
  slippageBps: 100,
  maxDeviationBps: 50,
  feedMaxAge: 3600,
  deadlineSec: 600,
};

// ─── Pure math (exported for --self-test) ───────────────────────────────────

/** "A/B,C/D" → [["A","B"],["C","D"]]; validates symbols and rejects A/A. */
function parsePairs(str, known = Object.keys(TOKENS)) {
  return str.split(",").map((s) => s.trim()).filter(Boolean).map((p) => {
    const [a, b] = p.split("/").map((x) => x.trim().toUpperCase());
    if (!known.includes(a) || !known.includes(b)) throw new Error(`unknown token in pair "${p}"`);
    if (a === b) throw new Error(`pair "${p}" is the same token twice`);
    return [a, b];
  });
}

/** Token units worth `usd` at a feed price with 8 decimals: usd·1e8·10^dec / price. */
function amountForUsd(usd, price8, decimals) {
  const usdScaled = BigInt(Math.round(usd * 1e8)); // USD with 8 decimals
  return (usdScaled * 10n ** BigInt(decimals)) / price8;
}

/**
 * Price of A in B as a 1e18 fixed-point number, from raw reserves and decimals:
 * (reserveB / 10^decB) / (reserveA / 10^decA).
 */
function poolPrice1e18(reserveA, reserveB, decA, decB) {
  return (reserveB * 10n ** BigInt(decA) * 10n ** 18n) / (reserveA * 10n ** BigInt(decB));
}

/** Feed-implied price of A in B, 1e18 fixed point: priceA / priceB. */
function feedPrice1e18(priceA8, priceB8) {
  return (priceA8 * 10n ** 18n) / priceB8;
}

/** |a − b| / b in basis points. */
function deviationBps(a, b) {
  const d = a > b ? a - b : b - a;
  return Number((d * BPS) / b);
}

/**
 * Plan one add. For a NEW pool both sides are usdPerSide at feed prices, and
 * that ratio becomes the pool price. For an EXISTING pool the router will take
 * the pool's ratio whatever we ask, so B is quoted from A at pool reserves and
 * the pool must sit within maxDeviationBps of the feed or the add is refused.
 */
function planAdd({ usdPerSide, priceA8, priceB8, decA, decB, reserves, slippageBps, maxDeviationBps }) {
  const amountA = amountForUsd(usdPerSide, priceA8, decA);
  let amountB   = amountForUsd(usdPerSide, priceB8, decB);
  let mode = "new", deviation = 0;
  if (reserves && reserves.reserveA > 0n && reserves.reserveB > 0n) {
    mode = "existing";
    const pool = poolPrice1e18(reserves.reserveA, reserves.reserveB, decA, decB);
    const feed = feedPrice1e18(priceA8, priceB8);
    deviation = deviationBps(pool, feed);
    if (deviation > maxDeviationBps) {
      return { mode, deviation, refused: `pool price is ${deviation} bps from the feed (max ${maxDeviationBps})` };
    }
    amountB = (amountA * reserves.reserveB) / reserves.reserveA; // router quote()
  }
  const slip = BigInt(slippageBps);
  return {
    mode, deviation, refused: null,
    amountA, amountB,
    minA: (amountA * (BPS - slip)) / BPS,
    minB: (amountB * (BPS - slip)) / BPS,
  };
}

/** A feed round is usable when the answer is positive and fresh. */
function feedOk({ answer, updatedAt }, nowSec, maxAge) {
  if (answer <= 0n) return "answer is not positive";
  if (nowSec - Number(updatedAt) > maxAge) return `stale: updated ${nowSec - Number(updatedAt)} s ago (max ${maxAge})`;
  return null;
}

module.exports = { parsePairs, amountForUsd, poolPrice1e18, feedPrice1e18, deviationBps, planAdd, feedOk, TOKENS, FEEDS, main };

// ─── Self-test ──────────────────────────────────────────────────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (name, got, want) => {
    const g = typeof got === "bigint" ? got.toString() : JSON.stringify(got);
    const w = typeof want === "bigint" ? want.toString() : JSON.stringify(want);
    if (g === w) pass++; else { fail++; console.error(`FAIL ${name}: got ${g} want ${w}`); }
  };
  const throws = (name, fn) => { try { fn(); fail++; console.error(`FAIL ${name}: did not throw`); } catch { pass++; } };

  // Prices with 8 decimals: BTC 60,000, ETH 3,000, USDC 1, LINK 15.
  const BTC = 60_000n * 10n ** 8n, ETH = 3_000n * 10n ** 8n, USD1 = 1n * 10n ** 8n, LINK = 15n * 10n ** 8n;

  eq("pairs parse",            parsePairs("wbtc/weth, LINK/WETH"), [["WBTC", "WETH"], ["LINK", "WETH"]]);
  throws("unknown token rejected", () => parsePairs("WBTC/DOGE"));
  throws("same token rejected",    () => parsePairs("WETH/WETH"));

  eq("$600 of BTC is 0.01 BTC (8 dec)",   amountForUsd(600, BTC, 8),   1_000_000n);
  eq("$600 of ETH is 0.2 ETH (18 dec)",   amountForUsd(600, ETH, 18),  200_000_000_000_000_000n);
  eq("$600 of USDC is 600 USDC (6 dec)",  amountForUsd(600, USD1, 6),  600_000_000n);
  eq("$600 of LINK is 40 LINK",           amountForUsd(600, LINK, 18), 40n * 10n ** 18n);

  // A pool holding 1 BTC and 20 ETH prices BTC at 20 ETH.
  eq("pool price 1 BTC = 20 ETH", poolPrice1e18(10n ** 8n, 20n * 10n ** 18n, 8, 18), 20n * 10n ** 18n);
  eq("feed price 1 BTC = 20 ETH", feedPrice1e18(BTC, ETH), 20n * 10n ** 18n);
  eq("deviation 0 when equal",   deviationBps(20n * 10n ** 18n, 20n * 10n ** 18n), 0);
  eq("deviation 100 bps at 1 %", deviationBps(202n * 10n ** 17n, 20n * 10n ** 18n), 100);

  // New pool: both sides $500, ratio from feeds; 1 % mins.
  let p = planAdd({ usdPerSide: 500, priceA8: BTC, priceB8: ETH, decA: 8, decB: 18, reserves: null, slippageBps: 100, maxDeviationBps: 50 });
  eq("new pool mode",       p.mode, "new");
  eq("new pool A amount",   p.amountA, amountForUsd(500, BTC, 8));
  eq("new pool B amount",   p.amountB, amountForUsd(500, ETH, 18));
  eq("new pool minA is 99 %", p.minA, (p.amountA * 9_900n) / 10_000n);

  // Existing pool at exactly the feed ratio: B is quoted from reserves (same answer).
  const onFeed = { reserveA: 10n ** 8n, reserveB: 20n * 10n ** 18n };
  p = planAdd({ usdPerSide: 500, priceA8: BTC, priceB8: ETH, decA: 8, decB: 18, reserves: onFeed, slippageBps: 100, maxDeviationBps: 50 });
  eq("existing pool mode",      p.mode, "existing");
  eq("existing pool not refused", p.refused, null);
  eq("existing pool B quoted",  p.amountB, (p.amountA * onFeed.reserveB) / onFeed.reserveA);

  // Existing pool 1 % off the feed: refused at a 50 bps cap, accepted at 150.
  const off = { reserveA: 10n ** 8n, reserveB: 202n * 10n ** 17n };
  p = planAdd({ usdPerSide: 500, priceA8: BTC, priceB8: ETH, decA: 8, decB: 18, reserves: off, slippageBps: 100, maxDeviationBps: 50 });
  eq("mispriced pool refused", typeof p.refused, "string");
  eq("refusal reports bps",    p.deviation, 100);
  p = planAdd({ usdPerSide: 500, priceA8: BTC, priceB8: ETH, decA: 8, decB: 18, reserves: off, slippageBps: 100, maxDeviationBps: 150 });
  eq("wider cap accepts",      p.refused, null);

  // Empty reserves (pair created but never funded) count as a new pool.
  p = planAdd({ usdPerSide: 500, priceA8: BTC, priceB8: ETH, decA: 8, decB: 18, reserves: { reserveA: 0n, reserveB: 0n }, slippageBps: 100, maxDeviationBps: 50 });
  eq("empty reserves are new", p.mode, "new");

  // Feed checks.
  eq("fresh positive feed ok",  feedOk({ answer: BTC, updatedAt: 1_000n }, 1_500, 3600), null);
  eq("stale feed rejected",     typeof feedOk({ answer: BTC, updatedAt: 1_000n }, 5_000, 3600), "string");
  eq("zero answer rejected",    typeof feedOk({ answer: 0n, updatedAt: 1_000n }, 1_500, 3600), "string");

  console.log(`self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (SELF_TEST) selfTest();

// ─── Live ───────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
];
const FEED_ABI = [
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];
const FACTORY_ABI = ["function getPairAddress(address, address) view returns (address)"];
const PAIR_ABI = [
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function token0() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
];
const ROUTER_ABI = [
  "function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)",
  "function factory() view returns (address)",
];

const envAddr = (name, fallback) => {
  const v = process.env[name] || fallback;
  if (!v) throw new Error(`${name} is required`);
  return ethers.getAddress(v);
};
const fmtUnits = (x, dec, dp = 6) => Number(ethers.formatUnits(x, dec)).toFixed(dp);

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.SEED_RPC || DEFAULTS.rpc);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== DEFAULTS.chainId) throw new Error(`wrong chain: ${net.chainId} (expected Arbitrum One ${DEFAULTS.chainId})`);

  const wallet = process.env.SEED_PRIVATE_KEY ? new ethers.Wallet(process.env.SEED_PRIVATE_KEY, provider) : null;
  if (EXECUTE && !wallet) throw new Error("--execute needs SEED_PRIVATE_KEY");
  const from  = wallet ? wallet.address : (process.env.SEED_FROM ? ethers.getAddress(process.env.SEED_FROM) : null);
  const lpTo  = process.env.SEED_LP_TO ? ethers.getAddress(process.env.SEED_LP_TO) : from;

  const routerAddr  = envAddr("SEED_ROUTER", DEFAULTS.router);
  const factoryAddr = envAddr("SEED_FACTORY", DEFAULTS.factory);
  const router  = new ethers.Contract(routerAddr, ROUTER_ABI, wallet ?? provider);
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
  const routerFactory = await router.factory();
  if (routerFactory.toLowerCase() !== factoryAddr.toLowerCase()) throw new Error(`router.factory() is ${routerFactory}, not SEED_FACTORY ${factoryAddr}`);

  const usdPerSide      = Number(process.env.SEED_USD_PER_SIDE);
  if (!(usdPerSide > 0)) throw new Error("SEED_USD_PER_SIDE is required (USD of each token per pool) — it is a per-run decision, so there is no default");
  const slippageBps     = Number(process.env.SEED_SLIPPAGE_BPS || DEFAULTS.slippageBps);
  const maxDeviationBps = Number(process.env.SEED_MAX_DEVIATION_BPS || DEFAULTS.maxDeviationBps);
  const feedMaxAge      = Number(process.env.SEED_FEED_MAX_AGE || DEFAULTS.feedMaxAge);
  const deadlineSec     = Number(process.env.SEED_DEADLINE_SEC || DEFAULTS.deadlineSec);
  const pairs = parsePairs(process.env.SEED_PAIRS || DEFAULTS.pairs);
  const needed = [...new Set(pairs.flat())];

  console.log(`seed-pools on Arbitrum One  router ${routerAddr}  mode ${EXECUTE ? "EXECUTE" : "DRY RUN"}`);
  console.log(`  $${usdPerSide} per side · slippage ${slippageBps} bps · max pool/feed deviation ${maxDeviationBps} bps · LP to ${lpTo || "(unset)"}`);

  // 1. Tokens: identity checks.
  const nowSec = (await provider.getBlock("latest")).timestamp;
  const tok = {};
  for (const sym of needed) {
    const spec = TOKENS[sym];
    const addr = envAddr(spec.env);
    const c = new ethers.Contract(addr, ERC20_ABI, provider);
    const [onSym, onDec] = await Promise.all([c.symbol(), c.decimals()]);
    if (onSym !== spec.symbol || Number(onDec) !== spec.decimals) {
      throw new Error(`${spec.env}=${addr} is "${onSym}" with ${onDec} decimals, expected ${spec.symbol}/${spec.decimals} — wrong address`);
    }
    tok[sym] = { addr, contract: c, decimals: spec.decimals, feedKey: spec.feed };
  }

  // 2. Feeds: identity + freshness.
  const price8 = {};
  for (const sym of needed) {
    const fk = tok[sym].feedKey;
    if (price8[fk] !== undefined) continue;
    const spec = FEEDS[fk];
    const addr = envAddr(spec.env);
    const f = new ethers.Contract(addr, FEED_ABI, provider);
    const [desc, dec, round] = await Promise.all([f.description(), f.decimals(), f.latestRoundData()]);
    if (desc !== spec.description) throw new Error(`${spec.env}=${addr} describes itself as "${desc}", expected "${spec.description}" — wrong feed`);
    if (Number(dec) !== 8) throw new Error(`${spec.env} has ${dec} decimals, expected 8`);
    const bad = feedOk({ answer: BigInt(round.answer), updatedAt: round.updatedAt }, nowSec, feedMaxAge);
    if (bad) throw new Error(`${spec.env}: ${bad}`);
    price8[fk] = BigInt(round.answer);
    console.log(`  feed ${spec.description.padEnd(10)} ${fmtUnits(price8[fk], 8, 2)}`);
  }

  // 3. Plan every pair.
  const plans = [];
  for (const [a, b] of pairs) {
    const A = tok[a], B = tok[b];
    const pairAddr = await factory.getPairAddress(A.addr, B.addr);
    let reserves = null;
    if (pairAddr !== ethers.ZeroAddress) {
      const pc = new ethers.Contract(pairAddr, PAIR_ABI, provider);
      const [r0, r1] = await pc.getReserves();
      const t0 = await pc.token0();
      const aIs0 = t0.toLowerCase() === A.addr.toLowerCase();
      reserves = { reserveA: BigInt(aIs0 ? r0 : r1), reserveB: BigInt(aIs0 ? r1 : r0) };
    }
    const plan = planAdd({
      usdPerSide, priceA8: price8[A.feedKey], priceB8: price8[B.feedKey],
      decA: A.decimals, decB: B.decimals, reserves, slippageBps, maxDeviationBps,
    });
    plans.push({ a, b, A, B, pairAddr, ...plan });
  }

  console.log("\nplan:");
  const need = {};
  for (const p of plans) {
    const tag = p.pairAddr === ethers.ZeroAddress ? "create + seed" : p.mode === "new" ? "seed (empty pair)" : `join (pool ${p.deviation} bps from feed)`;
    if (p.refused) { console.log(`  ✗ ${p.a}/${p.b}  REFUSED — ${p.refused}`); continue; }
    console.log(`  • ${p.a}/${p.b}  ${tag}`);
    console.log(`      ${fmtUnits(p.amountA, p.A.decimals)} ${p.a}  +  ${fmtUnits(p.amountB, p.B.decimals)} ${p.b}   (mins ${fmtUnits(p.minA, p.A.decimals)} / ${fmtUnits(p.minB, p.B.decimals)})`);
    need[p.a] = (need[p.a] || 0n) + p.amountA;
    need[p.b] = (need[p.b] || 0n) + p.amountB;
  }

  // 4. Balances for the whole plan.
  if (from) {
    let short = false;
    console.log(`\nwallet ${from}:`);
    for (const sym of Object.keys(need)) {
      const bal = BigInt(await tok[sym].contract.balanceOf(from));
      const ok = bal >= need[sym];
      if (!ok) short = true;
      console.log(`  ${ok ? "✓" : "✗"} ${sym.padEnd(5)} need ${fmtUnits(need[sym], tok[sym].decimals)}  have ${fmtUnits(bal, tok[sym].decimals)}${ok ? "" : `  SHORT ${fmtUnits(need[sym] - bal, tok[sym].decimals)}`}`);
    }
    if (short && EXECUTE) throw new Error("wallet is short on at least one token — nothing sent");
  } else {
    console.log("\n(no SEED_PRIVATE_KEY / SEED_FROM — balances not checked)");
  }

  const refused = plans.filter((p) => p.refused);
  if (refused.length && EXECUTE) throw new Error(`${refused.length} pool(s) refused — fix or drop them from SEED_PAIRS before --execute`);

  if (!EXECUTE) { console.log("\nDRY RUN — nothing sent. Re-run with --execute to seed."); return; }

  // 5. Execute, one pool at a time, exact approvals.
  for (const p of plans) {
    console.log(`\n${p.a}/${p.b}:`);
    for (const [sym, T, amt] of [[p.a, p.A, p.amountA], [p.b, p.B, p.amountB]]) {
      const c = T.contract.connect(wallet);
      const allowance = BigInt(await c.allowance(from, routerAddr));
      if (allowance < amt) {
        const tx = await c.approve(routerAddr, amt);
        console.log(`  approve ${sym} ${fmtUnits(amt, T.decimals)}  ${tx.hash}`);
        await tx.wait();
      }
    }
    const deadline = Math.floor(Date.now() / 1000) + deadlineSec;
    const tx = await router.addLiquidity(p.A.addr, p.B.addr, p.amountA, p.amountB, p.minA, p.minB, lpTo, deadline);
    console.log(`  addLiquidity  ${tx.hash}`);
    const rc = await tx.wait();
    const pairAddr = await factory.getPairAddress(p.A.addr, p.B.addr);
    const lp = BigInt(await new ethers.Contract(pairAddr, PAIR_ABI, provider).balanceOf(lpTo));
    console.log(`  ✓ pair ${pairAddr}  block ${rc.blockNumber}  LP held by ${lpTo}: ${fmtUnits(lp, 18)}`);
  }
  console.log("\nall pools seeded");
}

if (!SELF_TEST && require.main === module) main().catch((e) => { console.error("SEED-POOLS FAILED:", e.shortMessage || e.message || e); process.exit(1); });
