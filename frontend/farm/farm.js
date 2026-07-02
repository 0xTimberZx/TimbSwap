// farm.js — TimbStaking + TimbFarm logic (shared interface, different contract)

const STAKING_ABI = [
  "function stakedBalance(address account) external view returns (uint256)",
  "function totalStaked() external view returns (uint256)",
  "function earned(address account) external view returns (uint256)",
  "function estimatedAPR() external view returns (uint256 aprBps)",
  "function stake(uint256 amount) external",
  "function unstake(uint256 amount) external",
  "function claimRewards() external"
];
const FARM_ABI = [
  "function stakedBalance(address account) external view returns (uint256)",
  "function totalStaked() external view returns (uint256)",
  "function earned(address account) external view returns (uint256)",
  "function estimatedEmissionsAPR() external view returns (uint256 aprBps)",
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

function readProv() {
  return provider || new ethers.providers.JsonRpcProvider(RPC_URL);
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

  try {
    const [total, apr] = await Promise.all([
      contract.totalStaked(),
      contract[cfg.aprFn]().catch(() => ethers.BigNumber.from(0))
    ]);

    document.getElementById(pool + "-total").textContent = fmt(total, 18, 2);
    document.getElementById(pool + "-apr").textContent = (apr.toNumber() / 100).toFixed(1) + "% APR";

    if (userAddress) {
      const [mine, earned] = await Promise.all([
        contract.stakedBalance(userAddress),
        contract.earned(userAddress)
      ]);
      document.getElementById(pool + "-mine").textContent = fmt(mine, 18, 4);
      document.getElementById(pool + "-earned").textContent = fmtTIMBS(earned, 4);

      document.getElementById(pool + "-stake-btn").disabled = false;
      document.getElementById(pool + "-stake-btn").textContent = "Stake";
      document.getElementById(pool + "-unstake-btn").disabled = mine.eq(0);
      document.getElementById(pool + "-claim-btn").disabled = earned.eq(0);
    } else {
      document.getElementById(pool + "-mine").textContent = "—";
      document.getElementById(pool + "-earned").textContent = "—";
    }
  } catch (e) {
    console.warn(`loadPool(${pool}):`, e.message);
  }
}

async function loadAllPools() {
  await Promise.all([loadPool("staking"), loadPool("farm")]);
}

// ─── Max Button ───────────────────────────────────────────────────────────────

async function setMaxAmount(pool) {
  if (!userAddress) return;
  const cfg = poolConfig(pool);
  try {
    const tokenContract = new ethers.Contract(cfg.token, ERC20_ABI, provider);
    const bal = await tokenContract.balanceOf(userAddress);
    document.getElementById(pool + "-amount").value = ethers.utils.formatUnits(bal, 18);
  } catch (e) {
    console.warn("setMaxAmount:", e.message);
  }
}

// ─── Stake ────────────────────────────────────────────────────────────────────

async function handleStake(pool) {
  if (!userAddress) return;
  const amountStr = document.getElementById(pool + "-amount").value;
  if (!amountStr || parseFloat(amountStr) <= 0) return;

  const cfg = poolConfig(pool);
  const btn = document.getElementById(pool + "-stake-btn");

  try {
    const amountWei = ethers.utils.parseUnits(amountStr, 18);
    const tokenContract = new ethers.Contract(cfg.token, ERC20_ABI, signer);

    const allowance = await tokenContract.allowance(userAddress, cfg.address);
    if (allowance.lt(amountWei)) {
      btn.disabled = true;
      btn.textContent = "Approving…";
      DebugHub.logCheckpoint("Approve Requested", "pass");
      const gas = await getGasParams();
      const nonce = await getPendingNonce();
      const approveTx = await tokenContract.approve(cfg.address, ethers.constants.MaxUint256, { ...gas, nonce });
      DebugHub.logCheckpoint("Approve Submitted", "pass");
      await approveTx.wait();
      DebugHub.logCheckpoint("Approve Confirmed", "pass");
    }

    btn.textContent = "Staking…";
    DebugHub.logCheckpoint("Stake Requested", "pass");
    const poolContract = new ethers.Contract(cfg.address, cfg.abi, signer);
    const gas = await getGasParams();
    const nonce = await getPendingNonce();
    const tx = await poolContract.stake(amountWei, { ...gas, nonce });
    DebugHub.logCheckpoint("Stake Submitted", "pass");
    await tx.wait();
    DebugHub.logCheckpoint("Stake Confirmed", "pass");

    document.getElementById(pool + "-amount").value = "";
    btn.textContent = "Staked ✓";
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
    const poolContract = new ethers.Contract(cfg.address, cfg.abi, signer);
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
    await tx.wait();
    DebugHub.logCheckpoint("Unstake Confirmed", "pass");

    document.getElementById(pool + "-amount").value = "";
    btn.textContent = "Unstaked ✓";
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
    const poolContract = new ethers.Contract(cfg.address, cfg.abi, signer);
    const gas = await getGasParams();
    const nonce = await getPendingNonce();
    const tx = await poolContract.claimRewards({ ...gas, nonce });
    DebugHub.logCheckpoint("Claim Submitted", "pass");
    await tx.wait();
    DebugHub.logCheckpoint("Claim Confirmed", "pass");

    btn.textContent = "Claimed ✓";
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

  DebugHub.startSession();
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
  provider = null; signer = null; userAddress = null;
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
    DebugHub.startSession();
    DebugHub.logCheckpoint("Wallet Auto-Reconnected", "pass");
    listenForAccountChanges(async (newAddr) => {
      if (!newAddr) { handleDisconnect(); return; }
      const _el = document.getElementById("wallet-addr");
      if (_el) _el.textContent = fmtAddr(newAddr);
    });
  }

  await loadAllPools();
  setInterval(loadAllPools, 15000);
})();
