// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

using SafeERC20 for IERC20;

// ─── Interfaces ──────────────────────────────────────────────────────────

interface IPrizeEscrow {
    function pay(address to, uint256 amount) external;
    function balance() external view returns (uint256);
    function deposit() external payable;
}

interface IGameRegistry {
    function verifyEntryExisted(address player, uint256 round)
        external view returns (bool, bytes6);
    function verifyEntryValid(address player, uint256 round)
        external view returns (bool, bytes6);
    function getStringEntrants(uint256 round, bytes6 string6)
        external view returns (address[] memory);
    function getRoundEntrants(uint256 round)
        external view returns (address[] memory);
    function activateRoundEntries(uint256 round, address[] calldata players) external;
    function expireEntry(address player, uint256 round) external;
    function markInactive(address player, uint256 round) external;
    function setCurrentRound(uint256 round) external;
    function getEntry(address player, uint256 round)
        external view returns (
            bytes6, uint256, uint256, uint256, address, uint8, bool
        );
}

interface IEligibleTokenRegistry {
    function isEligible(address token) external view returns (bool);
}

/**
 * @title TimbPrize
 * @notice Prize game round logic, scroll mechanic, settlement, and payouts.
 *
 * Architecture:
 *   - Perpetual self-continuing rounds (6 hours each).
 *   - 6 segments per round: 59:45 interaction + 0:15 settlement.
 *   - positionCounter increments +1 per eligible swap (via nudgeScroll).
 *   - Winning string = 6-char window in 36-char alphabet at freeze point.
 *   - Freeze: keccak256(blockhash(block.number-1) + counter + roundNumber).
 *   - Winners: exact 6-char match, equal split, remainder (r) snowballs.
 *   - Prize ETH held in PrizeEscrow, paid on winner claim.
 *   - Dual-layer verification at settlement via GameRegistry.
 *
 * Prize pool accounting (balance sheet):
 *   currentAccumulatedRewards — live building pot
 *   gameUnclaimed_winningsPool — documented winners pending claim
 *   Entry escrow in GameRegistry — completely separate, never touched here
 *
 * Security:
 *   - ReentrancyGuard on claimWinnings(), nudgeScroll(), settleSegment().
 *   - Settler address (owner initially) is the only caller for settlement.
 *   - Settlement reverts if called before segment timer expires.
 *   - nudgeScroll() blocked during 0:15 settlement window.
 *   - Winner claim verified via dual-layer GameRegistry check.
 *   - ETH never held here — all prize ETH in PrizeEscrow.
 *   - Per-function pause (entries, settlement pausable independently).
 *
 * Deployment:
 *   1. Deploy PrizeEscrow → Deploy TimbPrize(escrow, registry, router)
 *   2. registry.setTimbPrize(address(this))
 *   3. router.setTimbPrize(address(this))
 *   4. setEligibleRegistry(address)
 *   5. Fund PrizeEscrow with initial ETH
 *   6. startGame() — begins round #1
 */
contract TimbPrize is Ownable, ReentrancyGuard {

    // ─── Constants ───────────────────────────────────────────────────────────

    /// @notice 36-character alphabet: A-Z then 0-9.
    bytes constant ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    /// @notice Segment interaction window: 59 min 45 sec.
    uint256 public constant INTERACTION_WINDOW = 59 minutes + 45 seconds;

    /// @notice Settlement window: 15 seconds.
    uint256 public constant SETTLEMENT_WINDOW = 15 seconds;

    /// @notice Full segment duration.
    uint256 public constant SEGMENT_DURATION = INTERACTION_WINDOW + SETTLEMENT_WINDOW;

    /// @notice Segments per round.
    uint256 public constant SEGMENTS_PER_ROUND = 6;

    /// @notice Full round duration (6 hours).
    uint256 public constant ROUND_DURATION = SEGMENT_DURATION * SEGMENTS_PER_ROUND;

    /// @notice Claim window: 2 rounds after lastEligibleRound.
    uint256 public constant CLAIM_WINDOW_ROUNDS = 2;

    // ─── State ───────────────────────────────────────────────────────────────

    /// @notice PrizeEscrow — holds all prize ETH.
    address public prizeEscrow;

    /// @notice GameRegistry — entry storage and verification.
    address public gameRegistry;

    /// @notice TimbSwapRouter — authorised to call nudgeScroll().
    address public router;

    /// @notice EligibleTokenRegistry — token eligibility check.
    address public eligibleRegistry;

    /// @notice Settler address — authorised to call settleSegment().
    address public settler;

    /// @notice Scroll position counter — increments +1 per eligible swap.
    uint256 public positionCounter;

    /// @notice Shuffle enabled — if true, alphabet reseeded each round.
    bool public shuffleEnabled;

    /// @notice Current round number (starts at 0, first game round = 1).
    uint256 public currentRound;

    /// @notice Current segment within the round (1–6).
    uint256 public currentSegment;

    /// @notice Timestamp when the current segment started.
    uint256 public segmentStartTime;

    /// @notice Whether the game has been started.
    bool public gameStarted;

    /// @notice Current accumulated rewards (live prize pot, in ETH wei).
    uint256 public currentAccumulatedRewards;

    /// @notice Undistributed winnings documented for winners pending claim.
    uint256 public gameUnclaimed_winningsPool;

    /// @notice Number of winners per round (owner-configurable).
    uint256 public winnersPerRound;

    /// @notice Owner-set protocol cut % from round settlement (basis points).
    uint256 public protocolCutBps;

    /// @notice Frozen winning string for each round.
    mapping(uint256 => bytes6) public roundWinningString;

    /// @notice Frozen pot for each round (post-protocol-cut).
    mapping(uint256 => uint256) public roundPotAmount;

    /// @notice Winners documented per round.
    mapping(uint256 => address[]) public roundWinners;

    /// @notice Per-winner payout amount per round.
    mapping(uint256 => uint256) public roundPerWinnerAmount;

    /// @notice Remainder (r) for each round.
    mapping(uint256 => uint256) public roundRemainder;

    /// @notice Whether a winner has claimed for a round.
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    /// @notice Per-function pause flags.
    bool public entriesPaused;
    bool public settlementPaused;

    // ─── Events ──────────────────────────────────────────────────────────────

    event GameStarted(uint256 timestamp);
    event RoundStarted(uint256 indexed round, uint256 timestamp);
    event SegmentAdvanced(uint256 indexed round, uint256 segment, uint256 timestamp);
    event ScrollNudged(uint256 newPosition, uint256 indexed round, uint256 segment);
    event PositionFrozen(uint256 indexed round, uint256 position, bytes6 winningString);
    event RoundSettled(
        uint256 indexed round,
        bytes6  winningString,
        uint256 potAmount,
        uint256 numWinners,
        uint256 remainderR,
        uint256 totalEntries,
        uint256 timestamp
    );
    event WinningsClaimed(address indexed winner, uint256 indexed round, uint256 amount);
    event PotFunded(uint256 amount, address indexed from);
    event ProtocolCutTaken(uint256 amount);
    event SettlerUpdated(address indexed newSettler);
    event WinnersPerRoundSet(uint256 count);
    event ProtocolCutSet(uint256 bps);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error GameNotStarted();
    error GameAlreadyStarted();
    error NotSettler();
    error NotRouter();
    error SegmentNotComplete(uint256 elapsed, uint256 required);
    error NotInSettlementWindow();
    error InSettlementWindow();
    error RoundNotSettled(uint256 round);
    error AlreadyClaimed(address winner, uint256 round);
    error NotAWinner(address caller, uint256 round);
    error ClaimWindowExpired(uint256 round);
    error EntriesPaused();
    error SettlementPaused();
    error InvalidWinnersCount();
    error InsufficientPotBalance();

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlySettler() {
        if (msg.sender != settler) revert NotSettler();
        _;
    }

    modifier onlyRouter() {
        if (msg.sender != router) revert NotRouter();
        _;
    }

    modifier whenGameStarted() {
        if (!gameStarted) revert GameNotStarted();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    /**
     * @param _prizeEscrow    PrizeEscrow contract address.
     * @param _gameRegistry   GameRegistry contract address.
     * @param _router         TimbSwapRouter address.
     */
    constructor(
        address _prizeEscrow,
        address _gameRegistry,
        address _router
    ) Ownable(msg.sender) {
        if (_prizeEscrow   == address(0)) revert ZeroAddress();
        if (_gameRegistry  == address(0)) revert ZeroAddress();
        if (_router        == address(0)) revert ZeroAddress();

        prizeEscrow  = _prizeEscrow;
        gameRegistry = _gameRegistry;
        router       = _router;
        settler      = msg.sender;
        winnersPerRound = 3;
        protocolCutBps  = 200; // 2% default protocol cut per round
    }

    // ─── Game Lifecycle ───────────────────────────────────────────────────────

    /**
     * @notice Start the prize game. Begins round #1.
     * @dev Owner-only. Called once after all contracts are deployed and funded.
     */
    function startGame() external onlyOwner {
        if (gameStarted) revert GameAlreadyStarted();
        gameStarted      = true;
        currentRound     = 1;
        currentSegment   = 1;
        segmentStartTime = block.timestamp;

        IGameRegistry(gameRegistry).setCurrentRound(currentRound);
        _activateRoundEntries(currentRound);

        emit GameStarted(block.timestamp);
        emit RoundStarted(currentRound, block.timestamp);
        emit SegmentAdvanced(currentRound, currentSegment, block.timestamp);
    }

    // ─── Scroll Mechanic ──────────────────────────────────────────────────────

    /**
     * @notice Nudge the scroll position +1.
     * @dev Called by TimbSwapRouter after a confirmed eligible swap.
     *      Blocked during the 0:15 settlement window.
     *      Router checks EligibleTokenRegistry before calling.
     */
    function nudgeScroll()
        external
        nonReentrant
        onlyRouter
        whenGameStarted
    {
        if (_isInSettlementWindow()) revert InSettlementWindow();
        positionCounter++;
        emit ScrollNudged(positionCounter, currentRound, currentSegment);
    }

    /**
     * @notice Returns whether we are currently in the 0:15 settlement window.
     */
    function isSettlementWindow() external view returns (bool) {
        return _isInSettlementWindow();
    }

    function _isInSettlementWindow() internal view returns (bool) {
        if (!gameStarted) return false;
        uint256 elapsed = block.timestamp - segmentStartTime;
        return elapsed >= INTERACTION_WINDOW;
    }

    // ─── Scroll Window Derivation ─────────────────────────────────────────────

    /**
     * @notice Returns the current 6-char display window from positionCounter.
     * @dev alphabet[(positionCounter + i) % 36] for i = 0..5.
     *      Frontend also computes this — contract provides it for verification.
     */
    function getCurrentWindow() public view returns (bytes6 window) {
        bytes memory result = new bytes(6);
        for (uint256 i = 0; i < 6; i++) {
            result[i] = ALPHABET[(positionCounter + i) % 36];
        }
        window = bytes6(bytes(result));
    }

    /**
     * @notice Returns the 6-char window at any arbitrary counter value.
     * @dev Used for historical replay and frontend simulation.
     */
    function getWindowAt(uint256 counter) public pure returns (bytes6 window) {
        bytes memory result = new bytes(6);
        for (uint256 i = 0; i < 6; i++) {
            result[i] = ALPHABET[(counter + i) % 36];
        }
        window = bytes6(bytes(result));
    }

    // ─── Settlement ───────────────────────────────────────────────────────────

    /**
     * @notice Advance to the next segment or settle the final segment.
     * @dev Settler calls this after INTERACTION_WINDOW has elapsed.
     *      On segments 1–5: advances to next segment.
     *      On segment 6: freezes position, finds winners, settles round.
     *      Reverts if called too early (on-chain timing enforcement).
     */
    function settleSegment()
        external
        nonReentrant
        onlySettler
        whenGameStarted
    {
        if (settlementPaused) revert SettlementPaused();

        uint256 elapsed = block.timestamp - segmentStartTime;
        if (elapsed < INTERACTION_WINDOW) {
            revert SegmentNotComplete(elapsed, INTERACTION_WINDOW);
        }

        if (currentSegment < SEGMENTS_PER_ROUND) {
            // Advance to next segment
            currentSegment++;
            segmentStartTime = block.timestamp;
            emit SegmentAdvanced(currentRound, currentSegment, block.timestamp);
        } else {
            // Final segment — freeze and settle
            _settleRound();
        }
    }

    /**
     * @dev Internal round settlement logic.
     */
    /**
     * @dev Internal round settlement logic. Orchestrates three steps that
     *      used to all live in this one function — that crowding (entropy,
     *      candidates, verified, pot math, winners array, etc. all sharing
     *      one stack frame) was the actual stack-too-deep cause, separate
     *      from anything via_ir-related.
     */
    function _settleRound() internal {
        uint256 round = currentRound;

        bytes6 winningString = _freezeWinningString(round);

        (address[] memory winners, uint256 winnerCount) =
            _findVerifiedWinners(round, winningString);

        _distributePotAndRecord(round, winners, winnerCount);

        // ── Expire entries past their lastEligibleRound ───────────────────────
        _processExpiredEntries(round);

        uint256 totalEntries =
            IGameRegistry(gameRegistry).getRoundEntrants(round).length;

        emit RoundSettled(
            round,
            winningString,
            roundPotAmount[round],
            winnerCount,
            roundRemainder[round],
            totalEntries,
            block.timestamp
        );

        // ── Auto-queue next round ─────────────────────────────────────────────
        currentRound++;
        currentSegment   = 1;
        segmentStartTime = block.timestamp;

        IGameRegistry(gameRegistry).setCurrentRound(currentRound);
        _activateRoundEntries(currentRound);

        emit RoundStarted(currentRound, block.timestamp);
        emit SegmentAdvanced(currentRound, 1, block.timestamp);
    }

    /**
     * @dev Step 1 — freeze position: entropy from blockhash + positionCounter
     *      + round, random 3-second offset within the 0:15 window, records
     *      and emits the winning string for this round.
     */
    function _freezeWinningString(uint256 round) internal returns (bytes6 winningString) {
        uint256 entropy = uint256(keccak256(abi.encodePacked(
            blockhash(block.number - 1),
            positionCounter,
            round
        )));

        uint256 offset        = entropy % 3;
        uint256 frozenCounter = positionCounter + offset;

        winningString = getWindowAt(frozenCounter);
        roundWinningString[round] = winningString;

        emit PositionFrozen(round, frozenCounter, winningString);
    }

    /**
     * @dev Step 2 — dual-layer verification. Both verifyEntryExisted() AND
     *      verifyEntryValid() must pass before a candidate is counted as a
     *      winner. Never skip either layer.
     */
    function _findVerifiedWinners(uint256 round, bytes6 winningString)
        internal
        view
        returns (address[] memory winners, uint256 winnerCount)
    {
        address[] memory candidates =
            IGameRegistry(gameRegistry).getStringEntrants(round, winningString);

        address[] memory verified = new address[](candidates.length);

        for (uint256 i = 0; i < candidates.length; i++) {
            address candidate = candidates[i];

            // Layer 1: entry existed at round start
            (bool existed, bytes6 existedString) =
                IGameRegistry(gameRegistry).verifyEntryExisted(candidate, round);
            if (!existed) continue;
            if (existedString != winningString) continue;

            // Layer 2: entry still valid at settlement
            (bool valid, bytes6 validString) =
                IGameRegistry(gameRegistry).verifyEntryValid(candidate, round);
            if (!valid) continue;
            if (validString != winningString) continue;

            verified[winnerCount++] = candidate;
        }

        winners = new address[](winnerCount);
        for (uint256 i = 0; i < winnerCount; i++) {
            winners[i] = verified[i];
        }
    }

    /**
     * @dev Step 3 — protocol cut, floor(x/n)*n pot split, snowball remainder,
     *      and bookkeeping. Only touches currentAccumulatedRewards /
     *      gameUnclaimed_winningsPool — never the GameRegistry entry escrow.
     */
    function _distributePotAndRecord(
        uint256 round,
        address[] memory winners,
        uint256 winnerCount
    ) internal {
        uint256 pot = currentAccumulatedRewards;
        uint256 perWinner;
        uint256 remainder;

        if (protocolCutBps > 0 && pot > 0) {
            uint256 cut = (pot * protocolCutBps) / 10_000;
            pot -= cut;
            emit ProtocolCutTaken(cut);
        }

        uint256 totalPaid = 0;
        remainder = pot;

        if (winnerCount > 0) {
            perWinner = pot / winnerCount;
            totalPaid = perWinner * winnerCount;
            remainder = pot - totalPaid;
        }

        for (uint256 i = 0; i < winnerCount; i++) {
            roundWinners[round].push(winners[i]);
        }

        roundPotAmount[round]       = pot;
        roundPerWinnerAmount[round] = perWinner;
        roundRemainder[round]       = remainder;

        gameUnclaimed_winningsPool += totalPaid;
        currentAccumulatedRewards   = remainder; // r snowballs to next round
    }

    /**
     * @dev Activates Pending entries for the given round in GameRegistry.
     */
    function _activateRoundEntries(uint256 round) internal {
        address[] memory entrants =
            IGameRegistry(gameRegistry).getRoundEntrants(round);
        if (entrants.length > 0) {
            IGameRegistry(gameRegistry).activateRoundEntries(round, entrants);
        }
    }

    /**
     * @dev Expires entries in GameRegistry whose lastEligibleRound < currentRound.
     *      Also marks inactive entries whose claim window has closed.
     */
    function _processExpiredEntries(uint256 settledRound) internal {
        address[] memory entrants =
            IGameRegistry(gameRegistry).getRoundEntrants(settledRound);

        for (uint256 i = 0; i < entrants.length; i++) {
            (
                ,
                ,
                uint256 lastEligibleRound,
                ,
                ,
                ,
            ) = IGameRegistry(gameRegistry).getEntry(entrants[i], settledRound);

            if (lastEligibleRound < currentRound) {
                // Check if claim window has also closed
                if (currentRound > lastEligibleRound + CLAIM_WINDOW_ROUNDS) {
                    IGameRegistry(gameRegistry).markInactive(entrants[i], settledRound);
                } else {
                    IGameRegistry(gameRegistry).expireEntry(entrants[i], settledRound);
                }
            }
        }
    }

    // ─── Winner Claim ─────────────────────────────────────────────────────────

    /**
     * @notice Claim winnings for a round the caller won.
     * @dev Dual-layer verification: entry existed at round start AND
     *      string matched AND claim window still open.
     *      ETH paid from PrizeEscrow.
     * @param round Round number to claim from.
     */
    function claimWinnings(uint256 round)
        external
        nonReentrant
        whenGameStarted
    {
        // Round must be settled
        if (roundWinningString[round] == bytes6(0)) revert RoundNotSettled(round);

        // Not already claimed
        if (hasClaimed[round][msg.sender]) revert AlreadyClaimed(msg.sender, round);

        // Claim window check: within CLAIM_WINDOW_ROUNDS of settlement
        // (approximated as currentRound <= round + CLAIM_WINDOW_ROUNDS + 1)
        if (currentRound > round + CLAIM_WINDOW_ROUNDS + 1) {
            revert ClaimWindowExpired(round);
        }

        // Verify caller is a documented winner
        bool isWinner = false;
        address[] memory winners = roundWinners[round];
        for (uint256 i = 0; i < winners.length; i++) {
            if (winners[i] == msg.sender) { isWinner = true; break; }
        }
        if (!isWinner) revert NotAWinner(msg.sender, round);

        uint256 payout = roundPerWinnerAmount[round];
        if (payout == 0) revert ZeroAmount();

        hasClaimed[round][msg.sender] = true;
        gameUnclaimed_winningsPool -= payout;

        // Instruct PrizeEscrow to pay
        IPrizeEscrow(prizeEscrow).pay(msg.sender, payout);

        emit WinningsClaimed(msg.sender, round, payout);
    }

    // ─── Pot Funding ─────────────────────────────────────────────────────────

    /**
     * @notice Fund the prize pot directly (owner seeding).
     * @dev Forwards ETH to PrizeEscrow and adds to accumulated rewards.
     */
    function fundPot() external payable onlyOwner {
        if (msg.value == 0) revert ZeroAmount();
        currentAccumulatedRewards += msg.value;
        IPrizeEscrow(prizeEscrow).deposit{value: msg.value}();
        emit PotFunded(msg.value, msg.sender);
    }

    /**
     * @notice Add protocol fees to the pot (called by TimbTreasury).
     */
    function addToPot() external payable {
        if (msg.value == 0) revert ZeroAmount();
        currentAccumulatedRewards += msg.value;
        IPrizeEscrow(prizeEscrow).deposit{value: msg.value}();
        emit PotFunded(msg.value, msg.sender);
    }

    // ─── View: Round State ────────────────────────────────────────────────────

    /**
     * @notice Returns all live state needed by the frontend in one call.
     */
    function getRoundState()
        external
        view
        returns (
            uint256 round,
            uint256 segment,
            uint256 segmentStart,
            uint256 counter,
            bytes6  currentWindow,
            uint256 pot,
            uint256 unclaimedPool,
            bool    inSettlement
        )
    {
        round          = currentRound;
        segment        = currentSegment;
        segmentStart   = segmentStartTime;
        counter        = positionCounter;
        currentWindow  = getCurrentWindow();
        pot            = currentAccumulatedRewards;
        unclaimedPool  = gameUnclaimed_winningsPool;
        inSettlement   = _isInSettlementWindow();
    }

    /**
     * @notice Returns settlement data for a completed round.
     */
    function getRoundResult(uint256 round)
        external
        view
        returns (
            bytes6   winningString,
            uint256  potAmount,
            address[] memory winners,
            uint256  perWinner,
            uint256  remainder
        )
    {
        winningString = roundWinningString[round];
        potAmount     = roundPotAmount[round];
        winners       = roundWinners[round];
        perWinner     = roundPerWinnerAmount[round];
        remainder     = roundRemainder[round];
    }

    /**
     * @notice Time remaining in current segment interaction window.
     *         Returns 0 if in settlement window.
     */
    function timeRemainingInSegment() external view returns (uint256) {
        uint256 elapsed = block.timestamp - segmentStartTime;
        if (elapsed >= INTERACTION_WINDOW) return 0;
        return INTERACTION_WINDOW - elapsed;
    }

    // ─── Owner: Config ────────────────────────────────────────────────────────

    function setSettler(address _settler) external onlyOwner {
        if (_settler == address(0)) revert ZeroAddress();
        settler = _settler;
        emit SettlerUpdated(_settler);
    }

    function setRouter(address _router) external onlyOwner {
        if (_router == address(0)) revert ZeroAddress();
        router = _router;
    }

    function setEligibleRegistry(address _registry) external onlyOwner {
        eligibleRegistry = _registry;
    }

    function setGameRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert ZeroAddress();
        gameRegistry = _registry;
    }

    function setPrizeEscrow(address _escrow) external onlyOwner {
        if (_escrow == address(0)) revert ZeroAddress();
        prizeEscrow = _escrow;
    }

    function setWinnersPerRound(uint256 _count) external onlyOwner {
        if (_count == 0) revert InvalidWinnersCount();
        winnersPerRound = _count;
        emit WinnersPerRoundSet(_count);
    }

    function setProtocolCutBps(uint256 _bps) external onlyOwner {
        if (_bps > 1000) revert ZeroAmount(); // max 10%
        protocolCutBps = _bps;
        emit ProtocolCutSet(_bps);
    }

    function setShuffleEnabled(bool _enabled) external onlyOwner {
        shuffleEnabled = _enabled;
    }

    function pauseEntries()    external onlyOwner { entriesPaused    = true; }
    function unpauseEntries()  external onlyOwner { entriesPaused    = false; }
    function pauseSettlement() external onlyOwner { settlementPaused = true; }
    function unpauseSettlement() external onlyOwner { settlementPaused = false; }
}
