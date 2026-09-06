// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev The slice of a SegmentBoard generation the jackpot needs to verify a
///      Double-Digit hit on its own. Positions are append-only across
///      generations (the same guarantee the SegmentCrank relies on), so this
///      10-field prefix decodes against gen-6 and everything after it.
interface ISegmentBoardView {
    struct Bet { address wallet; uint8 chipIdx; uint8 kind; uint8 pick; }
    function tables(uint256 tableId) external view returns (
        uint64 openedAt, uint64 pickTime, uint64 lockBlock, uint32 seedRound,
        uint8 seatCount, uint8 lockedMask, bool ddSettled, bool retired,
        bytes6 seedString, bytes6 lockedChars
    );
    function betCount(uint256 tableId, uint8 pool) external view returns (uint256);
    function betAt(uint256 tableId, uint8 pool, uint256 i) external view returns (Bet memory);
    function CHIPS(uint256 i) external view returns (uint256);
    function hasRepeat(bytes6 s) external pure returns (bool);
}

/**
 * @title DDJackpot
 * @notice The Rolling Double-Digit Jackpot (SwapTables/docs/GAME_ECONOMY.md,
 *         M2). A pot that persists ACROSS tables and generations: it only ever
 *         climbs until a table's Double-Digit hits, and then it pays a metered
 *         slice on top of that table's own DD pool.
 *
 * Deploy ONCE — never per generation (the SeedRegistry shape). It needs no
 * hook inside the board: a Double-Digit hit is fully legible from the board's
 * public state (ddSettled + hasRepeat(lockedChars) + the DD pool's bets), so
 * `strike` is a permissionless read-verify-pay that works against any board
 * this contract has been told to trust.
 *
 * The honest variable-ratio hook, by construction:
 *   - the number on the banner only ever climbs until somebody takes it;
 *   - each strike pays a METERED slice — sliceBps of the balance, floored at
 *     sliceFloor — never the whole pot, so the banner survives its own
 *     payout (the gen-4 encore plan's anti-drain meter, reused);
 *   - §9 everywhere: the slice pays only when TWO OR MORE distinct wallets
 *     bet Double-Digit, so a lone wallet grinding empty tables gets nothing;
 *   - once per table, forever.
 *
 * Funding (no minting, only recycling — GAME_ECONOMY solvency rule):
 *   - `donate` — budgeted Treasury/ops drops ("tonight's jackpot is boosted"),
 *     and the route for the gen-6 reserve's overflow earmark until a later
 *     reserve generation can release it directly;
 *   - plain transfers also count — the balance IS the jackpot.
 *
 * Custody: guardian may halt strikes and drain to Treasury, nothing else;
 * owner tunes the meter and the trusted-board set, and is renounceable.
 */
contract DDJackpot is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8   public constant DD_POOL        = 6;
    uint256 public constant MIN_DD_WALLETS = 2;    // §9: no subsidy below two wallets
    uint256 public constant BPS            = 10_000;

    IERC20  public immutable timbs;
    address public immutable treasury;
    address public guardian;
    bool    public halted;

    /// @notice Boards whose tables may strike. Managed per generation exactly
    ///         like SeedRegistry writers — without this gate, any contract
    ///         faking the board views could drain the pot.
    mapping(address => bool) public trustedBoard;

    /// @notice The meter: each strike takes sliceBps of the balance, floored
    ///         at sliceFloor (or the whole balance if it holds less).
    uint256 public sliceBps   = 2_000;  // 20%
    uint256 public sliceFloor = 50e18;  // 50 TIMBS

    /// @notice Stake gate: a winner's share of the slice is capped at
    ///         `stakeCapMult x` their own DD chip, and the uncollected
    ///         remainder STAYS on the banner. A 5-chip wallet can carry at
    ///         most 50 out of the pot while a 1000-chip carries its full
    ///         pro-rata — the encore plan's min-chip scaling, applied here:
    ///         small chips cannot drain what big chips built.
    uint256 public stakeCapMult = 10;

    /// @notice board => tableId => already struck.
    mapping(address => mapping(uint256 => bool)) public struck;

    // ─── Events ────────────────────────────────────────────────────────────

    event BoardTrusted(address indexed board, bool trusted);
    event Donated(address indexed from, uint256 amount, uint256 balanceAfter);
    event JackpotStruck(address indexed board, uint256 indexed tableId, uint256 slice, uint256 winners, uint256 balanceAfter);
    event JackpotPaid(address indexed board, uint256 indexed tableId, address indexed winner, uint256 amount);
    event MeterSet(uint256 sliceBps, uint256 sliceFloor);
    event GuardianSet(address indexed guardian);
    event StrikesHalted(bool halted);
    event DrainedToTreasury(uint256 amount);

    // ─── Errors ────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error NotGuardian();
    error BoardNotTrusted(address board);
    error AlreadyStruck(address board, uint256 tableId);
    error DDNotSettled(uint256 tableId);
    error DDDidNotHit(uint256 tableId);
    error NotEnoughDDWallets(uint256 have, uint256 need);
    error JackpotEmpty();
    error Halted();
    error BadMeter(uint256 sliceBps);

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    constructor(address _timbs, address _treasury, address _guardian) Ownable(msg.sender) {
        if (_timbs == address(0) || _treasury == address(0)) revert ZeroAddress();
        timbs    = IERC20(_timbs);
        treasury = _treasury;
        guardian = _guardian; // may be 0 for a zero-privilege deployment
    }

    // ─── The strike ────────────────────────────────────────────────────────

    /**
     * @notice Pay the jackpot slice onto a table whose Double-Digit hit.
     *         Permissionless — the sixth reveal makes it true, anyone makes it
     *         paid (the console's auto-pilot fires it right after the locks).
     *         Winners are every DD bettor at the table, paid pro-rata by their
     *         DD stake, pushed straight to their wallets.
     */
    function strike(address board, uint256 tableId) external nonReentrant returns (uint256 slice) {
        if (halted) revert Halted();
        if (!trustedBoard[board]) revert BoardNotTrusted(board);
        if (struck[board][tableId]) revert AlreadyStruck(board, tableId);

        ISegmentBoardView b = ISegmentBoardView(board);
        (,,,,,, bool ddSettled,,, bytes6 lockedChars) = b.tables(tableId);
        if (!ddSettled)                revert DDNotSettled(tableId);
        if (!b.hasRepeat(lockedChars)) revert DDDidNotHit(tableId);

        uint256 n = b.betCount(tableId, DD_POOL);
        if (n < MIN_DD_WALLETS) revert NotEnoughDDWallets(n, MIN_DD_WALLETS);

        uint256 bal = timbs.balanceOf(address(this));
        if (bal == 0) revert JackpotEmpty();
        slice = (bal * sliceBps) / BPS;
        if (slice < sliceFloor) slice = sliceFloor;
        if (slice > bal)        slice = bal;

        struck[board][tableId] = true;

        // One DD bet per wallet on a real board, so n == distinct wallets and
        // this loop is bounded by the board's seat cap.
        uint256 totalStake;
        uint256[] memory stakes = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 s = b.CHIPS(b.betAt(tableId, DD_POOL, i).chipIdx);
            stakes[i] = s;
            totalStake += s;
        }
        uint256 paid;
        for (uint256 i; i < n; ++i) {
            uint256 amt = (slice * stakes[i]) / totalStake; // dust stays in the pot
            uint256 cap = stakes[i] * stakeCapMult;         // your chip is your ceiling
            if (amt > cap) amt = cap;
            if (amt == 0) continue;
            address w = b.betAt(tableId, DD_POOL, i).wallet;
            timbs.safeTransfer(w, amt);
            paid += amt;
            emit JackpotPaid(board, tableId, w, amt);
        }
        emit JackpotStruck(board, tableId, paid, n, timbs.balanceOf(address(this)));
        return paid;
    }

    /// @notice What a strike would actually pay right now (stake caps
    ///         included), and whether it can fire — the apps' one-call
    ///         eligibility check.
    function strikeable(address board, uint256 tableId) external view returns (bool ok, uint256 payable_) {
        if (halted || !trustedBoard[board] || struck[board][tableId]) return (false, 0);
        ISegmentBoardView b = ISegmentBoardView(board);
        (,,,,,, bool ddSettled,,, bytes6 lockedChars) = b.tables(tableId);
        if (!ddSettled || !b.hasRepeat(lockedChars))       return (false, 0);
        uint256 n = b.betCount(tableId, DD_POOL);
        if (n < MIN_DD_WALLETS) return (false, 0);
        uint256 bal = timbs.balanceOf(address(this));
        if (bal == 0) return (false, 0);
        uint256 slice = (bal * sliceBps) / BPS;
        if (slice < sliceFloor) slice = sliceFloor;
        if (slice > bal)        slice = bal;

        uint256 totalStake;
        uint256[] memory stakes = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            stakes[i] = b.CHIPS(b.betAt(tableId, DD_POOL, i).chipIdx);
            totalStake += stakes[i];
        }
        for (uint256 i; i < n; ++i) {
            uint256 amt = (slice * stakes[i]) / totalStake;
            uint256 cap = stakes[i] * stakeCapMult;
            payable_ += amt > cap ? cap : amt;
        }
        return (true, payable_);
    }

    // ─── Funding ───────────────────────────────────────────────────────────

    /// @notice Feed the pot. Caller approves first. Anyone may donate; the
    ///         no-minting rule is policy at the source — only earned TIMBS
    ///         is recycled here (GAME_ECONOMY solvency rule).
    function donate(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        timbs.safeTransferFrom(msg.sender, address(this), amount);
        emit Donated(msg.sender, amount, timbs.balanceOf(address(this)));
    }

    // ─── Owner: policy ─────────────────────────────────────────────────────

    /// @notice Trust or retire a board generation (SeedRegistry's writer dance).
    function setBoard(address board, bool trusted) external onlyOwner {
        if (board == address(0)) revert ZeroAddress();
        trustedBoard[board] = trusted;
        emit BoardTrusted(board, trusted);
    }

    /// @notice Retune the meter. Slice capped at 50% so a single strike can
    ///         never gut the banner; the floor is what keeps small pots
    ///         feeling real; the stake cap keeps small chips from draining
    ///         what big chips built.
    function setMeter(uint256 _sliceBps, uint256 _sliceFloor, uint256 _stakeCapMult) external onlyOwner {
        if (_sliceBps == 0 || _sliceBps > 5_000 || _stakeCapMult == 0) revert BadMeter(_sliceBps);
        sliceBps     = _sliceBps;
        sliceFloor   = _sliceFloor;
        stakeCapMult = _stakeCapMult;
        emit MeterSet(_sliceBps, _sliceFloor);
    }

    /// @notice Replace the guardian. Locked once ownership is renounced.
    function setGuardian(address _guardian) external onlyOwner {
        guardian = _guardian;
        emit GuardianSet(_guardian);
    }

    // ─── Guardian ──────────────────────────────────────────────────────────

    /// @notice Pause/resume strikes. The balance keeps climbing while halted.
    function setHalted(bool _halted) external onlyGuardian {
        halted = _halted;
        emit StrikesHalted(_halted);
    }

    /// @notice Retire the jackpot: everything to Treasury. The only exit that
    ///         is not a strike.
    function drainToTreasury() external onlyGuardian nonReentrant {
        uint256 bal = timbs.balanceOf(address(this));
        if (bal == 0) revert ZeroAmount();
        timbs.safeTransfer(treasury, bal);
        emit DrainedToTreasury(bal);
    }

    // ─── View ──────────────────────────────────────────────────────────────

    function balance() external view returns (uint256) {
        return timbs.balanceOf(address(this));
    }
}
