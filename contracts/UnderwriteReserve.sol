// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title UnderwriteReserve
 * @notice The gen-6 underwrite reserve (SwapTables/docs/UNDERWRITE_SPEC.md,
 *         GAME_ECONOMY.md). Holds the TIMBS float that tops thin winning pools
 *         up toward `stake x fair x 0.90`, and receives the income that funds
 *         it: every dead pot, and half the rake.
 *
 * Design (money can only move three ways):
 *   1. OUT to the ledger as a granted top-up — pulled by the wired board's
 *      PoolLedger via the standing allowance, after `grantTopUp` has applied
 *      the caps. The reserve never pushes to a wallet.
 *   2. IN from table close-outs (ledger sweeps land here directly) and from
 *      budgeted Treasury support.
 *   3. OUT whole to Treasury by the guardian (`drainToTreasury`) — the only
 *      exit that is not a player payout, for retiring the contract.
 *
 * The caps are the whole design (UNDERWRITE_SPEC):
 *   - MAX_ROUND_UNDERWRITE per table, first-settled-first-served;
 *   - MAX_RESERVE_FRACTION_BPS of the free float per grant;
 *   - the per-pool cap (MAX_UNDERWRITE_PAYOUT) is enforced board-side, where
 *     the pool is known.
 *   `grantTopUp` NEVER reverts on shortage — it grants what the caps and the
 *   balance allow, possibly zero. A pick that cannot settle is far worse than
 *   a payout smaller than advertised.
 *
 * Waterfall (GAME_ECONOMY): income fills the float up to `floatTarget`;
 * anything beyond parks in `overflowEarmark`, reserved for the Rolling
 * Jackpot (M2) and la partage (M3) when they ship. Earmarked money is not
 * spendable on top-ups — solvency before sizzle, but a promise parked is a
 * promise kept.
 *
 * Solvency (no minting, only recycling): cumulative budgeted Treasury support
 * may never exceed what this generation's tables have actually swept to
 * Treasury (`treasuryEarned`, reported by the board at each retire). The
 * counters make the invariant checkable on-chain. The one exception is the
 * initial seeding, done as a plain transfer before the first round — early
 * variance cover, documented in the spec.
 */
contract UnderwriteReserve is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Constants ─────────────────────────────────────────────────────────

    /// @notice Max top-up granted per table per round (all pools combined).
    uint256 public constant MAX_ROUND_UNDERWRITE = 1500e18;
    /// @notice Max share of the free float a single grant may take, in bps.
    uint256 public constant MAX_RESERVE_FRACTION_BPS = 1000; // 10%
    uint256 public constant BPS = 10_000;

    // ─── State ─────────────────────────────────────────────────────────────

    IERC20  public immutable timbs;
    address public immutable treasury;

    /// @notice The SegmentBoard generation allowed to draw grants. Set once.
    address public board;
    /// @notice Halt-only role: may pause grants and drain to Treasury.
    address public guardian;
    /// @notice The single PoolLedger currently holding a standing TIMBS
    ///         allowance (M6). Only one ledger is ever approved at a time.
    address public ledger;
    /// @notice While halted, `grantTopUp` returns 0 — settlement never blocks.
    bool public halted;

    /// @notice Float the waterfall fills before income parks as overflow.
    ///         Sized to cover several worst-case rounds (3 x round cap).
    uint256 public floatTarget = 4500e18;

    /// @notice tableId => top-ups granted this round (MAX_ROUND_UNDERWRITE cap).
    mapping(uint256 => uint256) public roundUsed;

    /// @notice Income parked for the jackpot (M2) + la partage (M3); not
    ///         spendable on top-ups.
    uint256 public overflowEarmark;

    // Solvency counters (GAME_ECONOMY "no minting, only recycling")
    /// @notice Cumulative rake share + dead pots received from retires.
    uint256 public gameIncome;
    /// @notice Cumulative sweeps the board reported sending to Treasury.
    uint256 public treasuryEarned;
    /// @notice Cumulative budgeted Treasury support drawn in. Never exceeds
    ///         `treasuryEarned`.
    uint256 public treasurySupport;

    // ─── Events ────────────────────────────────────────────────────────────

    event BoardSet(address indexed board);
    event LedgerApproved(address indexed ledger);
    event LedgerRevoked(address indexed ledger);
    event TopUpGranted(uint256 indexed tableId, uint256 wanted, uint256 granted, uint256 freeFloatAfter);
    event IncomeRecorded(uint256 indexed tableId, uint256 rakeShare, uint256 deadPots, uint256 treasuryShare, uint256 parkedToOverflow);
    event BudgetedSupport(address indexed from, uint256 amount, uint256 supportTotal, uint256 earnedTotal);
    event GrantsHalted(bool halted);
    event GuardianSet(address indexed guardian);
    event DrainedToTreasury(uint256 amount);

    // ─── Errors ────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error NotBoard();
    error NotGuardian();
    error BoardAlreadySet();
    error ExceedsBudget(uint256 requested, uint256 supportTotal, uint256 earnedTotal);

    modifier onlyBoard() {
        if (msg.sender != board) revert NotBoard();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    // ─── Constructor ───────────────────────────────────────────────────────

    constructor(address _timbs, address _treasury, address _guardian) Ownable(msg.sender) {
        if (_timbs == address(0) || _treasury == address(0)) revert ZeroAddress();
        timbs    = IERC20(_timbs);
        treasury = _treasury;
        guardian = _guardian; // may be 0 for a zero-privilege deployment
    }

    // ─── Board: grants ─────────────────────────────────────────────────────

    /**
     * @notice Reserve `wanted` TIMBS of top-up for one settling pool, clamped
     *         by the round cap, the reserve-fraction cap, and the free float.
     *         Returns the granted amount — possibly zero, never a revert.
     * @dev State-only: the money moves when the board has its PoolLedger pull
     *      via the standing allowance, in the same transaction. The grant and
     *      the pull cannot be interleaved with anything else.
     */
    function grantTopUp(uint256 tableId, uint256 wanted) external onlyBoard returns (uint256 granted) {
        if (halted || wanted == 0) return 0;

        uint256 roundLeft = MAX_ROUND_UNDERWRITE - _min(roundUsed[tableId], MAX_ROUND_UNDERWRITE);
        if (roundLeft == 0) return 0;

        uint256 free = _freeFloat();
        uint256 fractionCap = (free * MAX_RESERVE_FRACTION_BPS) / BPS;

        granted = _min(_min(wanted, roundLeft), _min(fractionCap, free));
        if (granted == 0) return 0;

        roundUsed[tableId] += granted;
        emit TopUpGranted(tableId, wanted, granted, free - granted);
    }

    /**
     * @notice Book a retire's income and run the waterfall. The TIMBS itself
     *         arrives in the same transaction via the ledger's table sweep;
     *         this call only classifies it and parks any overflow.
     * @param rakeShare     half of the table's rake, swept here
     * @param deadPots      the table's no-winner pots, swept here
     * @param treasuryShare what the same retire swept to Treasury — feeds the
     *                      solvency counter that budgets future support
     */
    function recordIncome(uint256 tableId, uint256 rakeShare, uint256 deadPots, uint256 treasuryShare)
        external
        onlyBoard
    {
        gameIncome     += rakeShare + deadPots;
        treasuryEarned += treasuryShare;

        // Waterfall: fill the float first, park the rest for M2/M3.
        uint256 free = _freeFloat();
        uint256 parked;
        if (free > floatTarget) {
            parked = free - floatTarget;
            overflowEarmark += parked;
        }
        emit IncomeRecorded(tableId, rakeShare, deadPots, treasuryShare, parked);
    }

    // ─── Treasury support (budgeted) ───────────────────────────────────────

    /**
     * @notice Pull budgeted Treasury support into the reserve. Enforces the
     *         solvency rule: cumulative support never exceeds what the game
     *         has actually paid Treasury. Caller (the ops wallet moving
     *         Treasury funds) must have approved this contract.
     */
    function fundBudgeted(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (treasurySupport + amount > treasuryEarned) {
            revert ExceedsBudget(amount, treasurySupport, treasuryEarned);
        }
        treasurySupport += amount;
        timbs.safeTransferFrom(msg.sender, address(this), amount);
        emit BudgetedSupport(msg.sender, amount, treasurySupport, treasuryEarned);
    }

    // ─── Guardian ──────────────────────────────────────────────────────────

    /// @notice Pause/resume grants. Settlement keeps working — pools just pay
    ///         from their own money while halted.
    function setHalted(bool _halted) external onlyGuardian {
        halted = _halted;
        emit GrantsHalted(_halted);
    }

    /// @notice Retire the reserve: send everything to Treasury. The only exit
    ///         that is not a player payout.
    function drainToTreasury() external onlyGuardian nonReentrant {
        uint256 bal = timbs.balanceOf(address(this));
        if (bal == 0) revert ZeroAmount();
        overflowEarmark = 0;
        timbs.safeTransfer(treasury, bal);
        emit DrainedToTreasury(bal);
    }

    // ─── Owner: wiring ─────────────────────────────────────────────────────

    /// @notice Wire the board once. Renouncing ownership afterwards locks it.
    function setBoard(address _board) external onlyOwner {
        if (_board == address(0)) revert ZeroAddress();
        if (board != address(0))  revert BoardAlreadySet();
        board = _board;
        emit BoardSet(_board);
    }

    /// @notice Give the generation's PoolLedger a standing allowance so it can
    ///         pull granted top-ups (mirror of the seed-funder approve).
    /// @dev M6: hardened against the house-float rug the audit flagged.
    ///      - The owner is now a timelock+multisig (dev-docs/GOVERNANCE_
    ///        HARDENING.md), so re-pointing this allowance is delayed and public.
    ///      - Single-ledger invariant: approving a new ledger first ZEROES the
    ///        previous one's allowance, so stale infinite allowances can never
    ///        accumulate — at most one address is ever approved at a time.
    ///      - `revokeLedger` gives the guardian a fast kill switch, and the
    ///        guardian's existing `drainToTreasury` remains the ultimate rescue
    ///        (empties the float to the immutable treasury) if a bad ledger is
    ///        ever approved.
    function approveLedger(address newLedger) external onlyOwner {
        if (newLedger == address(0)) revert ZeroAddress();
        address old = ledger;
        if (old != address(0) && old != newLedger) {
            timbs.forceApprove(old, 0);
            emit LedgerRevoked(old);
        }
        ledger = newLedger;
        timbs.forceApprove(newLedger, type(uint256).max);
        emit LedgerApproved(newLedger);
    }

    /// @notice Kill the standing allowance immediately. Owner OR guardian — the
    ///         guardian is the halt-role, so it can pull this fast without the
    ///         timelock delay if a ledger misbehaves or was approved in error.
    function revokeLedger() external {
        if (msg.sender != owner() && msg.sender != guardian) revert NotGuardian();
        address old = ledger;
        if (old == address(0)) revert ZeroAddress();
        timbs.forceApprove(old, 0);
        ledger = address(0);
        emit LedgerRevoked(old);
    }

    /// @notice Retune the waterfall float target (policy, not custody).
    function setFloatTarget(uint256 _floatTarget) external onlyOwner {
        floatTarget = _floatTarget;
    }

    /// @notice Replace the guardian. Locked once ownership is renounced.
    function setGuardian(address _guardian) external onlyOwner {
        guardian = _guardian;
        emit GuardianSet(_guardian);
    }

    // ─── Views ─────────────────────────────────────────────────────────────

    /// @notice Balance not parked for M2/M3 — what top-ups may draw from.
    function freeFloat() external view returns (uint256) {
        return _freeFloat();
    }

    function _freeFloat() internal view returns (uint256) {
        uint256 bal = timbs.balanceOf(address(this));
        return bal > overflowEarmark ? bal - overflowEarmark : 0;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
