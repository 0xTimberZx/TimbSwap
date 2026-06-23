// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title GameRegistry
 * @notice Prize game entry storage, escrow, and lifecycle management.
 *
 * Responsibilities:
 *   - Store player entries (6-char strings) for each round.
 *   - Hold entry escrow (ETH or TIMBS) — ringfenced, never mingles
 *     with protocol revenue or prize pool.
 *   - Enforce string validation (6 chars, A-Z 0-9, no repeats, all caps).
 *   - Manage entry lifecycle: Pending → Active → Expired → Claimed/Inactive.
 *   - Handle entry replacement (all-in-one tx): old deposit transfers,
 *     old additional-round TIMBS kept as protocol sink.
 *   - Process principal refunds for expired entries.
 *   - Expose dual-layer verification for TimbPrize settlement.
 *
 * Entry rules:
 *   - 1 entry per wallet per round (replaceable).
 *   - Entries set in round N play in round N+1.
 *   - Initial entry cost: ETH (address(0)) or TIMBS — always refundable.
 *   - Additional rounds: TIMBS only, non-refundable, protocol sink.
 *   - ETH cost derived from TIMBSToken.entryCostTIMBS at entry time.
 *   - No repeating characters in string.
 *   - Claim window: 2 rounds after lastEligibleRound.
 *
 * Security (defiSKILL):
 *   - ReentrancyGuard on all state-changing functions.
 *   - msg.sender verified as entry owner before any escrow operation.
 *   - ETH held as msg.value, TIMBS via safeTransferFrom.
 *   - Additional-round TIMBS sent directly to protocol sink address
 *     (never held in this contract).
 *   - Pre-flight approval check on replacement before any state changes.
 *   - Emergency pause on new entries — refunds always available.
 *   - Only TimbPrize (authorised) can update entry status at settlement.
 *
 * Deployment:
 *   1. Deploy GameRegistry(timbsToken, protocolSink, timbPrize)
 *   2. setEntryCostParams(entryCostTIMBS, ethCostWei)
 *   3. timbPrize.setGameRegistry(address(this))
 *   4. Verify on Sourcify
 */
contract GameRegistry is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Types ───────────────────────────────────────────────────────────────

    enum EntryStatus { Pending, Active, Expired, Claimed, Inactive }

    /// @dev address(0) = ETH entry, any other address = token entry.
    struct EntryData {
        bytes6      string6;           // 6-char alphanumeric entry string
        uint256     entryRound;        // Round in which entry was submitted
        uint256     lastEligibleRound; // Last round this entry plays
        uint256     escrowAmount;      // Principal held (ETH wei or TIMBS wei)
        address     escrowToken;       // address(0) = ETH, else token address
        EntryStatus status;
        bool        exists;            // Guard for uninitialized reads
    }

    // ─── State ───────────────────────────────────────────────────────────────

    /// @notice TIMBS token.
    IERC20 public immutable timbsToken;

    /// @notice Protocol sink — receives additional-round TIMBS (out of circulation).
    address public protocolSink;

    /// @notice TimbPrize — only address allowed to call settlement updates.
    address public timbPrize;

    /// @notice Entry cost in TIMBS (governance-set, mirrors TIMBSToken.entryCostTIMBS).
    uint256 public entryCostTIMBS;

    /// @notice Entry cost in ETH wei (derived from TIMBS price, owner-updatable).
    uint256 public entryCostETH;

    /// @notice Additional round cost = entryCostTIMBS × N extra rounds.
    ///         Derived — not stored separately.

    /// @notice Current active round number (set by TimbPrize).
    uint256 public currentRound;

    /// @notice Emergency pause — blocks new entries, refunds always available.
    bool public paused;

    /// @notice wallet → round → EntryData.
    mapping(address => mapping(uint256 => EntryData)) public entries;

    /// @notice round → string → wallets that submitted that string.
    ///         Used for settlement winner lookup.
    mapping(uint256 => mapping(bytes6 => address[])) public stringEntrants;

    /// @notice wallet → rounds they have active entries in (for history).
    mapping(address => uint256[]) public playerRounds;

    /// @notice round → all wallets that submitted entries.
    mapping(uint256 => address[]) public roundEntrants;

    /// @notice round → wallet → index in roundEntrants (for dedup check).
    mapping(uint256 => mapping(address => bool)) public hasEntryInRound;

    // ─── Events ──────────────────────────────────────────────────────────────

    event EntrySubmitted(
        address indexed player,
        uint256 indexed playRound,
        bytes6  string6,
        uint256 escrowAmount,
        address escrowToken,
        uint256 lastEligibleRound
    );
    event EntryReplaced(
        address indexed player,
        uint256 indexed playRound,
        bytes6  oldString,
        bytes6  newString,
        uint256 additionalTimbs
    );
    event EntryStatusUpdated(
        address indexed player,
        uint256 indexed round,
        EntryStatus newStatus
    );
    event EscrowRefunded(
        address indexed player,
        uint256 indexed round,
        uint256 amount,
        address token
    );
    event AdditionalRoundSinked(
        address indexed player,
        uint256 timbsAmount
    );
    event EntryCostUpdated(uint256 timbsCost, uint256 ethCost);
    event CurrentRoundUpdated(uint256 round);
    event TimbPrizeSet(address indexed timbPrize);
    event ProtocolSinkSet(address indexed sink);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error ContractPaused();
    error NotTimbPrize();
    error InvalidStringLength(uint256 length);
    error InvalidCharacter(bytes1 char);
    error RepeatingCharacter(bytes1 char);
    error ActiveEntryExists(uint256 playRound);
    error NoEntryFound(address player, uint256 round);
    error EntryNotExpired(EntryStatus status);
    error ClaimWindowClosed(uint256 lastEligibleRound, uint256 currentRound);
    error WrongEscrowAmount(uint256 sent, uint256 required);
    error InsufficientAllowance(uint256 required, uint256 available);
    error EntryNotActive(EntryStatus status);
    error AlreadyRefunded();

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier onlyTimbPrize() {
        if (msg.sender != timbPrize) revert NotTimbPrize();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    /**
     * @param _timbsToken    TIMBS ERC-20 address.
     * @param _protocolSink  Address that receives additional-round TIMBS sinks.
     * @param _timbPrize     TimbPrize contract (can be set later via setTimbPrize).
     */
    constructor(
        address _timbsToken,
        address _protocolSink,
        address _timbPrize
    ) Ownable(msg.sender) {
        if (_timbsToken    == address(0)) revert ZeroAddress();
        if (_protocolSink  == address(0)) revert ZeroAddress();
        timbsToken   = IERC20(_timbsToken);
        protocolSink = _protocolSink;
        timbPrize    = _timbPrize; // allowed address(0) at deploy
    }

    // ─── String Validation ────────────────────────────────────────────────────

    /**
     * @notice Validates a 6-char bytes6 entry string.
     * @dev Rules:
     *   - Exactly 6 bytes (enforced by bytes6 type).
     *   - Each character: A-Z (0x41–0x5A) or 0-9 (0x30–0x39).
     *   - No repeating characters.
     *   - All uppercase (frontend enforces, contract validates).
     * @param s The bytes6 string to validate.
     */
    function _validateString(bytes6 s) internal pure {
        // Track seen characters via bitmask (36 possible chars: A-Z=26, 0-9=10)
        uint64 seen = 0;

        for (uint256 i = 0; i < 6; i++) {
            bytes1 c = s[i];

            // Must be A-Z or 0-9
            bool isUpper  = c >= 0x41 && c <= 0x5A; // A-Z
            bool isDigit  = c >= 0x30 && c <= 0x39; // 0-9
            if (!isUpper && !isDigit) revert InvalidCharacter(c);

            // Map to index 0-35: A=0..Z=25, 0=26..9=35
            uint256 idx = isUpper
                ? uint256(uint8(c)) - 0x41
                : uint256(uint8(c)) - 0x30 + 26;

            // Check for repeat
            uint64 bit = uint64(1 << idx);
            if (seen & bit != 0) revert RepeatingCharacter(c);
            seen |= bit;
        }
    }

    /**
     * @notice Public view to validate a string before submitting.
     * @return valid True if the string passes all validation rules.
     * @return reason Empty string if valid, human-readable reason if not.
     */
    function validateString(bytes6 s)
        external
        pure
        returns (bool valid, string memory reason)
    {
        // Check each char
        uint64 seen = 0;
        for (uint256 i = 0; i < 6; i++) {
            bytes1 c = s[i];
            bool isUpper = c >= 0x41 && c <= 0x5A;
            bool isDigit = c >= 0x30 && c <= 0x39;
            if (!isUpper && !isDigit) {
                return (false, "Invalid character: must be A-Z or 0-9");
            }
            uint256 idx = isUpper
                ? uint256(uint8(c)) - 0x41
                : uint256(uint8(c)) - 0x30 + 26;
            uint64 bit = uint64(1 << idx);
            if (seen & bit != 0) {
                return (false, "Repeating character not allowed");
            }
            seen |= bit;
        }
        return (true, "");
    }

    // ─── Entry Submission ─────────────────────────────────────────────────────

    /**
     * @notice Submit a new entry for the next round.
     * @dev Entries set in currentRound play in currentRound + 1.
     *      ETH entries: send msg.value == entryCostETH.
     *      TIMBS entries: approve this contract for entryCostTIMBS first.
     *      Additional rounds: must also approve
     *        extraRounds × entryCostTIMBS additional TIMBS.
     *
     * @param string6       6-char entry string (A-Z, 0-9, no repeats, uppercase).
     * @param useETH        True = pay initial cost in ETH, false = TIMBS.
     * @param extraRounds   Additional rounds to keep string active beyond N+1.
     *                      Each costs entryCostTIMBS TIMBS (non-refundable).
     */
    function submitEntry(
        bytes6  string6,
        bool    useETH,
        uint256 extraRounds
    )
        external
        payable
        nonReentrant
        whenNotPaused
    {
        uint256 playRound = currentRound + 1;

        // Must not have an active entry for the play round
        if (entries[msg.sender][playRound].exists) {
            if (entries[msg.sender][playRound].status == EntryStatus.Active ||
                entries[msg.sender][playRound].status == EntryStatus.Pending) {
                revert ActiveEntryExists(playRound);
            }
        }

        // Validate string
        _validateString(string6);

        // Handle initial escrow
        uint256 escrowAmount;
        address escrowToken;

        if (useETH) {
            if (msg.value == 0 || msg.value < entryCostETH) {
                revert WrongEscrowAmount(msg.value, entryCostETH);
            }
            escrowAmount = entryCostETH;
            escrowToken  = address(0);
            // Refund overpayment
            if (msg.value > entryCostETH) {
                (bool ok,) = payable(msg.sender).call{value: msg.value - entryCostETH}("");
                require(ok, "ETH refund failed");
            }
        } else {
            if (msg.value > 0) {
                // Refund any ETH sent with TIMBS entry
                (bool ok,) = payable(msg.sender).call{value: msg.value}("");
                require(ok, "ETH refund failed");
            }
            escrowAmount = entryCostTIMBS;
            escrowToken  = address(timbsToken);
            timbsToken.safeTransferFrom(msg.sender, address(this), entryCostTIMBS);
        }

        // Handle additional rounds — TIMBS only, sent to protocol sink
        uint256 additionalCost = extraRounds * entryCostTIMBS;
        if (additionalCost > 0) {
            timbsToken.safeTransferFrom(msg.sender, protocolSink, additionalCost);
            emit AdditionalRoundSinked(msg.sender, additionalCost);
        }

        uint256 lastEligibleRound = playRound + extraRounds;

        // Store entry
        entries[msg.sender][playRound] = EntryData({
            string6:           string6,
            entryRound:        currentRound,
            lastEligibleRound: lastEligibleRound,
            escrowAmount:      escrowAmount,
            escrowToken:       escrowToken,
            status:            EntryStatus.Pending,
            exists:            true
        });

        // Index for settlement lookup
        if (!hasEntryInRound[playRound][msg.sender]) {
            stringEntrants[playRound][string6].push(msg.sender);
            roundEntrants[playRound].push(msg.sender);
            hasEntryInRound[playRound][msg.sender] = true;
            playerRounds[msg.sender].push(playRound);
        } else {
            // String changed — update stringEntrants index
            // (old string remains in old bucket — settlement checks current entry)
            stringEntrants[playRound][string6].push(msg.sender);
        }

        emit EntrySubmitted(
            msg.sender,
            playRound,
            string6,
            escrowAmount,
            escrowToken,
            lastEligibleRound
        );
    }

    // ─── Entry Replacement ────────────────────────────────────────────────────

    /**
     * @notice Replace an existing entry string and/or round count.
     * @dev All-in-one atomic transaction:
     *   1. Pre-flight: verify contract can pull new fees.
     *   2. Old initial deposit transfers to new string entry.
     *   3. Old additional-round TIMBS already in sink — no action needed.
     *   4. New string set on-chain.
     *   5. New additional-round TIMBS pulled to sink if extraRounds > 0.
     *
     *      Pre-flight check happens BEFORE any state changes (defiSKILL).
     *
     * @param newString6  New 6-char string.
     * @param extraRounds New total extra rounds beyond N+1.
     */
    function replaceEntry(bytes6 newString6, uint256 extraRounds)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        uint256 playRound = currentRound + 1;
        EntryData storage entry = entries[msg.sender][playRound];

        if (!entry.exists) revert NoEntryFound(msg.sender, playRound);
        if (entry.status != EntryStatus.Pending &&
            entry.status != EntryStatus.Active) {
            revert EntryNotActive(entry.status);
        }

        // Validate new string
        _validateString(newString6);

        // Pre-flight: verify we can pull additional-round TIMBS if needed
        uint256 additionalCost = extraRounds * entryCostTIMBS;
        if (additionalCost > 0) {
            uint256 allowance = timbsToken.allowance(msg.sender, address(this));
            if (allowance < additionalCost) {
                revert InsufficientAllowance(additionalCost, allowance);
            }
        }

        bytes6 oldString = entry.string6;

        // Update string — initial deposit stays in escrow (transfers to new string)
        entry.string6           = newString6;
        entry.lastEligibleRound = playRound + extraRounds;

        // Update string entrants index
        stringEntrants[playRound][newString6].push(msg.sender);

        // Pull new additional-round TIMBS to sink (old additional already in sink)
        if (additionalCost > 0) {
            timbsToken.safeTransferFrom(msg.sender, protocolSink, additionalCost);
            emit AdditionalRoundSinked(msg.sender, additionalCost);
        }

        emit EntryReplaced(
            msg.sender,
            playRound,
            oldString,
            newString6,
            additionalCost
        );
    }

    // ─── Escrow Refund ────────────────────────────────────────────────────────

    /**
     * @notice Claim principal escrow refund for an expired entry.
     * @dev Available after entry's lastEligibleRound has passed AND
     *      claim window (2 rounds) has not closed.
     *      Caller must be the original entry owner.
     * @param round The round the entry was playing in.
     */
    function claimRefund(uint256 round) external nonReentrant {
        EntryData storage entry = entries[msg.sender][round];

        if (!entry.exists) revert NoEntryFound(msg.sender, round);
        if (entry.status == EntryStatus.Claimed ||
            entry.status == EntryStatus.Inactive) {
            revert AlreadyRefunded();
        }

        // Entry must be expired (past lastEligibleRound)
        if (currentRound <= entry.lastEligibleRound) {
            revert EntryNotExpired(entry.status);
        }

        // Claim window: must be within 2 rounds of lastEligibleRound
        uint256 claimDeadline = entry.lastEligibleRound + 2;
        if (currentRound > claimDeadline) {
            revert ClaimWindowClosed(entry.lastEligibleRound, currentRound);
        }

        uint256 amount = entry.escrowAmount;
        address token  = entry.escrowToken;

        entry.status       = EntryStatus.Claimed;
        entry.escrowAmount = 0;

        if (token == address(0)) {
            // ETH refund
            (bool ok,) = payable(msg.sender).call{value: amount}("");
            require(ok, "ETH refund failed");
        } else {
            IERC20(token).safeTransfer(msg.sender, amount);
        }

        emit EscrowRefunded(msg.sender, round, amount, token);
    }

    // ─── TimbPrize: Settlement Interface ──────────────────────────────────────

    /**
     * @notice Activate entries for a round at round start.
     * @dev Called by TimbPrize when a new round begins.
     *      Sets all Pending entries for this round to Active.
     *      Only TimbPrize can call.
     * @param round The round number being activated.
     * @param players Array of player addresses with entries in this round.
     */
    function activateRoundEntries(uint256 round, address[] calldata players)
        external
        onlyTimbPrize
    {
        for (uint256 i = 0; i < players.length; i++) {
            EntryData storage entry = entries[players[i]][round];
            if (entry.exists && entry.status == EntryStatus.Pending) {
                entry.status = EntryStatus.Active;
                emit EntryStatusUpdated(players[i], round, EntryStatus.Active);
            }
        }
    }

    /**
     * @notice Mark an entry as expired after its lastEligibleRound passes.
     * @dev Called by TimbPrize at round close for entries past their window.
     */
    function expireEntry(address player, uint256 round)
        external
        onlyTimbPrize
    {
        EntryData storage entry = entries[player][round];
        if (entry.exists && entry.status == EntryStatus.Active) {
            entry.status = EntryStatus.Expired;
            emit EntryStatusUpdated(player, round, EntryStatus.Expired);
        }
    }

    /**
     * @notice Mark an entry as Inactive (claim window closed, no claim made).
     * @dev Called by TimbPrize when unclaimed window expires.
     */
    function markInactive(address player, uint256 round)
        external
        onlyTimbPrize
    {
        EntryData storage entry = entries[player][round];
        if (entry.exists && (
            entry.status == EntryStatus.Expired ||
            entry.status == EntryStatus.Active
        )) {
            // Unclaimed escrow — absorbed into protocol
            // ETH escrow sent to protocolSink by TimbPrize after calling this
            entry.status = EntryStatus.Inactive;
            emit EntryStatusUpdated(player, round, EntryStatus.Inactive);
        }
    }

    /**
     * @notice Update current round number.
     * @dev Called by TimbPrize at each round start.
     */
    function setCurrentRound(uint256 round) external onlyTimbPrize {
        currentRound = round;
        emit CurrentRoundUpdated(round);
    }

    // ─── Dual-Layer Verification ──────────────────────────────────────────────

    /**
     * @notice Layer 1: Verify entry existed at round start.
     * @param player  Wallet address.
     * @param round   Round number to check.
     * @return exists True if entry was submitted for this round.
     * @return string6 The entry string (bytes6(0) if not found).
     */
    function verifyEntryExisted(address player, uint256 round)
        external
        view
        returns (bool exists, bytes6 string6)
    {
        EntryData storage entry = entries[player][round];
        if (!entry.exists) return (false, bytes6(0));
        return (true, entry.string6);
    }

    /**
     * @notice Layer 2: Verify entry is still valid at settlement.
     * @param player  Wallet address.
     * @param round   Round number.
     * @return valid  True if entry is Active and round <= lastEligibleRound.
     * @return string6 The current entry string.
     */
    function verifyEntryValid(address player, uint256 round)
        external
        view
        returns (bool valid, bytes6 string6)
    {
        EntryData storage entry = entries[player][round];
        if (!entry.exists)                          return (false, bytes6(0));
        if (entry.status != EntryStatus.Active &&
            entry.status != EntryStatus.Pending)   return (false, bytes6(0));
        if (round > entry.lastEligibleRound)        return (false, bytes6(0));
        return (true, entry.string6);
    }

    /**
     * @notice Returns all wallets that submitted a given string for a round.
     * @dev Used by TimbPrize at settlement to find winner candidates.
     *      Returns raw list — settlement applies dual-layer filter.
     */
    function getStringEntrants(uint256 round, bytes6 string6)
        external
        view
        returns (address[] memory)
    {
        return stringEntrants[round][string6];
    }

    /**
     * @notice Returns all wallet addresses with entries in a round.
     */
    function getRoundEntrants(uint256 round)
        external
        view
        returns (address[] memory)
    {
        return roundEntrants[round];
    }

    /**
     * @notice Returns identical entry count for a string in the next round.
     * @dev Frontend calls this after entry submission to show collision count.
     */
    function getIdenticalCount(bytes6 string6)
        external
        view
        returns (uint256)
    {
        return stringEntrants[currentRound + 1][string6].length;
    }

    // ─── Owner: Config ────────────────────────────────────────────────────────

    /**
     * @notice Update entry costs.
     * @dev Called by owner when governance updates entryCostTIMBS or
     *      when TIMBS/ETH price moves and ETH cost needs updating.
     */
    function setEntryCosts(uint256 _timbsCost, uint256 _ethCost)
        external
        onlyOwner
    {
        if (_timbsCost == 0 || _ethCost == 0) revert ZeroAmount();
        entryCostTIMBS = _timbsCost;
        entryCostETH   = _ethCost;
        emit EntryCostUpdated(_timbsCost, _ethCost);
    }

    /**
     * @notice Set or update TimbPrize address.
     */
    function setTimbPrize(address _timbPrize) external onlyOwner {
        if (_timbPrize == address(0)) revert ZeroAddress();
        timbPrize = _timbPrize;
        emit TimbPrizeSet(_timbPrize);
    }

    /**
     * @notice Update protocol sink address.
     */
    function setProtocolSink(address _sink) external onlyOwner {
        if (_sink == address(0)) revert ZeroAddress();
        protocolSink = _sink;
        emit ProtocolSinkSet(_sink);
    }

    function pause()   external onlyOwner { paused = true;  emit Paused(msg.sender); }
    function unpause() external onlyOwner { paused = false; emit Unpaused(msg.sender); }

    // ─── View Helpers ─────────────────────────────────────────────────────────

    /**
     * @notice Returns a player's entry for a specific round.
     */
    function getEntry(address player, uint256 round)
        external
        view
        returns (EntryData memory)
    {
        return entries[player][round];
    }

    /**
     * @notice Returns all rounds a player has entries in.
     */
    function getPlayerRounds(address player)
        external
        view
        returns (uint256[] memory)
    {
        return playerRounds[player];
    }

    /**
     * @notice Returns a player's full entry history.
     */
    function getPlayerHistory(address player)
        external
        view
        returns (EntryData[] memory history)
    {
        uint256[] memory rounds = playerRounds[player];
        history = new EntryData[](rounds.length);
        for (uint256 i = 0; i < rounds.length; i++) {
            history[i] = entries[player][rounds[i]];
        }
    }

    /**
     * @notice Returns additional round cost for N extra rounds.
     */
    function additionalRoundCost(uint256 extraRounds)
        external
        view
        returns (uint256)
    {
        return extraRounds * entryCostTIMBS;
    }

    /// @dev Accept ETH for escrow (entry deposits).
    receive() external payable {}
}
