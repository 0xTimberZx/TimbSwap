// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title PoolLedger
 * @notice Custody + credit ledger for a SegmentBoard generation. Holds all TIMBS
 *         staked into a board's pools and the seed float, and records what each
 *         wallet is owed. Players pull their own credit; the board instructs all
 *         accounting.
 *
 * Design:
 *   - Single responsibility: hold TIMBS, credit balances on the board's
 *     instruction, and let wallets withdraw their own credit. It owns NO
 *     game logic — the pari-mutuel math (winners, weights, rake) lives in
 *     SegmentBoard, exactly as PrizeEscrow holds ETH while TimbPrize owns the
 *     accounting.
 *   - Only the wired board may collect stakes, credit winnings, refund, or
 *     sweep. No other address can move pooled funds.
 *   - Withdrawals are never pausable: a halted or retired board can always be
 *     drained by the wallets it owes.
 *
 * Security (escrow is sacred):
 *   - Money is tracked per table. `tableEscrow[id]` holds a table's seed plus its
 *     players' loaded chips; a pool can only ever pay out of the stakes that
 *     entered its own table, and `sweepTable` takes no amount, so one table's
 *     close-out cannot reach another's funds. The earlier `sweep(to, amount)`
 *     could, and did (VALIDATION.md discovery #11).
 *   - The invariant is `balanceOf(this) >= totalCredited + totalEscrowed`.
 *     `totalCredited` is what wallets may withdraw; `totalEscrowed` is live
 *     table money not yet credited. Both are fully backed at all times.
 *   - The owner's protocol-fund withdrawal is capped to the residual
 *     `balanceOf(this) - totalCredited - totalEscrowed` — genuine surplus only.
 *     Neither the board, the Treasury path, nor the owner can reach a wallet's
 *     credit or a live table's stake.
 *   - ReentrancyGuard on every function that transfers TIMBS out;
 *     checks-effects-interactions throughout.
 *   - The owner is renounceable (OZ Ownable): once renounced, `setBoard` and
 *     `ownerWithdraw` are permanently uncallable while withdrawals keep working.
 *
 * Deployment:
 *   1. Deploy PoolLedger(timbs, treasury)
 *   2. Deploy SegmentBoard(poolLedger, ...)
 *   3. poolLedger.setBoard(segmentBoard)   // one-time, owner-only
 *   4. Add poolLedger to TIMBS transferWhitelist so payouts never trip the cap
 *   5. Renounce ownership at maturity
 */
contract PoolLedger is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── State ─────────────────────────────────────────────────────────────────

    /// @notice The TIMBS token this ledger custodies.
    IERC20 public immutable timbs;

    /// @notice Treasury address that receives sweeps (no-winner pots, rake, dust).
    address public immutable treasury;

    /// @notice The SegmentBoard authorised to drive all accounting. Set once.
    address public board;

    /// @notice wallet => TIMBS currently owed to it and withdrawable on demand.
    mapping(address => uint256) public credit;

    /// @notice Sum of all `credit` entries. Never exceeds the TIMBS balance.
    uint256 public totalCredited;

    /// @notice Tokens held on behalf of one table: its seed plus every chip its
    ///         players have loaded, minus whatever has since been credited,
    ///         refunded or swept. Escrow that has not been credited *yet* is
    ///         still somebody's money, and this is what makes that legible.
    mapping(uint256 => uint256) public tableEscrow;

    /// @notice Sum of `tableEscrow` across live tables, maintained incrementally
    ///         so nothing ever iterates over tables.
    uint256 public totalEscrowed;

    // ─── Events ────────────────────────────────────────────────────────────────

    event BoardSet(address indexed board);
    event Collected(address indexed from, uint256 indexed tableId, uint256 amount);
    event SeedFunded(address indexed from, uint256 indexed tableId, uint256 amount);
    event WinningsCredited(address indexed to, uint256 indexed tableId, uint256 amount);
    event Refunded(address indexed to, uint256 indexed tableId, uint256 amount);
    event Swept(address indexed to, uint256 indexed tableId, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event ProtocolWithdrawn(address indexed to, uint256 amount);
    // ── gen-6 ──
    event UnderwriteCredited(address indexed from, uint256 indexed tableId, uint256 amount);
    event CreditMoved(address indexed from, address indexed to, uint256 amount);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error NotBoard();
    error BoardAlreadySet();
    error LengthMismatch();
    error ExceedsUnowed(uint256 requested, uint256 available);
    error ExceedsTableEscrow(uint256 tableId, uint256 requested, uint256 held);
    error NothingToWithdraw();
    error ExceedsCredit(address wallet, uint256 requested, uint256 held);

    // ─── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyBoard() {
        if (msg.sender != board) revert NotBoard();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(address _timbs, address _treasury) Ownable(msg.sender) {
        if (_timbs == address(0) || _treasury == address(0)) revert ZeroAddress();
        timbs    = IERC20(_timbs);
        treasury = _treasury;
    }

    // ─── Board: intake ─────────────────────────────────────────────────────────

    /**
     * @notice Pull a player's stake into the vault. Caller must have approved
     *         this ledger for `amount`. Board-gated; the board records which pool.
     */
    function collect(address from, uint256 amount, uint256 tableId) external onlyBoard {
        if (from == address(0)) revert ZeroAddress();
        if (amount == 0)        revert ZeroAmount();
        timbs.safeTransferFrom(from, address(this), amount);
        tableEscrow[tableId] += amount;
        totalEscrowed        += amount;
        emit Collected(from, tableId, amount);
    }

    /**
     * @notice Pull seed float into the vault (e.g. from the Treasury). Caller
     *         must have approved this ledger for `amount`.
     */
    function fundSeed(address from, uint256 amount, uint256 tableId) external onlyBoard {
        if (from == address(0)) revert ZeroAddress();
        if (amount == 0)        revert ZeroAmount();
        timbs.safeTransferFrom(from, address(this), amount);
        tableEscrow[tableId] += amount;
        totalEscrowed        += amount;
        emit SeedFunded(from, tableId, amount);
    }

    // ─── Board: settlement accounting ──────────────────────────────────────────

    /**
     * @notice Credit a pool's winners. The board computes each amount from the
     *         pari-mutuel weights; this ledger only records and backs them. The
     *         array is bounded by the board (<= seats per pool), so no unbounded
     *         loop reaches this contract.
     * @dev Reverts if the resulting `totalCredited` would exceed the held
     *      balance — credit must always be fully backed.
     */
    function creditWinnings(
        address[] calldata recipients,
        uint256[] calldata amounts,
        uint256 tableId
    ) external onlyBoard {
        uint256 len = recipients.length;
        if (len != amounts.length) revert LengthMismatch();

        uint256 added;
        for (uint256 i; i < len; ++i) {
            address to     = recipients[i];
            uint256 amount = amounts[i];
            if (to == address(0)) revert ZeroAddress();
            if (amount == 0)      continue; // losers carry zero weight; skip cheaply
            credit[to] += amount;
            added      += amount;
            emit WinningsCredited(to, tableId, amount);
        }

        // A pool can only ever pay out of the stakes that entered its own table.
        uint256 held = tableEscrow[tableId];
        if (added > held) revert ExceedsTableEscrow(tableId, added, held);
        tableEscrow[tableId] = held - added;
        totalEscrowed       -= added;
        totalCredited       += added;
    }

    /**
     * @notice Credit a single wallet a refund (e.g. an unplayed/dislodged chip
     *         at retire). Backed like any other credit.
     */
    function refund(address to, uint256 amount, uint256 tableId) external onlyBoard {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0)      revert ZeroAmount();
        uint256 held = tableEscrow[tableId];
        if (amount > held) revert ExceedsTableEscrow(tableId, amount, held);
        tableEscrow[tableId] = held - amount;
        totalEscrowed       -= amount;
        credit[to]          += amount;
        totalCredited       += amount;
        emit Refunded(to, tableId, amount);
    }

    /**
     * @notice Gen-6 underwrite intake (M1): pull a granted top-up from the
     *         reserve and credit the pool's winners in one atomic step. The
     *         transfer lands BEFORE any credit is recorded — the ledger never
     *         credits against an IOU (UNDERWRITE_SPEC, accounting rules).
     *         Top-up money is outside money: it never touches `tableEscrow`,
     *         so the escrow-sacred invariant holds by construction
     *         (`held += sum` and `credited += sum` move together).
     * @dev Array bounded by the board (<= seats per pool). Zero amounts are
     *      skipped; a fully-zero batch is a cheap no-op, matching the
     *      settlement-never-reverts rule.
     */
    function underwriteCredit(
        address from,
        address[] calldata recipients,
        uint256[] calldata amounts,
        uint256 tableId
    ) external onlyBoard {
        uint256 len = recipients.length;
        if (len != amounts.length) revert LengthMismatch();
        if (from == address(0))    revert ZeroAddress();

        uint256 sum;
        for (uint256 i; i < len; ++i) {
            if (amounts[i] == 0) continue;
            if (recipients[i] == address(0)) revert ZeroAddress();
            sum += amounts[i];
        }
        if (sum == 0) return;

        timbs.safeTransferFrom(from, address(this), sum);
        for (uint256 i; i < len; ++i) {
            if (amounts[i] == 0) continue;
            credit[recipients[i]] += amounts[i];
            emit WinningsCredited(recipients[i], tableId, amounts[i]);
        }
        totalCredited += sum;
        emit UnderwriteCredited(from, tableId, sum);
    }

    /**
     * @notice Gen-6 dealer tips (M6): move credit between two wallets on the
     *         board's instruction. Pure bookkeeping — `heldBalance`,
     *         `totalCredited` and every escrow figure are unchanged, so the
     *         invariant cannot be disturbed by construction. The board gates
     *         who may move credit to whom (seated tipper -> table opener,
     *         after the sixth lock).
     */
    function moveCredit(address from, address to, uint256 amount) external onlyBoard {
        if (from == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 held = credit[from];
        if (amount > held) revert ExceedsCredit(from, amount, held);
        credit[from] = held - amount;
        credit[to]  += amount;
        emit CreditMoved(from, to, amount);
    }

    /**
     * @notice Gen-6 split sweep: move `amount` of a *single* table's leftovers
     *         to `to` (the reserve's share of a retire) ahead of the final
     *         `sweepTable`. Capped to that table's own escrow — the per-table
     *         bound is what made removing `sweep(to, amount)` necessary
     *         (discovery #11 was a GLOBAL cap); a cross-table sweep is still
     *         unrepresentable here.
     */
    function sweepTablePartial(address to, uint256 tableId, uint256 amount)
        external
        onlyBoard
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0)      return; // nothing routed is not an error
        uint256 held = tableEscrow[tableId];
        if (amount > held) revert ExceedsTableEscrow(tableId, amount, held);
        tableEscrow[tableId] = held - amount;
        totalEscrowed       -= amount;
        timbs.safeTransfer(to, amount);
        emit Swept(to, tableId, amount);
    }

    /**
     * @notice Sweep what a *single* table has left — its rake, no-winner pots,
     *         forfeited seed and dust — to `to` (typically the Treasury).
     *
     * @dev There is deliberately no `amount` parameter. The previous
     *      `sweep(to, amount)` was capped only to the ledger's *global* unowed
     *      balance, which made over-sweeping a matter of the board passing the
     *      right number — and it did not: closing out any one table took every
     *      other live table's seed and its players' loaded chips with it
     *      (VALIDATION.md discovery #11). Taking the table id instead of an
     *      amount makes a cross-table sweep unrepresentable rather than merely
     *      guarded against.
     */
    function sweepTable(address to, uint256 tableId)
        external
        onlyBoard
        nonReentrant
        returns (uint256 amount)
    {
        if (to == address(0)) revert ZeroAddress();
        amount = tableEscrow[tableId];
        if (amount == 0) return 0;           // nothing left is not an error
        tableEscrow[tableId] = 0;
        totalEscrowed       -= amount;
        timbs.safeTransfer(to, amount);
        emit Swept(to, tableId, amount);
    }

    // ─── Player: pull-claim ────────────────────────────────────────────────────

    /**
     * @notice Withdraw the caller's entire credit. Always available — never
     *         pausable — so a halted or retired board can always be exited.
     */
    function withdraw() external nonReentrant {
        uint256 amount = credit[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credit[msg.sender] = 0;
        totalCredited     -= amount;
        timbs.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ─── Owner: config ─────────────────────────────────────────────────────────

    /// @notice Wire the board once. Renouncing ownership afterwards locks it.
    function setBoard(address _board) external onlyOwner {
        if (_board == address(0)) revert ZeroAddress();
        if (board != address(0))  revert BoardAlreadySet();
        board = _board;
        emit BoardSet(_board);
    }

    /**
     * @notice Narrow protocol-fund move: withdraw only genuine surplus — dust and
     *         tokens transferred in by accident — to `to`. Capped to
     *         `heldBalance - totalCredited - totalEscrowed`, so both player credit
     *         and live table escrow are provably untouchable. Removed forever once
     *         ownership is renounced.
     */
    function ownerWithdraw(address to, uint256 amount)
        external
        nonReentrant
        onlyOwner
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0)      revert ZeroAmount();
        uint256 avail = _unowed();
        if (amount > avail) revert ExceedsUnowed(amount, avail);
        timbs.safeTransfer(to, amount);
        emit ProtocolWithdrawn(to, amount);
    }

    // ─── View ──────────────────────────────────────────────────────────────────

    /// @notice TIMBS currently held by the ledger.
    function heldBalance() external view returns (uint256) {
        return timbs.balanceOf(address(this));
    }

    /// @notice Genuine surplus: held balance minus owed credit AND live escrow.
    function unowed() external view returns (uint256) {
        return _unowed();
    }

    /**
     * @dev Genuine protocol surplus: dust, and tokens someone transferred in by
     *      accident. Deliberately excludes `totalEscrowed` — escrow that has not
     *      been credited yet is still a live table's stake, and the old
     *      definition (balance - totalCredited) let `ownerWithdraw` reach it.
     */
    function _unowed() internal view returns (uint256) {
        uint256 spokenFor = totalCredited + totalEscrowed;
        uint256 bal = timbs.balanceOf(address(this));
        return bal > spokenFor ? bal - spokenFor : 0;
    }
}
