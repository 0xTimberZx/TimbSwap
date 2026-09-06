// epoch.js
// TimbSwap epoch distributor — the keeper for the 6-round reward waterfall
// (dev-docs/BOOSTED_FARMS_SPEC.md). Runs via GitHub Actions on a slow cron.
//
// Every 6 rounds (one EPOCH), one shared budget z = TIMBS collected into the
// Treasury this epoch is distributed in strict priority order:
//
//   B = z
//   farmGrant  = min(0.80 × y, B)        y = main-farm claims this epoch
//   B         -= farmGrant
//   stakeGrant = min(1.25 × w, 0.80 × B) w = staking claims this epoch
//   B         -= stakeGrant
//   boostBudget = B                       5%-per-claim boost draws until empty
//
// Farm cleaning out the budget starves staking AND boost. Staking cleaning
// out the remainder starves boost. Boost exhausting its remainder ends draws
// until the next cycle. Total epoch outflow can never exceed z.
//
// Between epoch settlements, every run batches the boost stream: 5% of the
// main-farm RewardsClaimed volume since the last run is drawn from the
// Treasury into TimbBoostFarm.notifyRewardAmount(), clamped to what remains
// of boostBudget. Batching at keeper cadence is economically equivalent to
// per-claim draws because boost emissions self-target over ~6 rounds anyway.
//
// IMPORTANT — key requirements:
//   EPOCH_PRIVATE_KEY must be the TimbTreasury OWNER: distributeToStaking()
//   and withdrawToken() are onlyOwner. This is a bigger key than the
//   settler's (which only calls permissionless functions) — scope the secret
//   accordingly.
//
// State: scripts/epoch-state.json, committed back by the workflow with
// [skip ci]. Stateless recovery is impossible here because a zero-grant
// epoch leaves no on-chain marker — the state file is the cursor. First run
// needs EPOCH_GENESIS_BLOCK to bound the first event scan.

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

// ─── Config ──────────────────────────────────────────────────────────────────

const TX_RPC_URL  = process.env.ARB_SEPOLIA_RPC; // tx submission (may be a metered provider)
const PRIVATE_KEY = process.env.EPOCH_PRIVATE_KEY;
const TG_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const DRY_RUN     = process.argv.includes("--dry-run");

const STATE_PATH  = path.join(__dirname, "epoch-state.json");
const ROUNDS_PER_EPOCH = 6;
const FARM_SHARE_BPS   = 8_000;  // 0.80 × y
const STAKE_BOOST_BPS  = 12_500; // 1.25 × w
const STAKE_CAP_BPS    = 8_000;  // ≤ 0.80 × leftover
const BOOST_DRAW_BPS   = 500;    // 5% of each farm claim
const LOG_CHUNK        = Number(process.env.EPOCH_LOG_CHUNK || 40_000); // getLogs block-range chunk

// Emission window sizing. The nominal window (ROUND_DURATION × ROUNDS_PER_EPOCH,
// 36h) assumes rounds tick at their on-chain nominal rate. On a quiet chain they
// run far slower, so a nominal window drains and the main pools go dark mid-epoch.
// Size the window to the LAST epoch's real wall-clock × slack, with a floor.
const EMIT_SLACK         = Number(process.env.EMIT_SLACK || "2");   // 2× the last epoch's measured length
const EMIT_FLOOR_SECONDS = Number(process.env.EMIT_FLOOR_DAYS || "4") * 86_400; // never below 4 days

// Post-blackout restart. The waterfall is claim-driven (farm 0.8×y, staking
// 1.25×w) — after an emission blackout y = w = 0, so the grants stay zero even
// with budget in hand: grants need claims, claims need emissions. Deadlock.
// When a silo's activity metric is zero but z > 0, bootstrap it with a fixed
// slice of z so the loop re-ignites; claim-driven sizing resumes next epoch.
const FARM_BOOTSTRAP_BPS  = BigInt(process.env.FARM_BOOTSTRAP_BPS  || "3000"); // 30% of z
const STAKE_BOOTSTRAP_BPS = BigInt(process.env.STAKE_BOOTSTRAP_BPS || "2000"); // 20% of z

// ── Buyback automation (section 0) ──────────────────────────────────────────
// Each run converts accrued protocol-fee ETH in the Treasury into TIMBS via
// executeBuyback, whose burn/reserve/waterfall split is what ultimately funds
// the epoch grants. All knobs have defaults — no new required secrets.
const BUYBACK_ENABLED  = (process.env.BUYBACK_ENABLED ?? "true") !== "false";
const BUYBACK_MIN_ETH  = ethers.parseEther(process.env.BUYBACK_MIN_ETH || "0.001"); // skip dust
// Buyback safety knobs are CHAIN-AWARE. On Arbitrum One (mainnet) a 100%-spend
// at 15% slippage is a standing sandwich-MEV tax on protocol funds, so mainnet
// defaults to a smaller fraction, tight slippage, and a per-run ETH cap
// (chunking). The thin-pool values are kept for Arbitrum Sepolia. Env vars still
// win on either chain; resolved per-run in the buyback block once chain is known.
const BUYBACK_SPEND_BPS_ENV = process.env.BUYBACK_SPEND_BPS    ? BigInt(process.env.BUYBACK_SPEND_BPS)    : null;
const BUYBACK_SLIP_BPS_ENV  = process.env.BUYBACK_SLIPPAGE_BPS ? BigInt(process.env.BUYBACK_SLIPPAGE_BPS) : null;
const BUYBACK_MAX_ETH_ENV   = process.env.BUYBACK_MAX_ETH      ? ethers.parseEther(process.env.BUYBACK_MAX_ETH) : null;
const ARB_ONE_CHAIN_ID = 42161n;

// Addresses from config.js — same single source of truth as the settler.
function addrFromConfig(key, { optional = false } = {}) {
  const src = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  const m = src.match(new RegExp("\\b" + key + '\\s*:\\s*"(0x[0-9a-fA-F]{40})"'));
  if (!m) {
    if (optional) return null;
    throw new Error(`Address "${key}" not found in config.js — refusing to start epoch keeper`);
  }
  return ethers.getAddress(m[1]);
}

// Canonical public RPC from config.js — used for ALL reads and event scans.
// Metered providers (QuickNode/Alchemy free tiers) cap eth_getLogs to tiny
// block ranges (observed live: 10 blocks), which makes epoch-wide scans
// impossible; the canonical endpoint serves large ranges — the explore page
// already scans it from browsers. The ARB_SEPOLIA_RPC secret is only used
// to SEND transactions (falls back to the canonical RPC if unset).
//
// Reading it out of config.js by regex is brittle by nature: this broke silently
// once already when the multi-RPC refactor turned `const RPC_URL = "https://…"`
// into `const RPC_URL = PUBLIC_RPCS[0]`. The pattern needed a quoted literal,
// matched nothing, and the keeper threw on startup — every scheduled run failed
// before doing any work. So try the literal first, then fall back to the first
// entry of the PUBLIC_RPCS array, then to a hardcoded canonical endpoint. The
// keeper must not be one refactor away from dead.
const CANONICAL_RPC = "https://sepolia-rollup.arbitrum.io/rpc";

function rpcFromConfig() {
  let src = "";
  try {
    src = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  } catch (e) {
    console.warn(`config.js unreadable (${e.message}) — using canonical RPC`);
    return CANONICAL_RPC;
  }

  // 1. A directly-assigned string literal (the pre-refactor shape).
  const lit = src.match(/\bRPC_URL\s*=\s*"(https?:\/\/[^"]+)"/);
  if (lit) return lit[1];

  // 2. The first entry of the PUBLIC_RPCS array, which is what RPC_URL now
  //    aliases. Deliberately PUBLIC and not DEDICATED_RPC: the keyed endpoint is
  //    the frontend's browser quota, and epoch scans are wide eth_getLogs ranges
  //    that would burn it. The canonical endpoint serves large ranges.
  const arr = src.match(/\bPUBLIC_RPCS\s*=\s*\[([\s\S]*?)\]/);
  if (arr) {
    const first = arr[1].match(/"(https?:\/\/[^"]+)"/);
    if (first) return first[1];
  }

  // 3. Nothing parsed. Warn loudly but RUN — a keeper that refuses to start is
  //    worse than one on a known-good default, because a stalled epoch silently
  //    stops emissions (and the re-grant incident showed how expensive a stuck
  //    keeper gets).
  console.warn("RPC_URL/PUBLIC_RPCS not parseable from config.js — using canonical RPC");
  return CANONICAL_RPC;
}

const TIMBPRIZE_ADDR   = addrFromConfig("TimbPrize");
const TIMBSTAKING_ADDR = addrFromConfig("TimbStaking");
const TIMBFARM_ADDR    = addrFromConfig("TimbFarm");
const TREASURY_ADDR    = addrFromConfig("TimbTreasury");
const TIMBS_ADDR       = addrFromConfig("TIMBSToken");
// Boost farm ships after this keeper — treat "not in config yet" as disabled.
const BOOSTFARM_ADDR   = addrFromConfig("TimbBoostFarm", { optional: true });

// ─── ABIs (minimal) ──────────────────────────────────────────────────────────

const PRIZE_ABI = [
  "function currentRound() external view returns (uint256)",
  "function ROUND_DURATION() external view returns (uint256)",
];
const CLAIM_EVENT_ABI = [
  "event RewardsClaimed(address indexed user, uint256 amount)",
];
const TREASURY_ABI = [
  "event BuybackExecuted(uint256 ethSpent, uint256 timbsBought, uint256 timbsBurned, uint256 timbsToWaterfall, uint256 timbsReserved)",
  "function distributeToStaking(uint256 timbsAmount, uint256 duration) external",
  "function withdrawToken(address token, address to, uint256 amount) external",
  "function executeBuyback(uint256 ethAmount, uint256 minTimbsOut) external",
  "function unwrapWeth(uint256 amount) external",
  "function ethBalance() view returns (uint256)",
  "function timbsEthPair() view returns (address)",
  "function weth() view returns (address)",
];
const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
];
const FARM_ABI = [
  "function notifyRewardAmount(uint256 amount, uint256 duration) external",
];
const BOOST_ABI = [
  "function notifyRewardAmount(uint256 amount) external",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address) external view returns (uint256)",
];

// ─── State ───────────────────────────────────────────────────────────────────

function loadState() {
  if (fs.existsSync(STATE_PATH)) {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  }
  const genesis = process.env.EPOCH_GENESIS_BLOCK;
  if (!genesis) {
    throw new Error(
      "No epoch-state.json and no EPOCH_GENESIS_BLOCK — cannot bound the first scan. " +
      "Set EPOCH_GENESIS_BLOCK to the block you want epoch #1 to start measuring from."
    );
  }
  return {
    lastEpochRound: 0,          // round at last settlement (0 = never settled)
    lastEpochBlock: Number(genesis),
    boostCursorBlock: Number(genesis),
    boostBudget: "0",           // wei strings — JSON-safe
    boostDrawn:  "0",
  };
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

// ─── Event scans (chunked getLogs) ───────────────────────────────────────────

async function sumEvents(provider, address, iface, eventName, fromBlock, toBlock, pick) {
  let total = 0n;
  const topic = iface.getEvent(eventName).topicHash;
  for (let from = fromBlock; from <= toBlock; from += LOG_CHUNK) {
    const to = Math.min(from + LOG_CHUNK - 1, toBlock);
    const logs = await provider.getLogs({ address, topics: [topic], fromBlock: from, toBlock: to });
    for (const log of logs) {
      total += pick(iface.parseLog(log).args);
    }
  }
  return total;
}

// ─── Telegram (ops-only, best-effort) ────────────────────────────────────────

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch (e) { console.error("telegram failed (non-fatal):", e.message); }
}

const fmt = (wei) => ethers.formatEther(wei);

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!PRIVATE_KEY && !DRY_RUN) throw new Error("EPOCH_PRIVATE_KEY not set (or use --dry-run)");

  // Reads + event scans: canonical public RPC (large getLogs ranges).
  // Transactions: the ARB_SEPOLIA_RPC secret if set, else the same endpoint.
  const provider = new ethers.JsonRpcProvider(rpcFromConfig());
  const txProv   = TX_RPC_URL ? new ethers.JsonRpcProvider(TX_RPC_URL) : provider;
  const wallet   = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, txProv) : null;

  const prize    = new ethers.Contract(TIMBPRIZE_ADDR, PRIZE_ABI, provider);
  const treasury = new ethers.Contract(TREASURY_ADDR, TREASURY_ABI, wallet ?? provider);
  const farm     = new ethers.Contract(TIMBFARM_ADDR, FARM_ABI, wallet ?? provider);
  const staking  = new ethers.Contract(TIMBSTAKING_ADDR, FARM_ABI, wallet ?? provider);
  const timbs    = new ethers.Contract(TIMBS_ADDR, ERC20_ABI, wallet ?? provider);
  const boost    = BOOSTFARM_ADDR ? new ethers.Contract(BOOSTFARM_ADDR, BOOST_ABI, wallet ?? provider) : null;

  const claimsIface   = new ethers.Interface(CLAIM_EVENT_ABI);
  const treasuryIface = new ethers.Interface(TREASURY_ABI);

  const state    = loadState();
  const nowBlock = await provider.getBlockNumber();
  const round    = Number(await prize.currentRound());
  const epochOf  = (r) => Math.floor((r - 1) / ROUNDS_PER_EPOCH); // rounds 1-6 = epoch 0

  console.log(`round=${round} epoch=${epochOf(round)} lastEpochRound=${state.lastEpochRound} block=${nowBlock}`);

  // ── 0. Buyback — convert accrued protocol-fee ETH into TIMBS every run ────
  // Fees land in the Treasury (native ETH, plus WETH from token-in swaps).
  // executeBuyback splits the purchase burn/reserve/waterfall; the waterfall
  // slice is what later funds the epoch grants. Running this each invocation
  // (not only at settlement) lets z accrue steadily across the epoch. The
  // buyback here mines after `nowBlock`, so it's counted at the NEXT epoch's
  // z-scan — never this run's — which avoids any double-count.
  if (BUYBACK_ENABLED) {
    // Chain-aware safety defaults (env overrides win). Mainnet: chunked spend,
    // tight slippage, per-run cap. Testnet (thin pools): the original values.
    const isMainnet = (await provider.getNetwork()).chainId === ARB_ONE_CHAIN_ID;
    const spendBps  = BUYBACK_SPEND_BPS_ENV ?? (isMainnet ? 2500n : 10000n); // 25% vs 100%
    const slipBps   = BUYBACK_SLIP_BPS_ENV  ?? (isMainnet ?  300n :  1500n); // 3%  vs 15%
    const maxEth    = BUYBACK_MAX_ETH_ENV   ?? (isMainnet ? ethers.parseEther("0.5") : 0n); // 0 = uncapped

    const pairAddr = await treasury.timbsEthPair();
    const wethAddr = await treasury.weth();

    // Unwrap any WETH-denominated fee revenue first — executeBuyback spends
    // native ETH, so WETH sitting in the Treasury is otherwise unreachable.
    if (wethAddr && wethAddr !== ethers.ZeroAddress) {
      const weth = new ethers.Contract(wethAddr, ERC20_ABI, wallet ?? provider);
      const wethBal = await weth.balanceOf(TREASURY_ADDR);
      if (wethBal > 0n) {
        console.log(`BUYBACK  unwrapping ${fmt(wethBal)} WETH → ETH`);
        if (!DRY_RUN) await (await treasury.unwrapWeth(wethBal)).wait();
      }
    }

    const ethBal      = await treasury.ethBalance();
    const spendableRaw = (ethBal * spendBps) / 10_000n;
    // Per-run cap (chunking): bounds a single swap so a sandwich bot can extract
    // at most ~slipBps of a capped notional, not of the whole treasury float.
    const spendable   = (maxEth > 0n && spendableRaw > maxEth) ? maxEth : spendableRaw;

    if (ethBal < BUYBACK_MIN_ETH || spendable === 0n) {
      console.log(`BUYBACK  skip — treasury ETH ${fmt(ethBal)} < min ${fmt(BUYBACK_MIN_ETH)}`);
    } else if (!pairAddr || pairAddr === ethers.ZeroAddress) {
      console.log("BUYBACK  skip — no TIMBS/ETH pair configured");
    } else {
      const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
      const [r0, r1] = await pair.getReserves();
      const t0 = await pair.token0();
      const timbsIsT0  = t0.toLowerCase() === TIMBS_ADDR.toLowerCase();
      const reserveIn  = timbsIsT0 ? BigInt(r1) : BigInt(r0); // ETH reserve
      const reserveOut = timbsIsT0 ? BigInt(r0) : BigInt(r1); // TIMBS reserve

      if (reserveIn === 0n || reserveOut === 0n) {
        console.log("BUYBACK  skip — pair has no liquidity");
      } else {
        // Same constant-product math the pair uses (0.3% pair fee), so minOut
        // is a true floor around the expected fill.
        const amountInWithFee = spendable * 997n;
        const expectedOut = (amountInWithFee * reserveOut) / (reserveIn * 1_000n + amountInWithFee);
        const minOut = (expectedOut * (10_000n - slipBps)) / 10_000n;

        console.log(`BUYBACK  spend=${fmt(spendable)} ETH expectedOut=${fmt(expectedOut)} minOut=${fmt(minOut)} TIMBS`);
        if (expectedOut === 0n) {
          console.log("BUYBACK  skip — expected out rounds to zero");
        } else if (!DRY_RUN) {
          await (await treasury.executeBuyback(spendable, minOut)).wait();
          console.log("  buyback executed ✓");
          await tg(`💸 Buyback ${fmt(spendable)} ETH → ~${fmt(expectedOut)} TIMBS (burn/reserve/waterfall split)`);
        }
      }
    }
  } else {
    console.log("BUYBACK  disabled (BUYBACK_ENABLED=false)");
  }

  // ── 1. Epoch settlement — beginning of each 6-round block ────────────────
  const due = state.lastEpochRound === 0
    ? round > ROUNDS_PER_EPOCH               // let the first full epoch elapse
    : epochOf(round) > epochOf(state.lastEpochRound);

  if (due) {
    const fromBlock = state.lastEpochBlock + 1;

    const y = await sumEvents(provider, TIMBFARM_ADDR, claimsIface, "RewardsClaimed",
      fromBlock, nowBlock, (a) => a.amount);
    const w = await sumEvents(provider, TIMBSTAKING_ADDR, claimsIface, "RewardsClaimed",
      fromBlock, nowBlock, (a) => a.amount);
    // z = the buyback "waterfall slice" retained in the Treasury this epoch —
    // the amount the Treasury explicitly earmarks for farm/staking/boost. The
    // contract emits it directly (received − burn − reserve); the reserve slice
    // stays in the balance but is deliberately NOT counted here so it stacks.
    const z = await sumEvents(provider, TREASURY_ADDR, treasuryIface, "BuybackExecuted",
      fromBlock, nowBlock, (a) => a.timbsToWaterfall);

    // Waterfall — farm → staking → boost, one shared budget, never exceeds z.
    let B = z;
    let farmWant = (y * BigInt(FARM_SHARE_BPS)) / 10_000n;
    if (farmWant === 0n && z > 0n) {
      farmWant = (z * FARM_BOOTSTRAP_BPS) / 10_000n;   // restart after a blackout
      console.log(`  farm bootstrap: no claims in window, seeding ${fmt(farmWant)} from z`);
    }
    const farmGrant = farmWant < B ? farmWant : B;
    B -= farmGrant;
    let stakeWant = (w * BigInt(STAKE_BOOST_BPS)) / 10_000n;
    if (stakeWant === 0n && z > 0n) {
      stakeWant = (z * STAKE_BOOTSTRAP_BPS) / 10_000n; // restart after a blackout
      console.log(`  stake bootstrap: no claims in window, seeding ${fmt(stakeWant)} from z`);
    }
    const stakeCap  = (B * BigInt(STAKE_CAP_BPS)) / 10_000n;
    const stakeGrant = stakeWant < stakeCap ? stakeWant : stakeCap;
    B -= stakeGrant;
    const boostBudget = B;

    // Window must OUTLAST the epoch's real wall-clock, not the nominal round time.
    // Base it on how long the previous epoch actually took (× slack), floored so a
    // first/one-off epoch can't dead-zone. Synthetix (notifyRewardAmount) rolls any
    // leftover into the next notify, so over-provisioning only smooths the rate.
    const nominalDuration = Number(await prize.ROUND_DURATION()) * ROUNDS_PER_EPOCH;
    const nowTime  = Math.floor(Date.now() / 1000);
    const lastTime = Number(state.lastEpochTime || 0);
    const observed = lastTime ? Math.max(0, nowTime - lastTime) : 0;
    const duration = Math.max(nominalDuration, EMIT_FLOOR_SECONDS, Math.ceil(observed * EMIT_SLACK));

    console.log(`EPOCH SETTLE  z=${fmt(z)} y=${fmt(y)} w=${fmt(w)}`);
    console.log(`  window: nominal=${nominalDuration}s observed=${observed}s -> duration=${duration}s (${(duration/86400).toFixed(1)}d)`);
    console.log(`  farmGrant=${fmt(farmGrant)} stakeGrant=${fmt(stakeGrant)} boostBudget=${fmt(boostBudget)} duration=${duration}s`);

    if (!DRY_RUN) {
      // Solvency: grants draw on the Treasury's whole TIMBS balance (z only
      // bounds the budget); fail loudly if the balance can't cover them.
      const treasuryBal = await timbs.balanceOf(TREASURY_ADDR);
      if (farmGrant + stakeGrant > treasuryBal) {
        throw new Error(`Treasury TIMBS balance ${fmt(treasuryBal)} < grants ${fmt(farmGrant + stakeGrant)}`);
      }
      if (farmGrant > 0n) {
        await (await treasury.withdrawToken(TIMBS_ADDR, wallet.address, farmGrant)).wait();
        await (await timbs.approve(TIMBFARM_ADDR, farmGrant)).wait();
        await (await farm.notifyRewardAmount(farmGrant, duration)).wait();
        console.log("  farm funded ✓");
      }
      if (stakeGrant > 0n) {
        // NOT treasury.distributeToStaking(): that transfers TIMBS to the
        // staking contract and THEN calls notifyRewardAmount, which itself does
        // safeTransferFrom(msg.sender) — a second pull the Treasury never
        // approved, so it always reverts ERC20InsufficientAllowance (and
        // approving instead would make the Treasury pay twice). Use the same
        // withdraw → approve → notify path the farm uses; the keeper wallet is
        // a registered rewardNotifier on TimbStaking.
        try {
          await (await treasury.withdrawToken(TIMBS_ADDR, wallet.address, stakeGrant)).wait();
          await (await timbs.approve(TIMBSTAKING_ADDR, stakeGrant)).wait();
          await (await staking.notifyRewardAmount(stakeGrant, duration)).wait();
          console.log("  staking funded ✓");
        } catch (e) {
          // Never let a staking failure discard an already-funded farm: without
          // this the run threw before saveState, so the next run re-settled the
          // same epoch and granted the farm all over again, every 2 hours.
          console.error("  staking funding FAILED (epoch still settles):", e.message);
          await tg(`⚠️ Staking grant failed this epoch: ${e.shortMessage || e.message}`);
        }
      }
    }

    state.lastEpochRound   = round;
    state.lastEpochBlock   = nowBlock;
    state.lastEpochTime    = nowTime;   // wall-clock, for the next epoch's adaptive window
    state.boostCursorBlock = nowBlock;
    state.boostBudget      = boostBudget.toString();
    state.boostDrawn       = "0";
    saveState(state);

    await tg(
      `⚙️ Epoch settled @ round ${round}\n` +
      `z=${fmt(z)} y=${fmt(y)} w=${fmt(w)}\n` +
      `farm=${fmt(farmGrant)} stake=${fmt(stakeGrant)} boostBudget=${fmt(boostBudget)}` +
      (DRY_RUN ? "\n(dry-run — no txs)" : "")
    );
  } else {
    console.log("epoch not due");
  }

  // ── 2. Boost stream — 5% of new main-farm claims, within boostBudget ─────
  if (boost) {
    const budget = BigInt(state.boostBudget) - BigInt(state.boostDrawn);
    if (budget > 0n && nowBlock > state.boostCursorBlock) {
      const claims = await sumEvents(provider, TIMBFARM_ADDR, claimsIface, "RewardsClaimed",
        state.boostCursorBlock + 1, nowBlock, (a) => a.amount);
      let draw = (claims * BigInt(BOOST_DRAW_BPS)) / 10_000n;
      if (draw > budget) draw = budget; // truncate at the cap, then stop until next cycle

      if (draw > 0n) {
        console.log(`BOOST DRAW  claims=${fmt(claims)} draw=${fmt(draw)} budgetLeft=${fmt(budget - draw)}`);
        if (!DRY_RUN) {
          await (await treasury.withdrawToken(TIMBS_ADDR, wallet.address, draw)).wait();
          await (await timbs.approve(BOOSTFARM_ADDR, draw)).wait();
          await (await boost.notifyRewardAmount(draw)).wait();
          console.log("  boost funded ✓");
        }
        state.boostDrawn = (BigInt(state.boostDrawn) + draw).toString();
        await tg(`🚀 Boost draw ${fmt(draw)} TIMBS (budget left ${fmt(budget - draw)})` + (DRY_RUN ? " (dry-run)" : ""));
      } else {
        console.log("no new farm claims — no boost draw");
      }
      state.boostCursorBlock = nowBlock;
      saveState(state);
    } else {
      console.log(budget <= 0n ? "boost budget exhausted — waiting for next epoch" : "no new blocks for boost scan");
    }
  } else {
    console.log("TimbBoostFarm not in config.js yet — boost stream disabled");
  }
}

main().catch(async (err) => {
  console.error("EPOCH KEEPER FAILED:", err);
  await tg(`🔴 Epoch keeper failed: ${err.message}`);
  process.exit(1);
});
