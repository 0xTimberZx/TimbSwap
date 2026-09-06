// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @dev Every mutator is table-scoped. The ledger holds the money, so the ledger —
 *      not the board — is what tracks whose money it is. `sweepTable` takes no
 *      amount on purpose: the board cannot reach another table's escrow because
 *      it cannot name a figure at all.
 */
interface IPoolLedger {
    function collect(address from, uint256 amount, uint256 tableId) external;
    function fundSeed(address from, uint256 amount, uint256 tableId) external;
    function creditWinnings(address[] calldata recipients,
                            uint256[] calldata amounts,
                            uint256 tableId) external;
    function refund(address to, uint256 amount, uint256 tableId) external;
    function sweepTable(address to, uint256 tableId) external returns (uint256);
    function tableEscrow(uint256 tableId) external view returns (uint256);
    // ── gen-6 ──
    function underwriteCredit(address from,
                              address[] calldata recipients,
                              uint256[] calldata amounts,
                              uint256 tableId) external;
    function moveCredit(address from, address to, uint256 amount) external;
    function sweepTablePartial(address to, uint256 tableId, uint256 amount) external;
}

/// @dev Gen-6 underwrite reserve (M1). `grantTopUp` clamps to its caps and
///      NEVER reverts on shortage — settlement must always complete.
interface IUnderwriteReserve {
    function grantTopUp(uint256 tableId, uint256 wanted) external returns (uint256 granted);
    function recordIncome(uint256 tableId, uint256 rakeShare, uint256 deadPots, uint256 treasuryShare) external;
}

interface ISeedRegistry {
    function markUsed(uint256 round) external;
}

interface IEntropy {
    function commitmentOf(bytes32 secret, bytes32 salt) external view returns (bytes32);
    function deriveEntropy(bytes32 commitment, bytes32 secret, uint256 lockBlock, bytes32 salt)
        external view returns (bytes32);
    function fallbackEntropy(uint256 lockBlock, bytes32 salt) external view returns (bytes32);
}

interface ITimbPrize {
    function roundWinningString(uint256 round) external view returns (bytes6);
}

/**
 * @title SegmentBoard
 * @notice The SwapTables roulette board: one immutable generation of segment
 *         tables. Seats players, holds their six per-segment tokens, settles the
 *         seven pools per table pari-mutuel, and retires at six.
 *         Spec: SwapTables/docs/SEGMENT_TABLES.md §5-§10, §13.
 *
 * Design:
 *   - Standalone and immutable. Funds live in PoolLedger; entropy in a swappable
 *     module; cross-generation seed uniqueness in the long-lived SeedRegistry.
 *     This contract owns only game state and the pari-mutuel math.
 *   - Seven pools per table: six segment pools (1-6) + the round-wide
 *     Double-Digit pool (index 6).
 *   - One token per segment per wallet (§4/§6.1), so a pool's distinct-wallet
 *     count IS its bet count — rake needs no dedup pass, and every settlement
 *     loop is bounded by SEATS_HARD_MAX.
 *   - Chips are fixed denominations, so a bet packs into a single storage slot.
 *   - The six segments run overlapping and synced on one clock (§10.3): they
 *     share the entry cutoff, bets-close and pick marks.
 *
 * Entropy (§10.1):
 *   Commitments are published at table open, before any bet. After the pick time
 *   anyone arms the table, recording a lock block; each segment then settles
 *   using blockhash(lockBlock) mixed with the revealed secret. The lock block is
 *   unknowable at bets-close, so nobody — the protocol included — can compute a
 *   char early (guard #1). Swaps never enter this contract (guard #2): the
 *   velocity envelope is display-only.
 *
 * Status:
 *   Generation 1 ran a full round live on Arbitrum Sepolia (2026-07-26): open ->
 *   seat -> load -> place -> arm -> six locks -> retire -> withdraw, with the
 *   ledger draining to exactly zero. Escrow conservation, the graduated rake
 *   (4.87% at two wallets vs 8% solo) and the §9 seed guard all reconciled to the
 *   wei. See SwapTables/docs/VALIDATION.md.
 *
 *   That run surfaced one way player funds could stick: a table that never reaches
 *   SEATS_MIN can never be armed, so it would never lock or retire and its loaded
 *   chips would be stranded. cancelTable() closes it — permissionless, refunds
 *   every chip, returns the seed. Deployed gen-1 predates it (see VALIDATION.md).
 *
 * Security:
 *   - Guardian may only halt new tables / new bets; it can never move funds,
 *     change an outcome, or block a withdrawal (those live in PoolLedger and are
 *     never pausable).
 *   - Owner is renounceable; at maturity both roles retire, leaving a
 *     zero-privilege generation (§13.2).
 */
contract SegmentBoard is Ownable, ReentrancyGuard {
    // ─── Constants ─────────────────────────────────────────────────────────────

    /// @notice A-Z then 0-9, the 36 pocket symbols.
    string constant ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    uint8 public constant SEGMENTS       = 6;
    uint8 public constant POOLS          = 7;   // 6 segment pools + Double-Digit
    uint8 public constant DD_POOL        = 6;   // index of the Double-Digit pool

    uint8 public constant SEATS_MIN      = 2;   // no solo tables (§9.2)
    uint8 public constant SEATS_HARD_MAX = 12;  // bounds every settlement loop
    uint8 public constant SEED_MIN_WALLETS = 2; // a pool draws seed only if contested (§9)

    uint256 public constant TABLE_SEED = 100e18;              // §9
    uint256 public constant SEED_SHARE = TABLE_SEED / POOLS;  // ~14 per pool

    uint256 public constant RAKE_BASE  = 800;   // 8.00% in bps (§8)
    uint256 public constant RAKE_FLOOR = 175;   // 1.75% in bps
    uint256 public constant BPS        = 10_000;

    // ── Gen-6 underwrite (UNDERWRITE_SPEC.md, M1) ──
    /// @notice Uniform target RTP: every underwritten bet returns 90% of fair.
    uint256 public constant PAYOUT_RATIO_BPS = 9000;
    /// @notice Max top-up per winning pool; the reserve holds the per-round
    ///         and reserve-fraction caps.
    uint256 public constant MAX_POOL_UNDERWRITE = 1000e18;

    /// @notice Weight scale for fair multiples (multiple = 36/symbols - 1).
    uint256 public constant WEIGHT_SCALE = 10_000;

    /// @notice Blocks after arming within which a reveal must land (< 256 so the
    ///         lock block hash is still retrievable).
    uint256 public constant REVEAL_WINDOW = 64;

    /// @notice How long `blockhash` can still see the lock block. Past this the
    ///         hash reads zero and BOTH settle paths fail, so the table must be
    ///         re-armed onto a fresh block (see rearmTable).
    /// @dev    Counted in L1 blocks: on Arbitrum `block.number` is the L1 block
    ///         number, so 256 blocks is ~51 minutes, not ~65 seconds.
    uint256 public constant BLOCKHASH_HORIZON = 256;

    /// @dev Pocket colouring: 18 red / 18 black over the ordered alphabet.
    ///      Bit i set => symbol i is red. Alternating gives the 18/18 split.
    ///      MUST be 36 bits wide (9 hex digits) to cover every symbol — a 32-bit
    ///      literal silently colours indices 32-35 black and breaks the split.
    uint64 constant RED_MASK = 0x1555555555;

    /// @dev Vowel set {A,E,I,O,U,Y} as alphabet-index bits.
    uint64 constant VOWEL_MASK =
        uint64((1 << 0) | (1 << 4) | (1 << 8) | (1 << 14) | (1 << 20) | (1 << 24));

    // Bet kinds
    uint8 public constant KIND_EXACTLY     = 0; // pick = symbol index
    uint8 public constant KIND_COLUMN      = 1; // pick = 0..2
    uint8 public constant KIND_DOZEN       = 2; // pick = 0..2
    uint8 public constant KIND_VOWELS      = 3;
    uint8 public constant KIND_COLOR       = 4; // pick = 0 red, 1 black
    uint8 public constant KIND_LETTER      = 5;
    uint8 public constant KIND_NUMBER      = 6;
    uint8 public constant KIND_LOWHIGH     = 7; // pick = 0 low, 1 high
    uint8 public constant KIND_YOURTICKET  = 8;
    uint8 public constant KIND_DOUBLEDIGIT = 9; // DD pool only
    uint8 constant KIND_COUNT = 10;

    // ─── State ─────────────────────────────────────────────────────────────────

    IPoolLedger        public immutable ledger;
    ISeedRegistry      public immutable seedRegistry;
    IEntropy           public immutable entropy;
    ITimbPrize         public immutable timbPrize;
    /// @notice Gen-6 underwrite reserve (M1): tops thin winners up toward
    ///         stake x fair x 0.90, funded by dead pots + half the rake.
    IUnderwriteReserve public immutable reserve;

    /// @notice Where leftovers are PUSHED at retire (rake, no-winner pots, dust).
    ///         Any address works, including a contract like TimbTreasury.
    address public immutable treasury;

    /**
     * @notice Where the table seed is PULLED from at openTable.
     * @dev Deliberately separate from `treasury`. Funding is a transferFrom, so
     *      this address must be able to call approve() on TIMBS — which a
     *      treasury *contract* generally cannot do unless it exposes a generic
     *      approve. Keeping the two apart lets sweeps still go to the real
     *      treasury while an ops wallet supplies the seed float.
     *
     *      Owner-settable, and safe to be: the seed funder can only ever be a
     *      source of funds it has itself approved. Pointing this at an address
     *      with no allowance makes openTable fail — a liveness effect, never a
     *      way to touch player escrow (§13.2). Locked forever once ownership is
     *      renounced.
     */
    address public seedFunder;

    // ── Gen-5 adaptive-entry dials (docs/GEN5_ADAPTIVE_ENTRY.md) ──────────
    /// @notice Hard ceiling: seats close at latest `openedAt + entryMax`.
    uint64 public immutable entryMax;
    /// @notice Quiet period after the last JOIN (sit or load) once the table
    ///         has quorum; entry closes when it elapses with no new join.
    ///         Measured from joins rather than sits alone so the join that
    ///         *forms* quorum cannot retroactively slam the door it opened.
    uint64 public immutable sitQuiet;
    /// @notice Max wait for a lone funded player before entry closes anyway.
    uint64 public immutable soloWait;
    /// @notice Entry close → bets close; the board stays open for placing.
    uint64 public immutable placeWindow;
    /// @notice Seconds before the pick when bets close (the committed drumroll).
    uint64 public immutable betsCloseLead;

    /// @dev Gen-4 app compatibility: the worst-case entry span.
    function entryWindow() external view returns (uint64) { return entryMax; }
    /// @dev Gen-4 app compatibility: the worst-case open→pick span.
    function pickDelay() external view returns (uint64) {
        return entryMax + placeWindow + betsCloseLead;
    }

    /// @notice Halt-only role: may pause new tables / new bets, nothing else.
    address public guardian;
    bool public newTablesHalted;
    bool public newBetsHalted;

    struct Table {
        uint64  openedAt;
        uint64  pickTime;
        uint64  lockBlock;   // 0 until armed
        uint32  seedRound;
        uint8   seatCount;
        uint8   lockedMask;  // bit i => segment i+1 locked
        bool    ddSettled;
        bool    retired;
        bytes6  seedString;
        bytes6  lockedChars;
        // ── gen-5 adaptive entry ──
        uint64  entryCloseAt; // authoritative close; only ever rewritten to a future time
        uint64  lastJoinAt;   // last sit OR load — resets the quiet timer
        uint64  firstLoadAt;  // starts the lone-player clock
        uint8   loadedCount;  // wallets that funded all six tokens
        // ── gen-6 ──
        address opener;       // the dealer: opened the table, receives tips (M6)
    }

    struct Seat {
        uint64 chipPack;   // byte i = chip index + 1 for segment i+1 (0 = unloaded)
        uint8  placedMask; // bit i => segment i+1 placed
        uint8  ddChip;     // chip index + 1 for a Double-Digit stake (0 = none)
        bool   seated;
        bytes6 ticket;     // the wallet's entry string, for Your-Ticket bets
    }

    struct Bet {
        address wallet;
        uint8   chipIdx;
        uint8   kind;
        uint8   pick;
    }

    uint256 public tableCount;

    mapping(uint256 => Table) public tables;
    mapping(uint256 => address[]) public seatList;

    // ── Gen-6 per-table settle accounting (kept out of the Table struct so
    //    the tables() tuple only grows by `opener`) ──
    /// @notice True rake shaved from pools that paid winners; split half to
    ///         the reserve, half to Treasury at retire.
    mapping(uint256 => uint256) public rakeAccrued;
    /// @notice Pots that settled with no winner; routed whole to the reserve
    ///         at retire (the GAME_ECONOMY waterfall's first call).
    mapping(uint256 => uint256) public deadPotAccrued;
    mapping(uint256 => mapping(address => Seat)) public seats;
    /// @notice tableId => poolId => bets in that pool (bounded by SEATS_HARD_MAX).
    mapping(uint256 => mapping(uint8 => Bet[])) internal _bets;
    /// @notice tableId => segment (1-6) => commitment published at open.
    mapping(uint256 => mapping(uint8 => bytes32)) public commitments;

    /// @notice Chip denominations in TIMBS (§4).
    uint256[7] public CHIPS = [
        5e18, 10e18, 25e18, 50e18, 100e18, 500e18, 1000e18
    ];

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error NotGuardian();
    error Halted();
    error TableUnknown();
    error TableClosedForEntry();
    error TableRetiredAlready();
    error AlreadySeated();
    error NotSeated();
    error TableFull();
    error NotEnoughSeats(uint8 seated, uint8 required);
    error BadChip();
    error NotLoaded();
    error AlreadyLoaded();
    error BetsClosed();
    error AlreadyPlaced(uint8 segment);
    error BadSegment();
    error BadKind();
    error BadPick();
    error NotYetPickTime();
    error NotArmed();
    error AlreadyArmed();
    error SameBlockAsArm();
    error SegmentAlreadyLocked(uint8 segment);
    error RevealWindowOpen();
    error SegmentsOutstanding();
    error EntryStillOpen();
    error TableCanProceed(uint8 seated, uint8 required);
    error LockBlockStillLive(uint256 lockBlock, uint256 expiresAt);
    error NothingLeftToLock();
    error SeedNotSettled(uint256 round);
    error BadDials(uint64 entryMax, uint64 placeWindow, uint64 betsCloseLead, uint64 sitQuiet, uint64 soloWait);

    // ─── Events ────────────────────────────────────────────────────────────────

    event TableOpened(uint256 indexed tableId, uint256 indexed seedRound, bytes6 seedString, uint64 pickTime);
    event EntryRescheduled(uint256 indexed tableId, uint64 entryCloseAt, uint64 pickTime);
    event Seated(uint256 indexed tableId, address indexed wallet);
    event TokensLoaded(uint256 indexed tableId, address indexed wallet, uint256 total);
    event BetPlaced(uint256 indexed tableId, uint8 indexed pool, address indexed wallet, uint8 kind, uint8 pick);
    event TableArmed(uint256 indexed tableId, uint256 lockBlock);
    event TableRearmed(uint256 indexed tableId, uint256 staleBlock, uint256 lockBlock);
    event SegmentLocked(uint256 indexed tableId, uint8 indexed segment, bytes1 lockedChar, bool viaFallback);
    event PoolSettled(uint256 indexed tableId, uint8 indexed pool, uint256 pot, uint256 rake, uint256 distributed);
    /// @notice A pool's winners were topped up from the reserve (M1). `wanted`
    ///         is the capped ask; `granted` what the reserve could cover —
    ///         the gap is the emitted shortfall the spec requires.
    event PoolUnderwritten(uint256 indexed tableId, uint8 indexed pool, uint256 wanted, uint256 granted);
    /// @notice A seated wallet tipped the table's opener (M6).
    event DealerTipped(uint256 indexed tableId, address indexed from, address indexed opener, uint256 amount);
    event TableRetired(uint256 indexed tableId, uint256 sweptToTreasury);
    event TableCancelled(uint256 indexed tableId, uint8 seated, uint256 refundedWallets, uint256 sweptToTreasury);
    event GuardianSet(address indexed guardian);
    event SeedFunderSet(address indexed seedFunder);
    event NewTablesHalted(bool halted);
    event NewBetsHalted(bool halted);

    // ─── Modifiers ─────────────────────────────────────────────────────────────

    /// @dev Do NOT special-case guardian == address(0) here. Skipping the check
    ///      when the role is vacant would make the halt functions permissionless
    ///      the moment the guardian retires — the opposite of retiring it. A plain
    ///      comparison is already terminal: nobody can transact as address(0).
    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(
        address _ledger,
        address _seedRegistry,
        address _entropy,
        address _timbPrize,
        address _reserve,
        address _treasury,
        address _seedFunder,
        address _guardian,
        uint64  _entryMax,
        uint64  _placeWindow,
        uint64  _betsCloseLead,
        uint64  _sitQuiet,
        uint64  _soloWait
    ) Ownable(msg.sender) {
        if (
            _ledger == address(0) || _seedRegistry == address(0) ||
            _entropy == address(0) || _timbPrize == address(0) ||
            _reserve == address(0) || _treasury == address(0)
        ) revert ZeroAddress();
        ledger       = IPoolLedger(_ledger);
        seedRegistry = ISeedRegistry(_seedRegistry);
        entropy      = IEntropy(_entropy);
        timbPrize    = ITimbPrize(_timbPrize);
        reserve      = IUnderwriteReserve(_reserve);
        treasury     = _treasury;
        seedFunder   = _seedFunder == address(0) ? _treasury : _seedFunder;
        guardian     = _guardian; // may be address(0) for a zero-privilege generation
        // The dials are immutable, so a bad set bricks the generation with no
        // recovery. Zero placeWindow closes bets the moment entry closes (late
        // loaders could never place); zero betsCloseLead lets bets ride into
        // the entropy window (§10 guard #1); zero quiet/solo timers close
        // entry the instant quorum forms. The schedule is always
        //   entryCloseAt → +placeWindow → betsClose → +betsCloseLead → pick,
        // so the gen-4 relation entryWindow ≤ pickDelay − betsCloseLead holds
        // by construction and needs no separate check.
        if (_entryMax == 0 || _placeWindow == 0 || _betsCloseLead == 0 ||
            _sitQuiet == 0 || _soloWait == 0 ||
            _sitQuiet > _entryMax || _soloWait > _entryMax) {
            revert BadDials(_entryMax, _placeWindow, _betsCloseLead, _sitQuiet, _soloWait);
        }
        entryMax      = _entryMax;
        placeWindow   = _placeWindow;
        betsCloseLead = _betsCloseLead;
        sitQuiet      = _sitQuiet;
        soloWait      = _soloWait;
    }

    // ─── Table lifecycle ───────────────────────────────────────────────────────

    /**
     * @notice Open a table on a fresh TimbPrize winning string. The seed round is
     *         marked used in the cross-generation registry, so no string ever
     *         seeds two tables. Commitments for all six segments are published
     *         here — before any bet can be placed.
     */
    function openTable(uint256 seedRound, bytes32[6] calldata segmentCommitments)
        external
        nonReentrant
        returns (uint256 tableId)
    {
        if (newTablesHalted) revert Halted();

        bytes6 seedString = timbPrize.roundWinningString(seedRound);
        if (seedString == bytes6(0)) revert SeedNotSettled(seedRound);

        // Consume the round; reverts if any generation already used it.
        seedRegistry.markUsed(seedRound);

        tableId = ++tableCount;
        Table storage t = tables[tableId];
        t.openedAt     = uint64(block.timestamp);
        t.entryCloseAt = uint64(block.timestamp) + entryMax;   // ceiling; joins pull it in
        t.pickTime     = t.entryCloseAt + placeWindow + betsCloseLead;
        t.lastJoinAt   = uint64(block.timestamp);
        t.seedRound  = uint32(seedRound);
        t.seedString = seedString;
        t.opener     = msg.sender; // the dealer — receives tips (M6)

        for (uint8 i; i < SEGMENTS; ++i) {
            commitments[tableId][i + 1] = segmentCommitments[i];
        }

        // House seed float for the table's pools.
        ledger.fundSeed(seedFunder, TABLE_SEED, tableId);

        emit TableOpened(tableId, seedRound, seedString, t.pickTime);
        return tableId;
    }

    /// @notice Take a seat before the entry cutoff. `ticket` is the wallet's entry
    ///         string, used only to resolve Your-Ticket bets.
    function sit(uint256 tableId, bytes6 ticket) external {
        Table storage t = _liveTable(tableId);
        if (block.timestamp >= t.entryCloseAt) revert TableClosedForEntry();
        if (t.seatCount >= SEATS_HARD_MAX) revert TableFull();

        Seat storage s = seats[tableId][msg.sender];
        if (s.seated) revert AlreadySeated();
        s.seated = true;
        s.ticket = ticket;
        ++t.seatCount;
        seatList[tableId].push(msg.sender);

        t.lastJoinAt = uint64(block.timestamp);
        _rescheduleEntry(t, tableId);

        emit Seated(tableId, msg.sender);
    }

    /**
     * @notice Load all six segment tokens with chips before placing (§4:
     *         load-all-six-first). `chipIdxs[i]` indexes CHIPS for segment i+1.
     */
    function loadTokens(uint256 tableId, uint8[6] calldata chipIdxs) external nonReentrant {
        Table storage t = _liveTable(tableId);
        // Gen-5 late loading: seated before entry closes, fund any time before
        // bets close (docs/GEN5_ADAPTIVE_ENTRY.md §2). Placing has always had
        // this same deadline, so pool composition is unaffected.
        if (block.timestamp + betsCloseLead >= t.pickTime) revert BetsClosed();

        Seat storage s = seats[tableId][msg.sender];
        if (!s.seated)        revert NotSeated();
        if (s.chipPack != 0)  revert AlreadyLoaded();

        uint256 total;
        uint64  pack;
        for (uint8 i; i < SEGMENTS; ++i) {
            uint8 c = chipIdxs[i];
            if (c >= CHIPS.length) revert BadChip();
            total += CHIPS[c];
            pack  |= uint64(uint64(c) + 1) << (8 * i);
        }
        s.chipPack = pack;
        if (t.firstLoadAt == 0) t.firstLoadAt = uint64(block.timestamp);
        ++t.loadedCount;
        t.lastJoinAt = uint64(block.timestamp);
        _rescheduleEntry(t, tableId);
        ledger.collect(msg.sender, total, tableId);

        emit TokensLoaded(tableId, msg.sender, total);
    }

    /**
     * @dev Adaptive entry (gen-5): pull `entryCloseAt` forward once the table
     *      can actually play, push it out (never past the ceiling) while joins
     *      keep arriving. Rules, earliest wins:
     *        quorum (2+ loaded): lastJoinAt + sitQuiet
     *        lone funded player: firstLoadAt + soloWait
     *        always:             openedAt + entryMax  (ceiling)
     *      Never touches a closed window and never writes the past, so the
     *      schedule is monotone from any player's point of view. The whole
     *      downstream timeline rides on it:
     *        betsClose = entryCloseAt + placeWindow, pick = betsClose + lead.
     */
    function _rescheduleEntry(Table storage t, uint256 tableId) internal {
        uint64 nowTs = uint64(block.timestamp);
        if (nowTs >= t.entryCloseAt) return;         // window already shut
        uint64 candidate;
        if (t.loadedCount >= SEATS_MIN)      candidate = t.lastJoinAt + sitQuiet;
        else if (t.loadedCount == 1)         candidate = t.firstLoadAt + soloWait;
        else return;                                  // nobody funded: ceiling stands
        uint64 ceiling = t.openedAt + entryMax;
        if (candidate > ceiling) candidate = ceiling;
        if (candidate < nowTs)   candidate = nowTs;   // future-only writes
        if (candidate == t.entryCloseAt) return;
        t.entryCloseAt = candidate;
        t.pickTime     = candidate + placeWindow + betsCloseLead;
        emit EntryRescheduled(tableId, candidate, t.pickTime);
    }

    /// @notice Place a loaded token on a board spot for its segment.
    function place(uint256 tableId, uint8 segment, uint8 kind, uint8 pick) external {
        Table storage t = _liveTable(tableId);
        if (newBetsHalted) revert Halted();
        if (segment == 0 || segment > SEGMENTS) revert BadSegment();
        if (block.timestamp + betsCloseLead >= t.pickTime) revert BetsClosed();

        Seat storage s = seats[tableId][msg.sender];
        if (!s.seated)       revert NotSeated();
        if (s.chipPack == 0) revert NotLoaded();

        uint8 bit = uint8(1) << (segment - 1);
        if (s.placedMask & bit != 0) revert AlreadyPlaced(segment);
        if (kind >= KIND_COUNT || kind == KIND_DOUBLEDIGIT) revert BadKind();
        _validatePick(kind, pick);

        s.placedMask |= bit;
        uint8 chipIdx = uint8((s.chipPack >> (8 * (segment - 1))) & 0xFF) - 1;

        _bets[tableId][segment - 1].push(
            Bet({wallet: msg.sender, chipIdx: chipIdx, kind: kind, pick: pick})
        );

        emit BetPlaced(tableId, segment - 1, msg.sender, kind, pick);
    }

    /**
     * @notice Place the round-wide Double-Digit bet: wins if the finished six-char
     *         string contains any repeated symbol. Separate stake from the six
     *         segment tokens; one per wallet.
     */
    function placeDoubleDigit(uint256 tableId, uint8 chipIdx) external nonReentrant {
        Table storage t = _liveTable(tableId);
        if (newBetsHalted) revert Halted();
        if (block.timestamp + betsCloseLead >= t.pickTime) revert BetsClosed();
        if (chipIdx >= CHIPS.length) revert BadChip();

        Seat storage s = seats[tableId][msg.sender];
        if (!s.seated)       revert NotSeated();
        // Gen-7: the Repeats-a-Digit stake is a BONUS chip — it rides a full
        // load, it is not a way to play the round-wide pool on its own. Until
        // now `place` required a load (NotLoaded) but this did not, so a
        // seated wallet that never funded could still buy into the DD pool
        // and, with the jackpot live, into a jackpot strike. Same rule for
        // both bet paths now; late loading (gen-5) still applies, so funding
        // any time before bets close earns the bonus chip.
        if (s.chipPack == 0) revert NotLoaded();
        if (s.ddChip != 0)   revert AlreadyPlaced(DD_POOL);

        s.ddChip = chipIdx + 1;
        ledger.collect(msg.sender, CHIPS[chipIdx], tableId);

        _bets[tableId][DD_POOL].push(
            Bet({wallet: msg.sender, chipIdx: chipIdx, kind: KIND_DOUBLEDIGIT, pick: 0})
        );

        emit BetPlaced(tableId, DD_POOL, msg.sender, KIND_DOUBLEDIGIT, 0);
    }

    // ─── The pick ──────────────────────────────────────────────────────────────

    /**
     * @notice Arm the table at/after its pick time, recording the lock block.
     *         Permissionless. The recorded block's hash is unknowable now (it is
     *         the block being mined) and only becomes readable afterwards, so no
     *         party could have derived a char at bets-close.
     */
    function armTable(uint256 tableId) external {
        Table storage t = _liveTable(tableId);
        if (block.timestamp < t.pickTime) revert NotYetPickTime();
        if (t.lockBlock != 0)             revert AlreadyArmed();
        if (t.loadedCount < SEATS_MIN)    revert NotEnoughSeats(t.loadedCount, SEATS_MIN);
        t.lockBlock = uint64(block.number);
        emit TableArmed(tableId, block.number);
    }

    /**
     * @notice Re-arm a table whose lock block has aged out. Permissionless.
     * @dev `blockhash` only reaches back BLOCKHASH_HORIZON blocks. Past that the
     *      hash reads zero and BOTH lockSegment and lockSegmentFallback revert,
     *      while retire() still demands all six segments — so an un-settled table
     *      would jam permanently with every bet inside it.
     *
     *      On the size of that window: an earlier note here put it at ~65s, from
     *      Arbitrum's ~0.25s L2 block time. That is wrong. On Arbitrum
     *      `block.number` is the *L1* block number, not the L2 one, so both
     *      REVEAL_WINDOW and BLOCKHASH_HORIZON count L1 blocks at ~12s:
     *
     *        REVEAL_WINDOW      64 blocks  ~13 minutes
     *        BLOCKHASH_HORIZON 256 blocks  ~51 minutes
     *
     *      Measured live on 2026-07-27: table 3 armed at L1 block 11359219 and
     *      was still inside the reveal window 12 minutes later (~11-12s/block).
     *      So this is a slow leak rather than the near-instant trap the old
     *      comment described — but still real: an operator who loses the reveal
     *      has under an hour to recover, and no second chance after.
     *
     *      Re-arming records a fresh lock block and the remaining segments settle
     *      against it. Guard #1 is unaffected: bets closed long before, so the new
     *      block hash is just as unknowable to everyone as the old one.
     *
     *      Caveat: whoever re-arms gets new randomness for the unsettled
     *      segments, so a party who could suppress everyone else for a full
     *      horizon could grind. That is bounded by this being permissionless —
     *      from REVEAL_WINDOW onward anyone may settle via the fallback, so a
     *      griefer has to win every race for ~192 blocks to reroll once.
     */
    function rearmTable(uint256 tableId) external {
        Table storage t = _liveTable(tableId);
        if (t.lockBlock == 0)     revert NotArmed();
        if (t.lockedMask == 0x3F) revert NothingLeftToLock();

        uint256 expiresAt = t.lockBlock + BLOCKHASH_HORIZON;
        if (block.number <= expiresAt) {
            revert LockBlockStillLive(t.lockBlock, expiresAt);
        }

        uint256 stale = t.lockBlock;
        t.lockBlock = uint64(block.number);
        emit TableRearmed(tableId, stale, block.number);
    }

    /// @notice Lock a segment by revealing its secret, then settle its pool.
    function lockSegment(uint256 tableId, uint8 segment, bytes32 secret)
        external
        nonReentrant
    {
        Table storage t = _prepLock(tableId, segment);
        bytes32 e = entropy.deriveEntropy(
            commitments[tableId][segment],
            secret,
            t.lockBlock,
            _salt(tableId, segment)
        );
        _applyLock(tableId, t, segment, e, false);
    }

    /**
     * @notice Permissionless fallback once the reveal window has passed: fix the
     *         char from the lock block hash alone so a table can never stall.
     */
    function lockSegmentFallback(uint256 tableId, uint8 segment)
        external
        nonReentrant
    {
        Table storage t = _prepLock(tableId, segment);
        if (block.number <= t.lockBlock + REVEAL_WINDOW) revert RevealWindowOpen();
        bytes32 e = entropy.fallbackEntropy(t.lockBlock, _salt(tableId, segment));
        _applyLock(tableId, t, segment, e, true);
    }

    function _prepLock(uint256 tableId, uint8 segment) internal view returns (Table storage t) {
        t = _liveTable(tableId);
        if (segment == 0 || segment > SEGMENTS) revert BadSegment();
        if (t.lockBlock == 0)                   revert NotArmed();
        if (block.number <= t.lockBlock)        revert SameBlockAsArm();
        if (t.lockedMask & (uint8(1) << (segment - 1)) != 0) {
            revert SegmentAlreadyLocked(segment);
        }
        return t;
    }

    function _applyLock(
        uint256 tableId,
        Table storage t,
        uint8 segment,
        bytes32 e,
        bool viaFallback
    ) internal {
        uint8 idx = uint8(uint256(e) % 36); // ALPHABET has 36 characters
        bytes1 c = bytes(ALPHABET)[idx];

        // Write the char into the accumulating six-char string. A byte of a
        // fixed bytesN cannot be assigned directly, so splice it numerically:
        // byte 0 of a bytes6 is the most significant, hence the (5 - i) shift.
        uint256 shift  = 8 * (5 - uint256(segment - 1));
        uint256 packed = uint256(uint48(t.lockedChars));
        packed = (packed & ~(uint256(0xFF) << shift)) | (uint256(uint8(c)) << shift);
        t.lockedChars = bytes6(uint48(packed));
        t.lockedMask |= uint8(1) << (segment - 1);

        emit SegmentLocked(tableId, segment, c, viaFallback);

        _settlePool(tableId, segment - 1, idx, false);

        // Double-Digit needs the complete string, so it settles on the sixth lock.
        if (t.lockedMask == 0x3F && !t.ddSettled) {
            t.ddSettled = true;
            _settlePool(tableId, DD_POOL, 0, _hasRepeat(t.lockedChars));
        }
    }

    // ─── Settlement (pari-mutuel, §6) ──────────────────────────────────────────

    /**
     * @dev Settle one pool. Loops are bounded by SEATS_HARD_MAX because a wallet
     *      holds one token per segment, so a pool can hold at most one bet per
     *      seat — which also means bet count == distinct wallets for the rake.
     */
    function _settlePool(uint256 tableId, uint8 pool, uint8 charIdx, bool ddWins) internal {
        Bet[] storage bs = _bets[tableId][pool];
        uint256 n = bs.length;
        if (n == 0) {
            // Nobody played this pool: its seed share (if any) stays in the
            // table's escrow and sweeps to Treasury at retire.
            emit PoolSettled(tableId, pool, 0, 0, 0);
            return;
        }

        uint256 pot = _potOf(bs, n);
        // rake(n) = FLOOR + (BASE - FLOOR)/n, n = distinct wallets == bet count (§8).
        // Gen-5 (UNDERWRITE_SPEC Layer 0): an uncontested pool is not raked —
        // the rake prices a contest, and a solo pool has nothing in it but the
        // player's own chip. Solo winners take par instead of 0.92x.
        uint256 rakeBps = n >= SEED_MIN_WALLETS
            ? RAKE_FLOOR + (RAKE_BASE - RAKE_FLOOR) / n
            : 0;
        uint256 distributable = (pot * (BPS - rakeBps)) / BPS;

        (address[] memory who, uint256[] memory amt, uint256 totalWeight) =
            _weigh(tableId, pool, charIdx, ddWins);

        uint256 distributed;
        if (totalWeight > 0) {
            for (uint256 i; i < n; ++i) {
                if (amt[i] == 0) continue;
                uint256 pay = (distributable * amt[i]) / totalWeight;
                amt[i] = pay;
                distributed += pay;
            }
            ledger.creditWinnings(who, amt, tableId);
            // What the pool kept from its winners is true rake (rounding dust
            // included); at retire it splits half reserve / half Treasury.
            rakeAccrued[tableId] += pot - distributed;
            _underwrite(tableId, pool, who, amt);
        } else {
            // No winners → the whole pot is a dead pot: it stays in the
            // table's escrow and routes to the reserve at retire (the
            // GAME_ECONOMY waterfall's first call).
            deadPotAccrued[tableId] += pot;
        }

        emit PoolSettled(tableId, pool, pot, pot - distributed, distributed);
    }

    /**
     * @dev Gen-6 M1 (UNDERWRITE_SPEC): top each winner up toward
     *      `stake x fair x PAYOUT_RATIO`. The pool has already paid what it
     *      could; the reserve covers the shortfall, so a joiner can only ever
     *      raise an existing player's payout (the monotonicity law). Once the
     *      pool alone clears the target the ask is zero and the mechanism
     *      fades out exactly where pari-mutuel starts working on its own.
     *
     *      Caps: per pool here (MAX_POOL_UNDERWRITE, allocated in bet order),
     *      per round + reserve fraction inside grantTopUp. Double-Digit is
     *      NOT underwritten (decision 2026-07-31): it is round-wide, the
     *      rarest outcome, and the Rolling Jackpot (M2) is its mechanism.
     *      Never reverts — an empty or halted reserve grants zero and the
     *      pool's own payout stands.
     *
     *      `amt` holds each winner's pool payout on entry and is REUSED to
     *      carry the top-ups into underwriteCredit (losers stay zero).
     */
    function _underwrite(uint256 tableId, uint8 pool, address[] memory who, uint256[] memory amt) internal {
        if (pool == DD_POOL) return;

        Bet[] storage bs = _bets[tableId][pool];
        uint256 n = who.length;
        uint256 capLeft = MAX_POOL_UNDERWRITE;
        uint256 wantedTotal;
        for (uint256 i; i < n; ++i) {
            uint256 poolPay = amt[i];
            amt[i] = 0;                    // reuse: now the top-up slot
            if (poolPay == 0) continue;    // loser
            Bet storage b = bs[i];
            uint256 stake  = CHIPS[b.chipIdx];
            // fair total multiple = weight + 1 (both WEIGHT_SCALE-scaled)
            uint256 target = (stake * (_weightBps(b.kind) + WEIGHT_SCALE) / WEIGHT_SCALE)
                             * PAYOUT_RATIO_BPS / BPS;
            if (poolPay >= target) continue;
            uint256 wanted = target - poolPay;
            if (wanted > capLeft) wanted = capLeft;
            if (wanted == 0) continue;
            amt[i] = wanted;
            wantedTotal += wanted;
            capLeft     -= wanted;
        }
        if (wantedTotal == 0) return;

        uint256 granted = reserve.grantTopUp(tableId, wantedTotal);
        if (granted < wantedTotal) {
            // Allocate what was granted in bet order — first-settled-first-
            // served, same rule the round cap uses across pools.
            uint256 left = granted;
            for (uint256 i; i < n; ++i) {
                if (amt[i] == 0) continue;
                if (amt[i] > left) amt[i] = left;
                left -= amt[i];
            }
        }
        if (granted > 0) {
            ledger.underwriteCredit(address(reserve), who, amt, tableId);
        }
        emit PoolUnderwritten(tableId, pool, wantedTotal, granted);
    }

    /// @dev Pot = every chip in the pool, plus the seed share if the pool is
    ///      contested (>= SEED_MIN_WALLETS distinct wallets, §9).
    function _potOf(Bet[] storage bs, uint256 n) internal view returns (uint256) {
        uint256 pot;
        for (uint256 i; i < n; ++i) {
            pot += CHIPS[bs[i].chipIdx];
        }
        if (n >= SEED_MIN_WALLETS) pot += SEED_SHARE;
        return pot;
    }

    /// @dev Resolve winners and stash their raw weights (stake x fair multiple).
    function _weigh(uint256 tableId, uint8 pool, uint8 charIdx, bool ddWins)
        internal
        view
        returns (address[] memory who, uint256[] memory amt, uint256 totalWeight)
    {
        Bet[] storage bs = _bets[tableId][pool];
        uint256 n = bs.length;
        who = new address[](n);
        amt = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            Bet storage b = bs[i];
            address wallet = b.wallet;
            who[i] = wallet;
            bool won;
            if (pool == DD_POOL) {
                won = ddWins;
            } else {
                // pool == segment - 1, so it indexes the ticket's char directly
                bytes1 tc = _getTicketChar(tableId, wallet, pool);
                won = _wins(b.kind, b.pick, charIdx, tc);
            }
            if (won) {
                uint256 weight = CHIPS[b.chipIdx] * _weightBps(b.kind);
                amt[i] = weight;
                totalWeight += weight;
            } else {
                amt[i] = 0;
            }
        }
        return (who, amt, totalWeight);
    }

    function _getTicketChar(uint256 tableId, address wallet, uint8 pool) internal view returns (bytes1) {
        Seat storage s = seats[tableId][wallet];
        return s.ticket[pool];
    }

    // ─── Retire (§7) ───────────────────────────────────────────────────────────

    /**
     * @notice Retire a table once all six segments are locked: dislodge unplayed
     *         chips back to their owners and sweep every leftover (rake,
     *         no-winner pots, forfeited seed, dust) to Treasury.
     */
    function retire(uint256 tableId) external nonReentrant {
        Table storage t = _liveTable(tableId);
        if (t.lockedMask != 0x3F) revert SegmentsOutstanding();

        address[] storage list = seatList[tableId];
        uint256 len = list.length; // bounded by SEATS_HARD_MAX
        for (uint256 i; i < len; ++i) {
            Seat storage s = seats[tableId][list[i]];
            if (s.chipPack == 0) continue;
            uint256 owed;
            for (uint8 g; g < SEGMENTS; ++g) {
                if (s.placedMask & (uint8(1) << g) != 0) continue; // rode a bet
                uint8 packed = uint8((s.chipPack >> (8 * g)) & 0xFF);
                if (packed == 0) continue;
                owed += CHIPS[packed - 1];
            }
            if (owed > 0) ledger.refund(list[i], owed, tableId);
        }

        t.retired = true;

        // Gen-6 split (GAME_ECONOMY flow of funds): every dead pot plus half
        // the rake routes to the reserve — the income that matches the top-up
        // liability by activity. The rest (rake's other half, unconsumed seed
        // shares, dust) sweeps to Treasury as before. Both figures are this
        // table's own escrow; another live table's stake is unreachable here.
        uint256 dead     = deadPotAccrued[tableId];
        uint256 rakeHalf = rakeAccrued[tableId] / 2;
        uint256 toReserve = dead + rakeHalf;
        uint256 esc = ledger.tableEscrow(tableId);
        if (toReserve > esc) toReserve = esc; // defensive: retire never reverts
        if (toReserve > 0) {
            ledger.sweepTablePartial(address(reserve), tableId, toReserve);
        }
        uint256 leftover = ledger.sweepTable(treasury, tableId);
        reserve.recordIncome(tableId, rakeHalf, dead, leftover);

        emit TableRetired(tableId, leftover);
    }

    // ─── Tip the dealer (gen-6 M6, docs/GEN6_DEALER_TIP.md) ───────────────────

    /**
     * @notice Tip the wallet that opened this table. Seated wallets only, and
     *         only after ALL SIX segments are locked — while any segment is
     *         unrevealed a transfer to the dealer could read as paying to
     *         influence a reveal; after 6/6 the outcome is sealed, so a tip
     *         can only be gratitude. Stays open after retire on purpose: a
     *         player withdrawing next morning can still tip.
     * @dev Credit-to-credit only (decision 2026-07-31): the ledger moves the
     *      amount between two credit balances — no rake, no minimum, no cap,
     *      and the escrow invariant is untouched by construction.
     */
    function tipDealer(uint256 tableId, uint256 amount) external {
        Table storage t = tables[tableId];
        if (t.openedAt == 0)      revert TableUnknown();
        if (t.lockedMask != 0x3F) revert SegmentsOutstanding();
        if (!seats[tableId][msg.sender].seated) revert NotSeated();
        ledger.moveCredit(msg.sender, t.opener, amount); // reverts if credit < amount
        emit DealerTipped(tableId, msg.sender, t.opener, amount);
    }

    /**
     * @notice Cancel a table that never filled. Permissionless.
     * @dev A table below SEATS_MIN can never be armed (§10.3), so it would never
     *      lock, never retire, and any chips already loaded would be stranded —
     *      the one way player funds could stick. This is the escape hatch: past
     *      the entry cutoff with too few seats, anyone may cancel.
     *
     *      Every chip is refunded, placed or not, because nothing settled — no
     *      char was ever locked, so no bet can have won or lost. The seed then
     *      returns to the CURRENT seedFunder — not the treasury — because a
     *      cancelled table had no round and earned no rake: the float goes back
     *      where it was pulled from, so cancels never drain the ops wallet.
     *      (Retire is different: a played table's leftovers are protocol revenue
     *      and sweep to Treasury.) Bounded by SEATS_HARD_MAX like every other
     *      settlement loop.
     */
    function cancelTable(uint256 tableId) external nonReentrant {
        Table storage t = _liveTable(tableId);
        if (block.timestamp < t.entryCloseAt) revert EntryStillOpen();
        if (t.loadedCount >= SEATS_MIN) {
            revert TableCanProceed(t.loadedCount, SEATS_MIN);
        }
        // Unreachable while armTable enforces SEATS_MIN, but asserted so the
        // "nothing settled" premise above can never quietly stop holding.
        if (t.lockBlock != 0) revert AlreadyArmed();

        address[] storage list = seatList[tableId];
        uint256 len = list.length;
        uint256 refunded;
        for (uint256 i; i < len; ++i) {
            Seat storage s = seats[tableId][list[i]];
            uint256 owed;
            for (uint8 g; g < SEGMENTS; ++g) {
                uint8 packed = uint8((s.chipPack >> (8 * g)) & 0xFF);
                if (packed == 0) continue;
                owed += CHIPS[packed - 1];
            }
            if (s.ddChip != 0) owed += CHIPS[s.ddChip - 1];
            if (owed > 0) {
                ledger.refund(list[i], owed, tableId);
                unchecked { ++refunded; }
            }
        }

        t.retired = true;

        uint256 leftover = ledger.sweepTable(seedFunder, tableId); // the seed

        emit TableCancelled(tableId, t.seatCount, refunded, leftover);
    }

    // ─── Guardian: halt only ───────────────────────────────────────────────────

    /// @notice Halt/resume opening new tables. Cannot touch funds or outcomes.
    function setNewTablesHalted(bool halted) external onlyGuardian {
        newTablesHalted = halted;
        emit NewTablesHalted(halted);
    }

    /// @notice Halt/resume new bets. Settlement, retire and PoolLedger
    ///         withdrawals all keep working while halted.
    function setNewBetsHalted(bool halted) external onlyGuardian {
        newBetsHalted = halted;
        emit NewBetsHalted(halted);
    }

    /// @notice Retire the guardian role permanently (one-way, §13.2).
    function retireGuardian() external onlyGuardian {
        guardian = address(0);
        emit GuardianSet(address(0));
    }

    // ─── Owner: config ─────────────────────────────────────────────────────────

    /**
     * @notice Point the seed pull at a different funder (must be able to approve
     *         TIMBS for the ledger). Cannot touch escrow; see `seedFunder`.
     *         Locked forever once ownership is renounced.
     */
    function setSeedFunder(address _seedFunder) external onlyOwner {
        if (_seedFunder == address(0)) revert ZeroAddress();
        seedFunder = _seedFunder;
        emit SeedFunderSet(_seedFunder);
    }

    /// @notice Replace the guardian. Locked forever once ownership is renounced.
    function setGuardian(address _guardian) external onlyOwner {
        guardian = _guardian;
        emit GuardianSet(_guardian);
    }

    // ─── View ──────────────────────────────────────────────────────────────────

    function betCount(uint256 tableId, uint8 pool) external view returns (uint256) {
        return _bets[tableId][pool].length;
    }

    function betAt(uint256 tableId, uint8 pool, uint256 i) external view returns (Bet memory) {
        return _bets[tableId][pool][i];
    }

    /// @notice The fair-multiple weight for a bet kind, scaled by WEIGHT_SCALE.
    function weightBps(uint8 kind) external pure returns (uint256) {
        return _weightBps(kind);
    }

    /// @notice Whether the finished string has any repeated symbol (Double-Digit).
    function hasRepeat(bytes6 s) external pure returns (bool) {
        return _hasRepeat(s);
    }

    /// @notice Whether the symbol at alphabet index `idx` is a red pocket.
    function isRed(uint8 idx) external pure returns (bool) {
        return ((RED_MASK >> idx) & 1) != 0;
    }

    /// @notice The table's six-char string so far; unlocked slots read as 0x00.
    function lockedCharsOf(uint256 tableId) external view returns (bytes6) {
        return tables[tableId].lockedChars;
    }

    // ─── Commitment helpers (operator safety) ──────────────────────────────────
    //
    // A commitment is bound to the table id it will be opened under. Computing it
    // against the wrong id is silent: the table opens and takes bets, then EVERY
    // lockSegment reverts BadReveal and the round can only be settled by the
    // fallback. These views remove that whole class of mistake — derive the
    // commitments on-chain instead of hand-encoding the salt off-chain.

    /// @notice The id the next openTable() will assign. Compute commitments for
    ///         THIS id, not the current tableCount.
    function nextTableId() external view returns (uint256) {
        return tableCount + 1;
    }

    /// @notice The salt binding a commitment to one table+segment.
    function saltFor(uint256 tableId, uint8 segment) external pure returns (bytes32) {
        return _salt(tableId, segment);
    }

    /// @notice The exact commitment to pass to openTable() for `segment` of
    ///         `tableId`, given the secret you will later reveal. Delegates to the
    ///         entropy module so the two can never drift apart.
    function commitmentFor(bytes32 secret, uint256 tableId, uint8 segment)
        external
        view
        returns (bytes32)
    {
        return entropy.commitmentOf(secret, _salt(tableId, segment));
    }

    /// @notice All six commitments for `tableId`, ready to pass straight into
    ///         openTable(). Secrets must be supplied in segment order 1-6.
    function commitmentsFor(bytes32[6] calldata secrets, uint256 tableId)
        external
        view
        returns (bytes32[6] memory cs)
    {
        for (uint8 i; i < SEGMENTS; ++i) {
            cs[i] = entropy.commitmentOf(secrets[i], _salt(tableId, i + 1));
        }
    }

    // ─── Internal helpers ────────────────────────────────────────────────────

    function _liveTable(uint256 tableId) internal view returns (Table storage t) {
        if (tableId == 0 || tableId > tableCount) revert TableUnknown();
        t = tables[tableId];
        if (t.retired) revert TableRetiredAlready();
        return t;
    }

    /// @dev encodePacked is safe here — both operands are fixed-size, so the
    ///      encoding is unambiguous and no collision is possible. It must also stay
    ///      encodePacked to match the deployed board and every published salt.
    function _salt(uint256 tableId, uint8 segment) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(tableId, segment));
    }

    /// @dev fair multiple = 36/symbols - 1, scaled by WEIGHT_SCALE.
    function _weightBps(uint8 kind) internal pure returns (uint256) {
        if (kind == KIND_EXACTLY || kind == KIND_YOURTICKET) return 35 * WEIGHT_SCALE;      // 1 symbol
        if (kind == KIND_COLUMN  || kind == KIND_DOZEN)      return 2 * WEIGHT_SCALE;       // 12
        if (kind == KIND_VOWELS)                             return 5 * WEIGHT_SCALE;       // 6
        if (kind == KIND_COLOR   || kind == KIND_LOWHIGH)    return WEIGHT_SCALE;           // 18
        if (kind == KIND_LETTER)                             return (10 * WEIGHT_SCALE) / 26; // 26 symbols -> 0.3846:1
        if (kind == KIND_NUMBER)                             return (26 * WEIGHT_SCALE) / 10; // 10 symbols -> 2.6:1
        if (kind == KIND_DOUBLEDIGIT)                        return (18 * WEIGHT_SCALE) / 10; // 1.8:1
        revert BadKind();
    }

    function _validatePick(uint8 kind, uint8 pick) internal pure {
        if (kind == KIND_EXACTLY) {
            if (pick >= 36) revert BadPick();
        } else if (kind == KIND_COLUMN || kind == KIND_DOZEN) {
            if (pick > 2) revert BadPick();
        } else if (kind == KIND_COLOR || kind == KIND_LOWHIGH) {
            if (pick > 1) revert BadPick();
        } else if (pick != 0) {
            // every remaining kind is a set bet and carries no pick; catch-all so
            // a future kind cannot silently accept a junk pick
            revert BadPick();
        }
    }

    function _wins(uint8 kind, uint8 pick, uint8 idx, bytes1 ticketChar)
        internal
        pure
        returns (bool won)
    {
        if (kind == KIND_EXACTLY)  return idx == pick;
        if (kind == KIND_COLUMN)   return idx % 3 == pick;
        if (kind == KIND_DOZEN)    return idx / 12 == pick;
        if (kind == KIND_VOWELS)   return ((VOWEL_MASK >> idx) & 1) != 0;
        if (kind == KIND_COLOR) {
            bool red = ((RED_MASK >> idx) & 1) != 0;
            return pick == 0 ? red : !red;
        }
        if (kind == KIND_LETTER)   return idx < 26;
        if (kind == KIND_NUMBER)   return idx >= 26;
        if (kind == KIND_LOWHIGH)  return pick == 0 ? idx < 18 : idx >= 18;
        if (kind == KIND_YOURTICKET) return ticketChar == bytes(ALPHABET)[idx];
        return false;
    }

    function _hasRepeat(bytes6 s) internal pure returns (bool) {
        for (uint256 i = 0; i < 6; ++i) {
            for (uint256 j = i + 1; j < 6; ++j) {
                if (s[i] == s[j]) return true;
            }
        }
        return false;
    }
}
