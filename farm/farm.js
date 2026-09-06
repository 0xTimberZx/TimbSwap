// farm.js — TimbStaking + TimbFarm logic (shared interface, different contract)

const STAKING_ABI = [
  "function stakedBalance(address account) external view returns (uint256)",
  "function totalStaked() external view returns (uint256)",
  "function earned(address account) external view returns (uint256)",
  "function estimatedAPR() external view returns (uint256 aprBps)",
  "function periodFinish() external view returns (uint256)",
  "function rewardRatePerSecond() external view returns (uint256)",
  "function stake(uint256 amount) external",
  "function unstake(uint256 amount) external",
  "function claimRewards() external"
];
const FARM_ABI = [
  "function stakedBalance(address account) external view returns (uint256)",
  "function totalStaked() external view returns (uint256)",
  "function earned(address account) external view returns (uint256)",
  "function estimatedEmissionsAPR() external view returns (uint256 aprBps)",
  "function periodFinish() external view returns (uint256)",
  "function rewardRatePerSecond() external view returns (uint256)",
  "function lpToken() external view returns (address)",
  "function stake(uint256 amount) external",
  "function unstake(uint256 amount) external",
  "function claimRewards() external"
];
const ERC20_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)"
];

// Read-only queries go through the shared read provider (config.js): the
// connected wallet's own RPC once it is verified on the right chain — that
// endpoint isn't the shared public one, so polling can't trip a per-IP rate
// limit, which is what keeps pages responsive in Brave — otherwise the
// resilient public FallbackProvider. The _walletChainOk gate prevents a
// wrong-network wallet from serving stale/zero reads.
function readProv() {
  return sharedReadProvider();
}

// The public Arb Sepolia RPC is load-balanced across nodes that lag each other,
// so a state read fired immediately after confirmTx can hit a node still a block
// behind and return pre-tx values (e.g. a "stale" staked balance after an
// unstake). Wait for our read provider to reach the tx's block before refreshing.
async function waitForReadBlock(minBlock, { tries = 24, intervalMs = 500 } = {}) {
  if (!minBlock) return;
  const prov = readProv();
  for (let i = 0; i < tries; i++) {
    try { if ((await prov.getBlockNumber()) >= minBlock) return; } catch { /* transient RPC read */ }
    await new Promise(res => setTimeout(res, intervalMs));
  }
}

// APR is emission-rate ÷ total-staked, so with a tiny testnet stake it prints
// absurd figures (52,911% / 1,310,329%). Cap the DISPLAY so it reads sanely —
// the on-chain number is unchanged; this is presentation only.
const APR_DISPLAY_CAP_PCT = 10000; // show ">10,000%" above this
function formatApr(aprBps) {
  // A near-zero-TVL pool makes aprBps astronomically large — bigger than a JS
  // Number can hold — so aprBps.toNumber() would THROW and blank the whole
  // card. Test the display cap on the BigNumber first, before converting.
  const capBps = ethers.BigNumber.from(APR_DISPLAY_CAP_PCT * 100); // 10,000% = 1,000,000 bps
  if (aprBps.gte(capBps)) {
    return ">" + APR_DISPLAY_CAP_PCT.toLocaleString("en-US") + "% APR";
  }
  const pct = aprBps.toNumber() / 100;
  return pct.toLocaleString("en-US", { maximumFractionDigits: 1 }) + "% APR";
}

// Farm amount formatting: keep columns narrow but readable. A triple-digit
// (or larger) whole part shows 2 decimals; anything smaller shows up to 4, so
// small stakes keep their precision and big ones don't sprawl. e.g.
// 1000.0000 → 1000.00, 246.6133 → 246.61, 10.1613 → 10.1613, 4.10 → 4.1000.
function fmtStake(wei, decimals = 18) {
  if (!wei) return "0.0";
  const n = parseFloat(ethers.utils.formatUnits(wei, decimals));
  if (n === 0) return "0.0"; // truly zero reads clean, not 0.0000
  return n.toFixed(Math.abs(n) >= 100 ? 2 : 4);
}

// Fixed-precision amount formatter (wei → grouped string) for the boost banner,
// where a specific decimal count is wanted regardless of magnitude — e.g.
// fmt(reserve, 18, 2) → "1,234.56", fmt(rate*86400, 18, 0) → "5,000". Missing
// before, so any funded boost reserve threw a ReferenceError and blanked the
// whole boosted section.
function fmt(wei, decimals = 18, maxDecimals = 2) {
  if (!wei) return "0";
  const n = parseFloat(ethers.utils.formatUnits(wei, decimals));
  return n.toLocaleString("en-US", { maximumFractionDigits: maxDecimals });
}

// pool = "staking" | "farm"
function poolConfig(pool) {
  return pool === "staking"
    ? { address: ADDRESSES.TimbStaking, abi: STAKING_ABI, token: ADDRESSES.TIMBSToken, aprFn: "estimatedAPR" }
    : { address: ADDRESSES.TimbFarm,    abi: FARM_ABI,    token: ADDRESSES.TimbsEthPair, aprFn: "estimatedEmissionsAPR" };
}

// ─── Load Pool Data ───────────────────────────────────────────────────────────

async function loadPool(pool) {
  const cfg = poolConfig(pool);
  const contract = new ethers.Contract(cfg.address, cfg.abi, readProv());
  const hasUser = !!userAddress;

  try {
    // Fire global + per-wallet reads in ONE tick so the batch provider collapses
    // them into a single JSON-RPC POST. A connected load used to fire two separate
    // batches (global, then per-wallet); merging them keeps the request count under
    // Brave's third-party volume throttle on the RPC proxy. Per-wallet reads are
    // caught individually so one flaky call can't blank the whole card.
    const Z = ethers.BigNumber.from(0);
    const wallet = hasUser ? new ethers.Contract(cfg.token, ERC20_ABI, readProv()) : null;
    const reads = [
      contract.totalStaked(),
      contract[cfg.aprFn]().catch(() => Z),
    ];
    if (hasUser) reads.push(
      contract.stakedBalance(userAddress).catch(() => Z),
      contract.earned(userAddress).catch(() => Z),
      wallet.balanceOf(userAddress).catch(() => Z)
    );
    const res = await Promise.all(reads);
    const total = res[0], apr = res[1];

    document.getElementById(pool + "-total").textContent = fmtStake(total);
    document.getElementById(pool + "-apr").textContent = formatApr(apr);

    // Emissions status — a Synthetix-style period, so rewards stop the moment
    // block.timestamp >= periodFinish even though APR keeps printing the last
    // stored rate. Surface it so a stalled emission (e.g. keeper stopped funding)
    // is visible on-page, not just in a console.
    refreshEmit(pool, contract).catch(() => {});

    if (hasUser) {
      const mine = res[2], earned = res[3], inWallet = res[4];
      document.getElementById(pool + "-mine").textContent = fmtStake(mine);
      document.getElementById(pool + "-earned").textContent = fmtStake(earned) + " TIMBS";
      document.getElementById(pool + "-wallet").textContent =
        "Balance: " + fmtStake(inWallet) + (pool === "staking" ? " TIMBS" : " LP");

      // Nothing to stake with? Turn the (otherwise dead) green Stake button
      // into a live "Buy TIMBS" / "Get LP" that routes to Swap, instead of an
      // active-looking button that does nothing.
      const stakeBtn = document.getElementById(pool + "-stake-btn");
      stakeBtn.disabled = false;
      if (inWallet.isZero()) {
        stakeBtn.dataset.action  = "get";
        stakeBtn.textContent     = pool === "staking" ? "Buy TIMBS" : "Get LP";
      } else {
        stakeBtn.dataset.action  = "";
        stakeBtn.textContent     = "Stake";
      }
      document.getElementById(pool + "-unstake-btn").disabled = mine.eq(0);
      document.getElementById(pool + "-claim-btn").disabled = earned.eq(0);
    } else {
      document.getElementById(pool + "-mine").textContent = "—";
      document.getElementById(pool + "-earned").textContent = "—";
      document.getElementById(pool + "-wallet").textContent = "Balance: —";
    }
  } catch (e) {
    console.warn(`loadPool(${pool}):`, e.message);
  }
}

// Compact duration: 3661 -> "1h 1m", 90061 -> "1d 1h 1m".
function fmtDur(s) {
  s = Math.max(0, Math.floor(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return (d ? d + "d " : "") + (d || h ? h + "h " : "") + m + "m";
}

// Populate a classic pool's "Emissions:" line from its Synthetix-style period.
async function refreshEmit(pool, contract) {
  const el = document.getElementById(pool + "-emit");
  if (!el) return;
  const val = el.querySelector(".emit-val");
  el.classList.remove("is-live", "is-ended");
  let pf, rate;
  try {
    [pf, rate] = await Promise.all([contract.periodFinish(), contract.rewardRatePerSecond()]);
  } catch {
    if (val) val.textContent = "—";
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const end = pf.toNumber();
  const perDay = fmtStake(rate.mul(86400));
  // The APR badge is estimatedAPR() off the LAST STORED rate — it keeps printing
  // a big number after the period ends, contradicting the "ended" line. When the
  // pool isn't actually emitting, mark the badge Paused instead of a stale APR.
  const aprEl = document.getElementById(pool + "-apr");
  if (end > now) {
    el.classList.add("is-live");
    if (val) val.textContent = `live · ${perDay}/day · ${fmtStake(rate.mul(end - now))} TIMBS left (ends in ${fmtDur(end - now)})`;
    if (aprEl) aprEl.classList.remove("apr-paused");
  } else {
    el.classList.add("is-ended");
    if (val) val.textContent = end === 0 ? "not started" : `⚠ ended ${fmtDur(now - end)} ago — needs refunding`;
    if (aprEl) { aprEl.textContent = "Paused"; aprEl.classList.add("apr-paused"); }
  }
}

// Coalesce overlapping refreshes. The 15s interval, the visibilitychange
// handler, connect/disconnect, and init can all fire loadAllPools() while an
// earlier one is still resolving — overlapping reads raced and could leave the
// UI reflecting a stale pass. If a load is already in flight, return it instead
// of starting a second.
let _loadInFlight = null;
async function loadAllPools() {
  if (_loadInFlight) return _loadInFlight;
  _loadInFlight = (async () => {
    try {
      await Promise.all([loadPool("staking"), loadPool("farm"), loadBoost()]);
    } finally {
      _loadInFlight = null;
    }
  })();
  return _loadInFlight;
}

// ─── Boosted Farms (TimbBoostFarm — multi-pool, epoch-funded) ─────────────────
// Extra-pair farms (USDT/LINK/DAPP…) competing by weight for one shared TIMBS
// pool, funded by the epoch keeper's boost tier (5% of main-farm claims).
// Not whitelisted, not nudge-eligible — deliberately outside the game loop.

const BOOST_ABI = [
  "function poolCount() external view returns (uint256)",
  "function poolInfo(uint256) external view returns (address lpToken, uint256 weight, uint256 lastRewardTime, uint256 accRewardPerShare, uint256 totalStaked, bool paused)",
  "function totalWeight() external view returns (uint256)",
  "function rewardRatePerSecond() external view returns (uint256)",
  "function periodFinish() external view returns (uint256)",
  "function rewardReserve() external view returns (uint256)",
  "function totalOwed() external view returns (uint256)",
  "function pendingReward(uint256 pid, address account) external view returns (uint256)",
  "function userInfo(uint256, address) external view returns (uint256 amount, uint256 rewardDebt, uint256 pending)",
  "function estimatedPoolAPR(uint256 pid) external view returns (uint256 aprBps)",
  "function deposit(uint256 pid, uint256 amount) external",
  "function withdraw(uint256 pid, uint256 amount) external",
  "function claimRewards(uint256 pid) external"
];
const PAIR_META_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)"
];
const SYMBOL_ABI = ["function symbol() external view returns (string)"];

function boostAddr() {
  const a = ADDRESSES.TimbBoostFarm;
  return (a && !/^0x0{40}$/.test(a.replace("0x", ""))) ? a : null;
}

// lp address -> "BASE/QUOTE" using the shared base/quote convention in
// config.js (pairLabelFor: stables > native > others as the quote), so a pair
// reads identically here, on explore, and on analytics. Resolved once, cached.
const _pairNames = {};
async function pairName(lp) {
  if (_pairNames[lp]) return _pairNames[lp];
  try {
    const pair = new ethers.Contract(lp, PAIR_META_ABI, readProv());
    const [t0, t1] = await Promise.all([pair.token0(), pair.token1()]);
    const [s0, s1] = await Promise.all([
      new ethers.Contract(t0, SYMBOL_ABI, readProv()).symbol().catch(() => "?"),
      new ethers.Contract(t1, SYMBOL_ABI, readProv()).symbol().catch(() => "?")
    ]);
    // Only cache a CLEAN resolve. A transient RPC hiccup used to get cached
    // for the whole session, leaving cards stuck as "?/? LP" / "0x1234…abcd LP".
    // Return the fallback uncached so the next refresh retries and self-heals.
    if (s0 === "?" || s1 === "?") return s0 + "/" + s1;
    _pairNames[lp] = pairLabelFor(t0, s0, t1, s1);
  } catch {
    return lp.slice(0, 6) + "…" + lp.slice(-4);
  }
  return _pairNames[lp];
}

async function loadBoost() {
  const addr = boostAddr();
  const section = document.getElementById("boost-section");
  if (!addr || !section) { if (section) section.style.display = "none"; return; }
  section.style.display = "";

  const boost = new ethers.Contract(addr, BOOST_ABI, readProv());
  const statusEl = document.getElementById("boost-status");
  const poolsEl  = document.getElementById("boost-pools");

  try {
    const [count, reserve, owed, rate, periodFinish] = await Promise.all([
      boost.poolCount(), boost.rewardReserve(), boost.totalOwed(),
      boost.rewardRatePerSecond(), boost.periodFinish()
    ]);

    // The contract clamps accrual at periodFinish (lastTimeRewardApplicable),
    // but rewardRatePerSecond() keeps returning the last stored rate after the
    // window lapses — so rate>0 alone doesn't mean anything is still emitting.
    // Gate the "emitting" banner on the window actually being open.
    const nowSec = Math.floor(Date.now() / 1000);
    const windowOpen = periodFinish.gt(nowSec);

    // Emission state banner. rate 0 with a funded reserve = the contract's
    // 99% solvency stop: accrual halted, everything accrued stays claimable,
    // LP deposit/withdraw unaffected. Not an error state.
    if (statusEl) {
      if (reserve.isZero()) {
        statusEl.textContent = "Awaiting epoch funding — pools open, emissions start with the first boost draw.";
        statusEl.className = "boost-status";
      } else if (rate.isZero()) {
        statusEl.textContent = "Emissions paused — solvency stop (owed ≥ 99% of reserve). All accrued TIMBS stays claimable; deposits and withdrawals keep working.";
        statusEl.className = "boost-status boost-status-stop";
      } else if (!windowOpen) {
        statusEl.textContent = "Emission window ended — " + fmt(reserve, 18, 2) +
          " TIMBS reserve idle, awaiting the next epoch boost draw to retarget. Accrued TIMBS stays claimable.";
        statusEl.className = "boost-status boost-status-stop";
      } else {
        statusEl.textContent = "Reserve: " + fmt(reserve, 18, 2) + " TIMBS · emitting " +
          fmt(rate.mul(86400), 18, 0) + " TIMBS/day across pools";
        statusEl.className = "boost-status boost-status-live";
      }
    }

    const n = count.toNumber();
    if (n === 0) {
      poolsEl.innerHTML = '<div class="boost-empty">No boosted pools yet — pairs are added as promotions go live.</div>';
      return;
    }

    // (Re)build rows only when the pool set changes; refresh numbers in place.
    if (poolsEl.childElementCount !== n || poolsEl.dataset.built !== String(n)) {
      let html = "";
      for (let pid = 0; pid < n; pid++) html += boostPoolShell(pid);
      poolsEl.innerHTML = html;
      poolsEl.dataset.built = String(n);
    }

    const totalWeight = await boost.totalWeight();
    await Promise.all(Array.from({ length: n }, (_, pid) => refreshBoostPool(boost, pid, totalWeight, windowOpen)));
  } catch (e) {
    console.warn("loadBoost:", e.message);
  }
}

function boostPoolShell(pid) {
  return `
    <div class="pool-card pool-card-boost" id="boost-${pid}-card">
      <div class="pool-card-head">
        <div class="pool-icon">⇈</div>
        <div>
          <div class="pool-name" id="boost-${pid}-name">Pool #${pid}</div>
          <div class="pool-type">Boosted LP · epoch-funded <span class="boost-paused-badge" id="boost-${pid}-paused" style="display:none">PAUSED</span></div>
        </div>
        <div class="pool-apr" id="boost-${pid}-apr">— APR</div>
      </div>
      <div class="pool-stats">
        <div class="pool-stat"><span class="pool-stat-label">Weight</span><span class="pool-stat-val pool-stat-fixed" id="boost-${pid}-weight" title="Protocol-set — fixed by pool weight">—</span></div>
        <div class="pool-stat"><span class="pool-stat-label">Total Staked</span><span class="pool-stat-val" id="boost-${pid}-total">—</span></div>
        <div class="pool-stat"><span class="pool-stat-label">Your Stake</span><span class="pool-stat-val" id="boost-${pid}-mine">—</span></div>
        <div class="pool-stat pool-stat-span"><span class="pool-stat-label">Pending</span><span class="pool-stat-val pool-stat-green" id="boost-${pid}-earned">—</span></div>
      </div>
      <div class="pool-input-row">
        <input id="boost-${pid}-amount" class="pool-input" type="number" placeholder="0.0 LP" />
        <button class="pool-max-btn" onclick="setBoostAmount(${pid}, 100)">MAX</button>
        <button class="pool-max-btn" onclick="setBoostAmount(${pid}, 50)">50%</button>
      </div>
      <div class="pool-bal" id="boost-${pid}-wallet" onclick="setBoostAmount(${pid}, 100)" title="Use full balance">Balance: —</div>
      <div class="pool-actions">
        <button class="btn-pool btn-pool-primary" id="boost-${pid}-stake-btn" onclick="handleBoostStake(${pid})" disabled>Connect wallet</button>
        <button class="btn-pool btn-pool-secondary" id="boost-${pid}-unstake-btn" onclick="handleBoostUnstake(${pid})" disabled>Withdraw</button>
      </div>
      <button class="btn-pool btn-pool-claim" id="boost-${pid}-claim-btn" onclick="handleBoostClaim(${pid})" disabled>Claim Rewards</button>
    </div>`;
}

async function refreshBoostPool(boost, pid, totalWeight, windowOpen = true) {
  try {
    const info = await boost.poolInfo(pid);
    const [name, apr] = await Promise.all([
      pairName(info.lpToken),
      boost.estimatedPoolAPR(pid).catch(() => ethers.BigNumber.from(0))
    ]);

    document.getElementById(`boost-${pid}-name`).textContent  = name + " LP";
    // When the emission window is closed, boost emissions are 0 — so the APR
    // shown is the pool's trading-fee return (≈0.0% on a quiet testnet pair),
    // NOT the phantom emission rate. The "idle" marker moves to the Weight
    // slot (emission share is meaningless while nothing's emitting).
    // estimatedPoolAPR divides by TVL, so an EMPTY pool prints the phantom
    // ">10,000%" cap. Show "New" only when totalStaked is exactly zero —
    // LP units are tiny by nature (0.0034 LP can be a real, earning stake),
    // so any nonzero stake shows its true (capped) APR.
    document.getElementById(`boost-${pid}-apr`).textContent   = info.paused
      ? "paused"
      : (!windowOpen ? "0.0% APR" : (info.totalStaked.isZero() ? "New" : formatApr(apr)));
    document.getElementById(`boost-${pid}-total`).textContent = fmtStake(info.totalStaked);
    document.getElementById(`boost-${pid}-weight`).textContent = info.paused
      ? "—"
      : (!windowOpen ? "idle"
        : (totalWeight.isZero() ? "—" : (info.weight.mul(1000).div(totalWeight).toNumber() / 10).toFixed(1) + "%"));
    document.getElementById(`boost-${pid}-paused`).style.display = info.paused ? "" : "none";

    // A paused pool stops EARNING, never exit — withdraw stays open.
    const stakeBtn = document.getElementById(`boost-${pid}-stake-btn`);

    if (userAddress) {
      const lp = new ethers.Contract(info.lpToken, ERC20_ABI, readProv());
      const [pos, pending, inWallet] = await Promise.all([
        boost.userInfo(pid, userAddress),
        boost.pendingReward(pid, userAddress),
        lp.balanceOf(userAddress)
      ]);
      document.getElementById(`boost-${pid}-mine`).textContent   = fmtStake(pos.amount);
      document.getElementById(`boost-${pid}-earned`).textContent = fmtStake(pending) + " TIMBS";
      document.getElementById(`boost-${pid}-wallet`).textContent = "Balance: " + fmtStake(inWallet) + " LP";
      // No LP in wallet → live "Get LP" routing to Swap (unless the pool is
      // paused, which takes precedence and disables staking entirely).
      if (info.paused) {
        stakeBtn.disabled = true;  stakeBtn.dataset.action = "";      stakeBtn.textContent = "Pool paused";
      } else if (inWallet.isZero()) {
        stakeBtn.disabled = false; stakeBtn.dataset.action = "get";   stakeBtn.textContent = "Get LP";
      } else {
        stakeBtn.disabled = false; stakeBtn.dataset.action = "";      stakeBtn.textContent = "Stake";
      }
      document.getElementById(`boost-${pid}-unstake-btn`).disabled = pos.amount.eq(0);
      document.getElementById(`boost-${pid}-claim-btn`).disabled   = pending.eq(0);
    } else {
      document.getElementById(`boost-${pid}-mine`).textContent   = "—";
      document.getElementById(`boost-${pid}-earned`).textContent = "—";
      document.getElementById(`boost-${pid}-wallet`).textContent = "Balance: —";
    }
  } catch (e) {
    console.warn(`refreshBoostPool(${pid}):`, e.message);
  }
}

async function setBoostAmount(pid, pct) {
  if (!userAddress) return;
  try {
    const boost = new ethers.Contract(boostAddr(), BOOST_ABI, readProv());
    const info  = await boost.poolInfo(pid);
    const lp    = new ethers.Contract(info.lpToken, ERC20_ABI, readProv());
    const bal   = await lp.balanceOf(userAddress);
    document.getElementById(`boost-${pid}-amount`).value = ethers.utils.formatUnits(bal.mul(pct).div(100), 18);
  } catch (e) {
    console.warn("setBoostAmount:", e.message);
  }
}

async function handleBoostStake(pid) {
  if (!userAddress) return;
  const btn = document.getElementById(`boost-${pid}-stake-btn`);
  // Zero-LP state: the button reads "Get LP" → open Swap's Add-liquidity tab.
  if (btn && btn.dataset.action === "get") { window.location.href = "../swap/#liquidity"; return; }
  const amountStr = document.getElementById(`boost-${pid}-amount`).value;
  if (!amountStr || parseFloat(amountStr) <= 0) return;
  try {
    const amountWei = ethers.utils.parseUnits(amountStr, 18);
    const boostRead = new ethers.Contract(boostAddr(), BOOST_ABI, readProv());
    const info      = await boostRead.poolInfo(pid);

    const lpRead    = new ethers.Contract(info.lpToken, ERC20_ABI, readProv());
    const allowance = await lpRead.allowance(userAddress, boostAddr());
    if (allowance.lt(amountWei)) {
      btn.disabled = true;
      btn.textContent = "Approving…";
      DebugHub.logCheckpoint("Boost:Approve Requested", "pass");
      const lpWrite = await writeContract(info.lpToken, ERC20_ABI);
      const gas = await getGasParams(); const nonce = await getPendingNonce();
      await confirmTx(await lpWrite.approve(boostAddr(), ethers.constants.MaxUint256, { ...gas, nonce }));
      DebugHub.logCheckpoint("Boost:Approve Confirmed", "pass");
    }

    btn.disabled = true;
    btn.textContent = "Staking…";
    DebugHub.logCheckpoint("Boost:Stake Requested", "pass");
    const boost = await writeContract(boostAddr(), BOOST_ABI);
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    const rcpt = await confirmTx(await boost.deposit(pid, amountWei, { ...gas, nonce }));
    DebugHub.logCheckpoint("Boost:Stake Confirmed", "pass");

    document.getElementById(`boost-${pid}-amount`).value = "";
    btn.textContent = "Staked ✓";
    await waitForReadBlock(rcpt.blockNumber);
    await loadBoost();
    setTimeout(() => { btn.textContent = "Stake"; btn.disabled = false; }, 1800);
  } catch (err) {
    console.error("Boost stake failed:", err.message);
    DebugHub.logError("handleBoostStake", err);
    DebugHub.logCheckpoint("Boost:Stake Failed", "fail");
    btn.textContent = "Failed — try again";
    setTimeout(() => { btn.textContent = "Stake"; btn.disabled = false; }, 2000);
  }
}

async function handleBoostUnstake(pid) {
  if (!userAddress) return;
  const btn = document.getElementById(`boost-${pid}-unstake-btn`);
  try {
    const boost = await writeContract(boostAddr(), BOOST_ABI);
    const amountStr = document.getElementById(`boost-${pid}-amount`).value;
    let amountWei;
    if (amountStr && parseFloat(amountStr) > 0) {
      amountWei = ethers.utils.parseUnits(amountStr, 18);
    } else {
      const pos = await boost.userInfo(pid, userAddress);
      amountWei = pos.amount;
      if (amountWei.eq(0)) return;
    }
    btn.disabled = true;
    btn.textContent = "Withdrawing…";
    DebugHub.logCheckpoint("Boost:Unstake Requested", "pass");
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    const rcpt = await confirmTx(await boost.withdraw(pid, amountWei, { ...gas, nonce }));
    DebugHub.logCheckpoint("Boost:Unstake Confirmed", "pass");

    document.getElementById(`boost-${pid}-amount`).value = "";
    btn.textContent = "Withdrawn ✓";
    await waitForReadBlock(rcpt.blockNumber);
    await loadBoost();
    setTimeout(() => { btn.textContent = "Withdraw"; btn.disabled = false; }, 1800);
  } catch (err) {
    console.error("Boost unstake failed:", err.message);
    DebugHub.logError("handleBoostUnstake", err);
    DebugHub.logCheckpoint("Boost:Unstake Failed", "fail");
    btn.textContent = "Failed — try again";
    setTimeout(() => { btn.textContent = "Withdraw"; btn.disabled = false; }, 2000);
  }
}

async function handleBoostClaim(pid) {
  if (!userAddress) return;
  const btn = document.getElementById(`boost-${pid}-claim-btn`);
  try {
    btn.disabled = true;
    btn.textContent = "Claiming…";
    DebugHub.logCheckpoint("Boost:Claim Requested", "pass");
    const boost = await writeContract(boostAddr(), BOOST_ABI);
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    const rcpt = await confirmTx(await boost.claimRewards(pid, { ...gas, nonce }));
    DebugHub.logCheckpoint("Boost:Claim Confirmed", "pass");

    btn.textContent = "Claimed ✓";
    await waitForReadBlock(rcpt.blockNumber);
    await loadBoost();
    setTimeout(() => { btn.textContent = "Claim Rewards"; }, 1800);
  } catch (err) {
    console.error("Boost claim failed:", err.message);
    DebugHub.logError("handleBoostClaim", err);
    DebugHub.logCheckpoint("Boost:Claim Failed", "fail");
    btn.textContent = "Failed — try again";
    setTimeout(() => { btn.textContent = "Claim Rewards"; btn.disabled = false; }, 2000);
  }
}

// ─── Max Button ───────────────────────────────────────────────────────────────

async function setAmount(pool, pct) {
  if (!userAddress) return;
  const cfg = poolConfig(pool);
  try {
    const tokenContract = new ethers.Contract(cfg.token, ERC20_ABI, readProv());
    const bal = await tokenContract.balanceOf(userAddress);
    const amount = bal.mul(pct).div(100);
    document.getElementById(pool + "-amount").value = ethers.utils.formatUnits(amount, 18);
  } catch (e) {
    console.warn("setAmount:", e.message);
  }
}

// Legacy alias
async function setMaxAmount(pool) { return setAmount(pool, 100); }

// ─── Stake ────────────────────────────────────────────────────────────────────

async function handleStake(pool) {
  // When gated (autoReconnect didn't establish a signer), the primary button
  // reads "Connect wallet" — so route a tap to an explicit connect, then stop.
  if (!userAddress) { await handleConnect(); return; }
  // Zero-balance state: the button reads "Buy TIMBS" / "Get LP" → go to Swap.
  const sBtn = document.getElementById(pool + "-stake-btn");
  if (sBtn && sBtn.dataset.action === "get") { window.location.href = "../swap/"; return; }
  const amountStr = document.getElementById(pool + "-amount").value;
  if (!amountStr || parseFloat(amountStr) <= 0) return;

  const cfg = poolConfig(pool);
  const btn = document.getElementById(pool + "-stake-btn");

  try {
    const amountWei = ethers.utils.parseUnits(amountStr, 18);
    const tokenContract = await writeContract(cfg.token, ERC20_ABI);

    // Read the allowance from the canonical public RPC, never the wallet's
    // in-app provider — mobile wallets sometimes answer eth_call from a node
    // that's mid-sync and returns "header not found" (-32000), which would
    // otherwise abort the whole stake before we even sign anything.
    const tokenRead = new ethers.Contract(cfg.token, ERC20_ABI, readProv());
    const allowance = await tokenRead.allowance(userAddress, cfg.address);
    if (allowance.lt(amountWei)) {
      btn.disabled = true;
      btn.textContent = "Approving…";
      DebugHub.logCheckpoint("Approve Requested", "pass");
      const gas = await getGasParams();
      const nonce = await getPendingNonce();
      const approveTx = await tokenContract.approve(cfg.address, ethers.constants.MaxUint256, { ...gas, nonce });
      DebugHub.logCheckpoint("Approve Submitted", "pass");
      await confirmTx(approveTx);
      DebugHub.logCheckpoint("Approve Confirmed", "pass");
    }

    btn.textContent = "Staking…";
    DebugHub.logCheckpoint("Stake Requested", "pass");
    const poolContract = await writeContract(cfg.address, cfg.abi);
    const gas = await getGasParams();
    const nonce = await getPendingNonce();
    const tx = await poolContract.stake(amountWei, { ...gas, nonce });
    DebugHub.logCheckpoint("Stake Submitted", "pass");
    const rcpt = await confirmTx(tx);
    DebugHub.logCheckpoint("Stake Confirmed", "pass");

    document.getElementById(pool + "-amount").value = "";
    btn.textContent = "Staked ✓";
    await waitForReadBlock(rcpt.blockNumber);
    await loadPool(pool);
    setTimeout(() => { btn.textContent = "Stake"; btn.disabled = false; }, 1800);

  } catch (err) {
    console.error("Stake failed:", err.message);
    DebugHub.logError("handleStake", err);
    DebugHub.logCheckpoint("Stake Failed", "fail");
    btn.textContent = "Failed — try again";
    setTimeout(() => { btn.textContent = "Stake"; btn.disabled = false; }, 2000);
  }
}

// ─── Unstake ──────────────────────────────────────────────────────────────────

async function handleUnstake(pool) {
  if (!userAddress) return;
  const cfg = poolConfig(pool);
  const btn = document.getElementById(pool + "-unstake-btn");

  try {
    const poolContract = await writeContract(cfg.address, cfg.abi);
    const amountStr = document.getElementById(pool + "-amount").value;

    let amountWei;
    if (amountStr && parseFloat(amountStr) > 0) {
      amountWei = ethers.utils.parseUnits(amountStr, 18);
    } else {
      // No amount entered — unstake full balance
      amountWei = await poolContract.stakedBalance(userAddress);
      if (amountWei.eq(0)) return;
    }

    btn.disabled = true;
    btn.textContent = "Unstaking…";
    DebugHub.logCheckpoint("Unstake Requested", "pass");
    const gas = await getGasParams();
    const nonce = await getPendingNonce();
    const tx = await poolContract.unstake(amountWei, { ...gas, nonce });
    DebugHub.logCheckpoint("Unstake Submitted", "pass");
    const rcpt = await confirmTx(tx);
    DebugHub.logCheckpoint("Unstake Confirmed", "pass");

    document.getElementById(pool + "-amount").value = "";
    btn.textContent = "Unstaked ✓";
    await waitForReadBlock(rcpt.blockNumber);
    await loadPool(pool);
    setTimeout(() => { btn.textContent = "Unstake"; btn.disabled = false; }, 1800);

  } catch (err) {
    console.error("Unstake failed:", err.message);
    DebugHub.logError("handleUnstake", err);
    DebugHub.logCheckpoint("Unstake Failed", "fail");
    btn.textContent = "Failed — try again";
    setTimeout(() => { btn.textContent = "Unstake"; btn.disabled = false; }, 2000);
  }
}

// ─── Claim ────────────────────────────────────────────────────────────────────

async function handleClaim(pool) {
  if (!userAddress) return;
  const cfg = poolConfig(pool);
  const btn = document.getElementById(pool + "-claim-btn");

  try {
    btn.disabled = true;
    btn.textContent = "Claiming…";
    DebugHub.logCheckpoint("Claim Requested", "pass");
    const poolContract = await writeContract(cfg.address, cfg.abi);
    const gas = await getGasParams();
    const nonce = await getPendingNonce();
    const tx = await poolContract.claimRewards({ ...gas, nonce });
    DebugHub.logCheckpoint("Claim Submitted", "pass");
    const rcpt = await confirmTx(tx);
    DebugHub.logCheckpoint("Claim Confirmed", "pass");

    btn.textContent = "Claimed ✓";
    await waitForReadBlock(rcpt.blockNumber);
    await loadPool(pool);
    setTimeout(() => { btn.textContent = "Claim Rewards"; }, 1800);

  } catch (err) {
    console.error("Claim failed:", err.message);
    DebugHub.logError("handleClaim", err);
    DebugHub.logCheckpoint("Claim Failed", "fail");
    btn.textContent = "Failed — try again";
    setTimeout(() => { btn.textContent = "Claim Rewards"; btn.disabled = false; }, 2000);
  }
}

// ─── Wallet Connect ───────────────────────────────────────────────────────────

async function handleConnect() {
  DebugHub.logCheckpoint("Wallet Connect Requested", "pass");
  const ok = await connectWallet();
  if (!ok) { DebugHub.logCheckpoint("Wallet Connect Failed", "fail"); return; }

  DebugHub.startSession(userAddress);
  DebugHub.logSecurity("Chain Check", "pass");
  DebugHub.logCheckpoint("Wallet Connected", "pass");

  document.getElementById("connect-btn").classList.add("hidden");
  document.getElementById("wallet-info").classList.remove("hidden");
  document.getElementById("network-badge").classList.remove("hidden");
  document.getElementById("wallet-addr").textContent = fmtAddr(userAddress);

  await loadAllPools();

  listenForAccountChanges(async (newAddr) => {
    if (!newAddr) { handleDisconnect(); return; }
    document.getElementById("wallet-addr").textContent = fmtAddr(newAddr);
    await loadAllPools();
  });
}

function handleDisconnect() {
  DebugHub.endSession();
  disconnectWallet();
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
  ["staking", "farm"].forEach(p => {
    document.getElementById(p + "-stake-btn").textContent = "Connect wallet";
    document.getElementById(p + "-stake-btn").disabled = true;
    document.getElementById(p + "-unstake-btn").disabled = true;
    document.getElementById(p + "-claim-btn").disabled = true;
  });
  loadAllPools();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  // Auto-reconnect if wallet was connected before navigation
    DebugHub.logCheckpoint("Farm:Page Loaded", "pass");
  const _reconnected = await autoReconnect();
  if (_reconnected) {
    document.getElementById("connect-btn")?.classList.add("hidden");
    document.getElementById("wallet-info")?.classList.remove("hidden");
    document.getElementById("network-badge")?.classList.remove("hidden");
    const _addrEl = document.getElementById("wallet-addr");
    if (_addrEl) _addrEl.textContent = fmtAddr(_reconnected);
    DebugHub.startSession(_reconnected);
    DebugHub.logCheckpoint("Wallet Auto-Reconnected", "pass");
    // Optimistically flip the stake buttons to the connected state so they never
    // read "Connect wallet" while pool data loads (or if a read momentarily
    // fails); loadAllPools then refines enabled/disabled from balances.
    ["staking", "farm"].forEach(p => {
      const b = document.getElementById(p + "-stake-btn");
      if (b) { b.textContent = "Stake"; b.disabled = false; }
    });
    listenForAccountChanges(async (newAddr) => {
      if (!newAddr) { handleDisconnect(); return; }
      const _el = document.getElementById("wallet-addr");
      if (_el) _el.textContent = fmtAddr(newAddr);
      await loadAllPools();
    });
  } else {
    // autoReconnect failed (Brave frequently returns no account / times out on a
    // reload) while config.js's optimistic chrome may have already painted the
    // nav "connected" from the saved session. Revert the nav to the real Connect
    // button so the page is honest, and make the pool CTA a live one-tap
    // reconnect — otherwise the nav shows connected, its Connect button stays
    // hidden, and the pool buttons are stuck on a dead, disabled "Connect wallet".
    clearWalletChrome();
    ["staking", "farm"].forEach(p => {
      const b = document.getElementById(p + "-stake-btn");
      if (b) { b.textContent = "Connect wallet"; b.disabled = false; }
    });
  }

  await loadAllPools();
  // Only refresh pool stats while the tab is visible; catch up on return.
  setInterval(() => { if (!document.hidden) loadAllPools(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadAllPools(); });
})();
