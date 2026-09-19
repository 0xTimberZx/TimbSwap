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
const path = require("path");
const { addrFromConfig, rpcFromConfig } = require("./lib/config");
const { sumEvents } = require("./lib/logs");
const { loadState, saveState } = require("./lib/state");
const { makeTelegram } = require("./lib/telegram");

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

// Emission period — FIXED, not sized from the last epoch's wall-clock.
// notifyRewardAmount(amount, duration) sets periodFinish = block.timestamp +
// duration UNCONDITIONALLY and re-spreads (amount + leftover) over it, so a
// constant duration means every successful grant re-anchors the window to
// exactly this many days from the grant. The pool can then only dead-zone if
// no grant lands for a whole period, instead of drifting with a computed
// window (the earlier adaptive sizing produced windows from 4 to 60 days and
// silently rewrote the pace on every settlement).
// See dev-docs/EMISSIONS_SCHEDULE.md §6.
const EMIT_PERIOD_DAYS    = Number(process.env.EMIT_PERIOD_DAYS || "90");
const EMIT_PERIOD_SECONDS = Math.round(EMIT_PERIOD_DAYS * 86_400);

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

// Addresses and the public RPC come from lib/config.js — the same single
// source of truth as the settler and every witness. The address reader fails
// loud on a missing key, a malformed address or the zero address. The RPC
// reader is the canonical PUBLIC endpoint, deliberately: metered providers cap
// eth_getLogs to tiny ranges (observed live: 10 blocks) and epoch scans are
// wide; it tolerates config.js's previous shape and falls back to a known
// default rather than refusing to start, because a stalled epoch silently
// stops emissions. The ARB_SEPOLIA_RPC secret is only used to SEND.
const TIMBPRIZE_ADDR   = addrFromConfig("TimbPrize");
const TIMBSTAKING_ADDR = addrFromConfig("TimbStaking");
const TIMBFARM_ADDR    = addrFromConfig("TimbFarm");
const TREASURY_ADDR    = addrFromConfig("TimbTreasury");
const TIMBS_ADDR       = addrFromConfig("TIMBSToken");
// Boost farm ships after this keeper — treat "not in config yet" (or the zero
// placeholder) as disabled rather than refusing to start.
let BOOSTFARM_ADDR = null;
try { BOOSTFARM_ADDR = addrFromConfig("TimbBoostFarm"); } catch (_e) { /* not wired */ }

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

// ─── State (lib/state.js) ────────────────────────────────────────────────────
// The file is the epoch cursor, so it is never keyed to a deployment and never
// discarded: a game redeploy is handled by the reset detection in main().
// The first run needs EPOCH_GENESIS_BLOCK to bound the first scan.

function freshState() {
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

// ─── Event scans: lib/logs.js sumEvents, chunked at LOG_CHUNK ────────────────
// (provider, iface, eventName, address, from, to, pick) — the provider's own
// message is surfaced when a chunk fails.
const sumChunked = (provider, address, iface, eventName, from, to, pick) =>
  sumEvents(provider, iface, eventName, address, from, to, pick, { chunk: LOG_CHUNK });

// ─── Telegram (ops-only, best-effort; lib/telegram.js) ───────────────────────
// Plain text, previews off, no ops-mode switch: the keeper's messages are
// grants and failures, and it never honoured the switch before either.
const telegram = makeTelegram({ token: TG_TOKEN, chatId: TG_CHAT_ID, tag: "epoch" });
const tg = (text) => telegram.send(text);

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

  const state    = loadState(STATE_PATH, freshState, { label: "epoch state" });
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
  // A game redeploy (new TimbPrize generation) restarts currentRound at 1, so
  // the cursor left by the previous generation sits far ahead of the live
  // round and `epochOf(round) > epochOf(cursor)` can never come true — the
  // keeper logs "epoch not due" for months while the farm and staking windows
  // run dry (gen-3 migration: cursor 199, live round 54, ~150 rounds away).
  // Treat round < cursor as a reset: settle now over the usual scan window
  // (lastEpochBlock → now) and rebase the cursor onto the new numbering.
  const reset = state.lastEpochRound > 0 && round < state.lastEpochRound;
  if (reset) {
    console.log(`game reset detected: round ${round} < cursor ${state.lastEpochRound} — settling now, cursor rebases to ${round}`);
  }
  const due = reset || (state.lastEpochRound === 0
    ? round > ROUNDS_PER_EPOCH               // let the first full epoch elapse
    : epochOf(round) > epochOf(state.lastEpochRound));

  if (due) {
    const fromBlock = state.lastEpochBlock + 1;

    const y = await sumChunked(provider, TIMBFARM_ADDR, claimsIface, "RewardsClaimed",
      fromBlock, nowBlock, (a) => a.amount);
    const w = await sumChunked(provider, TIMBSTAKING_ADDR, claimsIface, "RewardsClaimed",
      fromBlock, nowBlock, (a) => a.amount);
    // z = the buyback "waterfall slice" retained in the Treasury this epoch —
    // the amount the Treasury explicitly earmarks for farm/staking/boost. The
    // contract emits it directly (received − burn − reserve); the reserve slice
    // stays in the balance but is deliberately NOT counted here so it stacks.
    const z = await sumChunked(provider, TREASURY_ADDR, treasuryIface, "BuybackExecuted",
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

    // Fixed period: each grant re-anchors periodFinish to now + duration and
    // rolls the unspent leftover into the new rate. `observed` is logged for
    // ops only — it no longer sizes the window.
    const duration = EMIT_PERIOD_SECONDS;
    const nowTime  = Math.floor(Date.now() / 1000);
    const lastTime = Number(state.lastEpochTime || 0);
    const observed = lastTime ? Math.max(0, nowTime - lastTime) : 0;

    console.log(`EPOCH SETTLE  z=${fmt(z)} y=${fmt(y)} w=${fmt(w)}`);
    console.log(`  period: fixed ${EMIT_PERIOD_DAYS}d (${duration}s) — re-anchors on every grant; last epoch ran ${(observed/86400).toFixed(1)}d`);
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
    saveState(STATE_PATH, state);

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
      const claims = await sumChunked(provider, TIMBFARM_ADDR, claimsIface, "RewardsClaimed",
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
      saveState(STATE_PATH, state);
    } else {
      console.log(budget <= 0n ? "boost budget exhausted — waiting for next epoch" : "no new blocks for boost scan");
    }
  } else {
    console.log("TimbBoostFarm not in config.js yet — boost stream disabled");
  }
}

module.exports = { main };

// Only run when executed directly, so a dry run can be driven by a test.
if (require.main === module) main().catch(async (err) => {
  console.error("EPOCH KEEPER FAILED:", err);
  await tg(`🔴 Epoch keeper failed: ${err.message}`);
  process.exit(1);
});
