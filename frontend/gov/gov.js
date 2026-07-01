// gov.js — TimbGovernance: voting power, proposals, vote, resolve

const GOV_ABI = [
  "function proposalCount() external view returns (uint256)",
  "function totalVotingPower() external view returns (uint256)",
  "function quorumBps() external view returns (uint256)",
  "function proposalThreshold() external view returns (uint256)",
  "function votingPowerDeposited(address voter) external view returns (uint256)",
  "function getVotingPower(address voter) external view returns (uint256)",
  "function hasVoted(address voter, uint256 proposalId) external view returns (bool)",
  "function quorumReached(uint256 proposalId) external view returns (bool)",
  "function getProposal(uint256 proposalId) external view returns (tuple(uint256 id, string title, string description, address proposer, uint256 createdAt, uint256 votingStartsAt, uint256 votingEndsAt, uint256 executionDeadline, uint256 forVotes, uint256 againstVotes, uint256 totalVotingPower, uint8 status, bool executed) p, uint8 liveStatus)",
  "function depositVotingPower(uint256 amount) external",
  "function withdrawVotingPower(uint256 amount) external",
  "function castVote(uint256 proposalId, bool support) external",
  "function resolveProposal(uint256 proposalId) external"
];

const TIMBS_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)"
];

// Status enum — must match Solidity: Pending=0 Active=1 Passed=2 Failed=3 Executed=4 Expired=5
const STATUS_LABELS = ["Pending", "Active", "Passed", "Failed", "Executed", "Expired"];
const STATUS_CLASSES = ["status-pending", "status-active", "status-passed", "status-failed", "status-executed", "status-expired"];

// ─── State ────────────────────────────────────────────────────────────────────

let myVotingPower  = ethers.BigNumber.from(0);
let totalPower     = ethers.BigNumber.from(0);
let proposalCount  = 0;

function readProv() {
  return provider || new ethers.providers.JsonRpcProvider(RPC_URL);
}

// ─── Stats Bar ────────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const gov = new ethers.Contract(ADDRESSES.TimbGovernance, GOV_ABI, readProv());
    const [count, total, qBps, threshold] = await Promise.all([
      gov.proposalCount(),
      gov.totalVotingPower(),
      gov.quorumBps(),
      gov.proposalThreshold()
    ]);

    proposalCount = count.toNumber();
    totalPower    = total;

    document.getElementById("g-proposals").textContent   = count.toString();
    document.getElementById("g-total-power").textContent = fmtTIMBS(total, 0);
    document.getElementById("g-quorum").textContent      = (qBps.toNumber() / 100).toFixed(1) + "%";

    if (userAddress) {
      const mine = await gov.votingPowerDeposited(userAddress);
      myVotingPower = mine;
      document.getElementById("g-my-power").textContent  = fmtTIMBS(mine, 0);
      document.getElementById("vp-amount").textContent   = fmtTIMBS(mine, 2);
      document.getElementById("vp-deposit-btn").disabled = false;
      document.getElementById("vp-deposit-btn").textContent = "Deposit";
      document.getElementById("vp-withdraw-btn").disabled   = mine.eq(0);
    } else {
      document.getElementById("g-my-power").textContent = "—";
    }
  } catch (e) {
    console.warn("loadStats:", e.message);
    DebugHub.logError("gov.loadStats", e);
  }
}

// ─── Voting Power ─────────────────────────────────────────────────────────────

async function setVPMax() {
  if (!userAddress) return;
  try {
    const timbs = new ethers.Contract(ADDRESSES.TIMBSToken, TIMBS_ABI, provider);
    const bal   = await timbs.balanceOf(userAddress);
    document.getElementById("vp-input").value = ethers.utils.formatUnits(bal, 18);
  } catch (e) { console.warn("setVPMax:", e.message); }
}

async function handleDeposit() {
  if (!userAddress) return;
  const amtStr = document.getElementById("vp-input").value;
  if (!amtStr || parseFloat(amtStr) <= 0) return;

  const btn = document.getElementById("vp-deposit-btn");
  const amt = ethers.utils.parseUnits(amtStr, 18);

  try {
    // Approve if needed
    const timbs = new ethers.Contract(ADDRESSES.TIMBSToken, TIMBS_ABI, signer);
    const allowance = await timbs.allowance(userAddress, ADDRESSES.TimbGovernance);
    if (allowance.lt(amt)) {
      btn.disabled = true;
      btn.textContent = "Approving…";
      DebugHub.logCheckpoint("Gov:Deposit Approve Requested", "pass");
      const gas   = await getGasParams();
      const nonce = await getPendingNonce();
      const tx    = await timbs.approve(ADDRESSES.TimbGovernance, ethers.constants.MaxUint256, { ...gas, nonce });
      DebugHub.logCheckpoint("Gov:Deposit Approve Submitted", "pass");
      await tx.wait();
      DebugHub.logCheckpoint("Gov:Deposit Approve Confirmed", "pass");
    }

    btn.textContent = "Depositing…";
    DebugHub.logCheckpoint("Gov:Deposit Requested", "pass");
    const gov   = new ethers.Contract(ADDRESSES.TimbGovernance, GOV_ABI, signer);
    const gas   = await getGasParams();
    const nonce = await getPendingNonce();
    const tx    = await gov.depositVotingPower(amt, { ...gas, nonce });
    DebugHub.logCheckpoint("Gov:Deposit Submitted", "pass");
    await tx.wait();
    DebugHub.logCheckpoint("Gov:Deposit Confirmed", "pass");

    document.getElementById("vp-input").value = "";
    btn.textContent = "Deposited ✓";
    await loadStats();
    await loadProposals();
    setTimeout(() => { btn.textContent = "Deposit"; btn.disabled = false; }, 2000);

  } catch (err) {
    const msg = err?.reason || err?.message || String(err);
    console.error("Deposit failed:", msg);
    DebugHub.logError("handleDeposit", err);
    DebugHub.logCheckpoint("Gov:Deposit Failed", "fail");
    btn.textContent = "Failed — retry";
    setTimeout(() => { btn.textContent = "Deposit"; btn.disabled = false; }, 2000);
  }
}

async function handleWithdraw() {
  if (!userAddress || myVotingPower.eq(0)) return;
  const btn = document.getElementById("vp-withdraw-btn");

  try {
    btn.disabled = true;
    btn.textContent = "Withdrawing…";
    DebugHub.logCheckpoint("Gov:Withdraw Requested", "pass");
    const gov   = new ethers.Contract(ADDRESSES.TimbGovernance, GOV_ABI, signer);
    const gas   = await getGasParams();
    const nonce = await getPendingNonce();
    const tx    = await gov.withdrawVotingPower(myVotingPower, { ...gas, nonce });
    DebugHub.logCheckpoint("Gov:Withdraw Submitted", "pass");
    await tx.wait();
    DebugHub.logCheckpoint("Gov:Withdraw Confirmed", "pass");

    btn.textContent = "Withdrawn ✓";
    await loadStats();
    await loadProposals();
    setTimeout(() => { btn.textContent = "Withdraw"; btn.disabled = false; }, 2000);

  } catch (err) {
    const msg = err?.reason || err?.message || String(err);
    console.error("Withdraw failed:", msg);
    DebugHub.logError("handleWithdraw", err);
    DebugHub.logCheckpoint("Gov:Withdraw Failed", "fail");
    btn.textContent = "Failed — retry";
    btn.disabled = false;
  }
}

// ─── Proposals ────────────────────────────────────────────────────────────────

async function loadProposals() {
  const list = document.getElementById("proposals-list");
  if (proposalCount === 0) {
    list.innerHTML = '<div class="empty-state">No proposals yet. Proposals are created by the protocol owner and voted on by TIMBS holders.</div>';
    return;
  }

  list.innerHTML = "";
  const gov = new ethers.Contract(ADDRESSES.TimbGovernance, GOV_ABI, readProv());

  // Load most recent first, up to 20
  const start = Math.max(1, proposalCount - 19);
  for (let id = proposalCount; id >= start; id--) {
    try {
      const [p, liveStatus] = await gov.getProposal(id);
      const el = await renderProposal(p, liveStatus.toNumber(), id, gov);
      list.appendChild(el);
    } catch (e) {
      console.warn(`proposal ${id}:`, e.message);
    }
  }
}

async function renderProposal(p, liveStatus, id, gov) {
  const row = document.createElement("div");
  row.className = "proposal-row";

  const statusLabel = STATUS_LABELS[liveStatus] || "Unknown";
  const statusClass = STATUS_CLASSES[liveStatus] || "status-pending";

  // Vote bar
  const forVotes     = parseFloat(ethers.utils.formatUnits(p.forVotes, 18));
  const againstVotes = parseFloat(ethers.utils.formatUnits(p.againstVotes, 18));
  const totalVotes   = forVotes + againstVotes;
  const forPct       = totalVotes > 0 ? (forVotes / totalVotes * 100).toFixed(1) : "0.0";
  const againstPct   = totalVotes > 0 ? (againstVotes / totalVotes * 100).toFixed(1) : "0.0";

  // Time context
  const now      = Math.floor(Date.now() / 1000);
  const starts   = p.votingStartsAt.toNumber();
  const ends     = p.votingEndsAt.toNumber();
  let timeNote   = "";
  if (now < starts) {
    const hrs = Math.ceil((starts - now) / 3600);
    timeNote = `Voting opens in ${hrs}h`;
  } else if (now < ends) {
    const hrs = Math.ceil((ends - now) / 3600);
    timeNote = `Voting closes in ${hrs}h`;
  } else {
    timeNote = `Voting ended`;
  }

  // Has user voted?
  let votedHtml = "";
  let voteActionsHtml = "";
  const isActive = liveStatus === 1;

  if (userAddress && isActive && now >= starts && now < ends) {
    const voted = await gov.hasVoted(userAddress, id).catch(() => false);
    if (voted) {
      votedHtml = `<span class="voted-indicator">Voted</span>`;
    } else if (!myVotingPower.eq(0)) {
      voteActionsHtml = `
        <button class="btn-vote-for"     onclick="handleVote(${id}, true)">Vote For</button>
        <button class="btn-vote-against" onclick="handleVote(${id}, false)">Vote Against</button>
      `;
    } else {
      votedHtml = `<span class="voted-indicator">Deposit TIMBS to vote</span>`;
    }
  }

  // Resolve button — permissionless, show after voting ends if still unresolved
  let resolveHtml = "";
  if ((liveStatus === 1 || liveStatus === 0) && now > ends) {
    resolveHtml = `<button class="btn-resolve" onclick="handleResolve(${id})">Resolve</button>`;
  }

  row.innerHTML = `
    <div class="proposal-top">
      <span class="proposal-title">#${id} — ${escapeHtml(p.title)}</span>
      <span class="status-badge ${statusClass}">${statusLabel}</span>
    </div>
    <div class="proposal-desc">${escapeHtml(p.description)}</div>
    <div class="vote-bar-wrap">
      <div class="vote-bar-track">
        <div class="vote-bar-for"     style="width:${forPct}%"></div>
        <div class="vote-bar-against" style="width:${againstPct}%"></div>
      </div>
      <div class="vote-bar-labels">
        <span class="for-label">For ${forPct}%</span>
        <span class="against-label">Against ${againstPct}%</span>
      </div>
    </div>
    <div class="proposal-actions">
      <span class="proposal-meta">${timeNote} · ${totalVotes.toFixed(0)} TIMBS cast</span>
      ${votedHtml}
      ${voteActionsHtml}
      ${resolveHtml}
    </div>
  `;
  return row;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Vote ─────────────────────────────────────────────────────────────────────

async function handleVote(proposalId, support) {
  if (!userAddress) return;
  const label = support ? "For" : "Against";

  try {
    DebugHub.logCheckpoint(`Gov:Vote ${label} Requested`, "pass");
    const gov   = new ethers.Contract(ADDRESSES.TimbGovernance, GOV_ABI, signer);
    const gas   = await getGasParams();
    const nonce = await getPendingNonce();
    const tx    = await gov.castVote(proposalId, support, { ...gas, nonce });
    DebugHub.logCheckpoint(`Gov:Vote ${label} Submitted`, "pass");
    await tx.wait();
    DebugHub.logCheckpoint(`Gov:Vote ${label} Confirmed`, "pass");
    await loadProposals();
  } catch (err) {
    console.error("castVote failed:", err.message);
    DebugHub.logError("handleVote", err);
    DebugHub.logCheckpoint("Gov:Vote Failed", "fail");
    alert("Vote failed: " + (err?.reason || err.message));
  }
}

// ─── Resolve ──────────────────────────────────────────────────────────────────

async function handleResolve(proposalId) {
  try {
    DebugHub.logCheckpoint("Gov:Resolve Requested", "pass");
    const gov   = new ethers.Contract(ADDRESSES.TimbGovernance, GOV_ABI, signer);
    const gas   = await getGasParams();
    const nonce = await getPendingNonce();
    const tx    = await gov.resolveProposal(proposalId, { ...gas, nonce });
    DebugHub.logCheckpoint("Gov:Resolve Submitted", "pass");
    await tx.wait();
    DebugHub.logCheckpoint("Gov:Resolve Confirmed", "pass");
    await loadProposals();
  } catch (err) {
    console.error("resolveProposal failed:", err.message);
    DebugHub.logError("handleResolve", err);
    DebugHub.logCheckpoint("Gov:Resolve Failed", "fail");
    alert("Resolve failed: " + (err?.reason || err.message));
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

  await loadStats();
  await loadProposals();

  listenForAccountChanges(async (newAddr) => {
    if (!newAddr) { handleDisconnect(); return; }
    document.getElementById("wallet-addr").textContent = fmtAddr(newAddr);
    await loadStats();
    await loadProposals();
  });
}

function handleDisconnect() {
  DebugHub.endSession();
  provider = null; signer = null; userAddress = null;
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
  document.getElementById("vp-deposit-btn").disabled = true;
  document.getElementById("vp-deposit-btn").textContent = "Connect wallet";
  document.getElementById("vp-withdraw-btn").disabled = true;
  loadStats();
  loadProposals();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
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
      await loadStats();
      await loadProposals();
    });
  }

  await loadStats();
  await loadProposals();
  setInterval(loadStats, 20000);
})();
