// top-trader.js — per-round faucet reset for the round's top ETH trader.
//
// Design: dev-docs/BETA_ETH_ONLY.md §5. After each settled round, the Active
// ticket holder with the highest ETH-side swap volume in that round (at least
// MIN_RESET_VOLUME_ETH) gets GasFaucet.grantReset(round, wallet): their faucet
// cooldown lifts until their next claim.
//
// Tally: TimbSwapRouter SwapExecuted(sender, tokenIn, tokenOut, amountIn,
// amountOut, to) inside the round's block window (the block after the previous
// RoundSettled, up to this round's RoundSettled). `sender` is the router's
// msg.sender, i.e. the trader. Only ETH-legged swaps count: amountIn when
// tokenIn is WETH, amountOut when tokenOut is WETH. Ties go to whoever reached
// the total first. The events are public, so anyone can re-run this and check
// each ResetGranted.
//
// Idempotent: GasFaucet.resetUsed(round) is checked first, and the contract
// refuses a second grant for the same round anyway.
//
// Env:
//   ARB_SEPOLIA_RPC                 RPC for the grant transaction
//   TOP_TRADER_RPC                  optional RPC for getLogs (falls back to
//                                   POINTS_RPC, then config.js's public RPC;
//                                   keyed free tiers cap getLogs at 10 blocks)
//   FAUCET_DISPATCHER_PRIVATE_KEY   the faucet dispatcher (same as faucet-worker)
//   MIN_RESET_VOLUME_ETH            default 0.08
//   TOP_TRADER_BACKFILL             settled rounds to check per run (default 3)
//   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID   ops ping (optional)
// Args: --dry-run  tally and log, send nothing.
const { ethers } = require("ethers");
const { addrFromConfig, rpcFromConfig } = require("./lib/config");

const CHUNK_BLOCKS  = Number(process.env.TOP_TRADER_CHUNK_BLOCKS || 5000);
const MAX_LOOKBACK  = Number(process.env.TOP_TRADER_MAX_LOOKBACK || 400_000); // blocks searched for a RoundSettled
const BACKFILL      = Number(process.env.TOP_TRADER_BACKFILL || 3);
const MIN_VOLUME    = ethers.parseEther(process.env.MIN_RESET_VOLUME_ETH || "0.08");
const DRY_RUN       = process.argv.includes("--dry-run");

const PRIZE_ABI = [
  "function currentRound() view returns (uint256)",
  "event RoundSettled(uint256 indexed round, bytes6 winningString, uint256 potAmount, uint256 numWinners, uint256 remainderR, uint256 totalEntries, uint256 timestamp)",
];
const ROUTER_ABI = [
  "event SwapExecuted(address sender, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, address to)",
];
const REGISTRY_ABI = [
  "function activeTicketOf(address) view returns (uint256)",
  "function effectiveStatus(uint256) view returns (uint8)",
];
const FAUCET_ABI = [
  "function resetUsed(uint256) view returns (bool)",
  "function grantReset(uint256 round, address wallet)",
];
const STATUS_ACTIVE = 1; // GameRegistry.TicketStatus: Pending=0, Active=1

/**
 * Pure tally: ETH-side volume per trader, ranked. `swaps` are
 * { sender, tokenIn, tokenOut, amountIn, amountOut, blockNumber, index } in
 * chain order. Returns [{ wallet, volume, reachedAt }] sorted by volume desc,
 * then by who reached their total first.
 */
function rankTraders(swaps, weth) {
  const w = weth.toLowerCase();
  const byWallet = new Map();
  for (const s of swaps) {
    let eth = 0n;
    if (s.tokenIn.toLowerCase() === w) eth = BigInt(s.amountIn);
    else if (s.tokenOut.toLowerCase() === w) eth = BigInt(s.amountOut);
    if (eth === 0n) continue;
    const key = s.sender.toLowerCase();
    const cur = byWallet.get(key) || { wallet: s.sender, volume: 0n, reachedAt: [0, 0] };
    cur.volume += eth;
    cur.reachedAt = [s.blockNumber, s.index];
    byWallet.set(key, cur);
  }
  return [...byWallet.values()].sort((a, b) => {
    if (a.volume !== b.volume) return a.volume > b.volume ? -1 : 1;
    if (a.reachedAt[0] !== b.reachedAt[0]) return a.reachedAt[0] - b.reachedAt[0];
    return a.reachedAt[1] - b.reachedAt[1];
  });
}

async function tg(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
  } catch (_e) { /* best-effort */ }
}

async function chunkedLogs(contract, filter, from, to) {
  const out = [];
  for (let a = from; a <= to; a += CHUNK_BLOCKS) {
    out.push(...await contract.queryFilter(filter, a, Math.min(a + CHUNK_BLOCKS - 1, to)));
  }
  return out;
}

// Block of RoundSettled(round), searching backward from `before`. null if not
// found within MAX_LOOKBACK.
async function settledBlock(prize, round, before) {
  const filter = prize.filters.RoundSettled(round);
  const floor = Math.max(0, before - MAX_LOOKBACK);
  for (let hi = before; hi >= floor; hi -= CHUNK_BLOCKS) {
    const lo = Math.max(floor, hi - CHUNK_BLOCKS + 1);
    const logs = await prize.queryFilter(filter, lo, hi);
    if (logs.length) return logs[logs.length - 1].blockNumber;
  }
  return null;
}

async function main() {
  const addrs = {};
  for (const k of ["TimbPrize", "TimbSwapRouter", "GameRegistry", "GasFaucet", "WETH"]) {
    try { addrs[k] = addrFromConfig(k); }
    catch (e) { console.log(`[top-trader] ${e.message} — nothing to do until it is deployed.`); return; }
  }
  const readProv = new ethers.JsonRpcProvider(
    process.env.TOP_TRADER_RPC || process.env.POINTS_RPC || rpcFromConfig());
  const prize    = new ethers.Contract(addrs.TimbPrize, PRIZE_ABI, readProv);
  const router   = new ethers.Contract(addrs.TimbSwapRouter, ROUTER_ABI, readProv);
  const registry = new ethers.Contract(addrs.GameRegistry, REGISTRY_ABI, readProv);
  const faucetR  = new ethers.Contract(addrs.GasFaucet, FAUCET_ABI, readProv);

  const head = await readProv.getBlockNumber();
  const current = Number(await prize.currentRound());
  const newest = current - 1; // last settled round
  if (newest < 1) { console.log("[top-trader] no settled round yet."); return; }

  for (let round = Math.max(1, newest - BACKFILL + 1); round <= newest; round++) {
    if (await faucetR.resetUsed(round)) { console.log(`[top-trader] round ${round}: already granted.`); continue; }

    const end = await settledBlock(prize, round, head);
    if (end === null) { console.log(`[top-trader] round ${round}: RoundSettled not found in lookback, skipped.`); continue; }
    const prev = round > 1 ? await settledBlock(prize, round - 1, end - 1) : null;
    const start = prev === null ? Math.max(0, end - MAX_LOOKBACK) : prev + 1;

    const logs = await chunkedLogs(router, router.filters.SwapExecuted(), start, end);
    const ranked = rankTraders(logs.map(l => ({
      sender: l.args.sender, tokenIn: l.args.tokenIn, tokenOut: l.args.tokenOut,
      amountIn: l.args.amountIn, amountOut: l.args.amountOut,
      blockNumber: l.blockNumber, index: l.index,
    })), addrs.WETH);

    let winner = null;
    for (const c of ranked) {
      if (c.volume < MIN_VOLUME) break;
      const id = await registry.activeTicketOf(c.wallet);
      if (id !== 0n && Number(await registry.effectiveStatus(id)) === STATUS_ACTIVE) { winner = c; break; }
    }
    if (!winner) {
      console.log(`[top-trader] round ${round}: ${ranked.length} ETH trader(s), none eligible at ≥ ${ethers.formatEther(MIN_VOLUME)} ETH with an Active ticket.`);
      continue;
    }
    const vol = ethers.formatEther(winner.volume);
    if (DRY_RUN) { console.log(`[top-trader] DRY round ${round}: would reset ${winner.wallet} (${vol} ETH)`); continue; }

    const key = process.env.FAUCET_DISPATCHER_PRIVATE_KEY;
    if (!key || !process.env.ARB_SEPOLIA_RPC) throw new Error("Missing FAUCET_DISPATCHER_PRIVATE_KEY or ARB_SEPOLIA_RPC");
    const signer = new ethers.Wallet(key, new ethers.JsonRpcProvider(process.env.ARB_SEPOLIA_RPC));
    const tx = await new ethers.Contract(addrs.GasFaucet, FAUCET_ABI, signer).grantReset(round, winner.wallet);
    await tx.wait();
    console.log(`[top-trader] round ${round}: reset granted to ${winner.wallet} (${vol} ETH) · ${tx.hash}`);
    await tg(`🏁 Round ${round} top trader: ${winner.wallet} (${vol} ETH) — faucet cooldown reset.`);
  }
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error(`[top-trader] ${e.shortMessage || e.message}`);
    await tg(`⚠️ top-trader failed: ${e.shortMessage || e.message}`);
    process.exit(1);
  });
}

module.exports = { rankTraders };
