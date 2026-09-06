// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @dev The slice of Chainlink's VRF v2.5 coordinator this module uses.
 *      Declared locally rather than pulled in as a dependency, matching how
 *      every other external contract is reached in this repo (IPoolLedger,
 *      ISeedRegistry, ITimbPrize…). The struct's field ORDER is part of the
 *      ABI — it must match `VRFV2PlusClient.RandomWordsRequest` exactly.
 */
interface IVRFCoordinatorV2Plus {
    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16  requestConfirmations;
        uint32  callbackGasLimit;
        uint32  numWords;
        bytes   extraArgs;
    }
    function requestRandomWords(RandomWordsRequest calldata req) external returns (uint256 requestId);
}

/**
 * @title VRFEntropy
 * @notice Asynchronous entropy for the gen-8 SegmentBoard: one Chainlink VRF
 *         word per segment, keyed by the board's own table+segment salt.
 *
 * ## Why this exists
 *
 * `CommitRevealEntropy` gave the wallet that opened a table a **selection
 * edge** (docs/ENTROPY_TRUST.md): holding the secrets, it could compute both
 * the reveal outcome and the 64-block fallback outcome once the lock block was
 * public, then choose between them by acting or not acting. A Colour bet worth
 * 50% honestly became 75% with the pick, and `rearmTable` made the draws
 * unlimited at 51 minutes each.
 *
 * There is no secret here, so there is no second branch, so there is nothing to
 * choose. That is the entire point — the fix is structural, not a rule bolted
 * on top of a mechanism that still offers the choice.
 *
 * ## One word per segment, requested when that segment is armed
 *
 * A fulfilled word is public the instant the callback lands. Requesting six
 * words up front would therefore publish the whole round at once and kill the
 * staggered drumroll the show is built on. The board arms **one segment at a
 * time**; each arm fires one request; the char for that segment becomes
 * knowable only when its own callback lands — and at that moment anyone may
 * lock it, so there is no window in which one party knows more than the room.
 *
 * ## The stall escape
 *
 * If a request never fulfils (subscription out of LINK, coordinator trouble),
 * `rerequest` fires a fresh one after `REREQUEST_DELAY`. This does **not**
 * reopen the selection edge: an unfulfilled request has no knowable value, so
 * discarding it is a choice between two unknowns. A fulfilled salt can never be
 * re-requested — `_ready` is one-way.
 *
 * ## Configuration is supplied, never assumed
 *
 * Coordinator address, key hash, subscription id, gas limit, confirmations and
 * the v2.5 `extraArgs` blob are all constructor/owner inputs. They are network
 * facts that belong in the deploy runbook, read off Chainlink's published
 * tables at deploy time — not constants carried in source.
 */
contract VRFEntropy is Ownable {
    // ─── Wiring ────────────────────────────────────────────────────────────

    IVRFCoordinatorV2Plus public immutable coordinator;

    /// @notice The board generation allowed to request. Set once.
    address public board;

    // ─── Request policy (owner-tunable) ────────────────────────────────────

    /// @notice Gas lane. Read off Chainlink's supported-networks table.
    bytes32 public keyHash;
    /// @notice VRF v2.5 subscription this module is a consumer of.
    uint256 public subId;
    /// @notice Confirmations the node waits before answering.
    uint16  public requestConfirmations;
    /// @notice Gas budget for `rawFulfillRandomWords`. The callback only writes
    ///         two storage slots, so this is small — but it must cover the
    ///         coordinator's own overhead too.
    uint32  public callbackGasLimit;
    /// @notice v2.5 `extraArgs` blob (LINK vs native payment). Supplied whole
    ///         rather than re-encoded here: the tag is a Chainlink constant and
    ///         guessing it would silently produce requests the coordinator
    ///         rejects. Build it with VRFV2PlusClient._argsToBytes off-chain.
    bytes public extraArgs;

    /// @notice How long a pending request may sit before it can be replaced.
    uint256 public constant REREQUEST_DELAY = 30 minutes;

    // ─── State ─────────────────────────────────────────────────────────────

    struct Draw {
        uint256 requestId;
        uint256 word;
        uint64  requestedAt;
        bool    ready;      // one-way: a fulfilled draw is final
    }

    /// @notice salt (= keccak(tableId, segment) on the board) => draw.
    mapping(bytes32 => Draw) public draws;
    /// @notice requestId => salt, so the callback can find its draw.
    mapping(uint256 => bytes32) public saltOf;

    // ─── Events ────────────────────────────────────────────────────────────

    event BoardSet(address indexed board);
    event PolicySet(bytes32 keyHash, uint256 subId, uint16 confirmations, uint32 gasLimit);
    event ExtraArgsSet(bytes extraArgs);
    event DrawRequested(bytes32 indexed salt, uint256 indexed requestId, bool replacement);
    event DrawFulfilled(bytes32 indexed salt, uint256 indexed requestId);

    // ─── Errors ────────────────────────────────────────────────────────────

    error ZeroAddress();
    error NotBoard();
    error NotCoordinator();
    error BoardAlreadySet();
    error AlreadyRequested(bytes32 salt);
    error AlreadyFulfilled(bytes32 salt);
    error NothingPending(bytes32 salt);
    error TooSoonToReplace(bytes32 salt, uint64 requestedAt);
    error NotReady(bytes32 salt);
    error UnknownRequest(uint256 requestId);
    error NoWords();

    modifier onlyBoard() {
        if (msg.sender != board) revert NotBoard();
        _;
    }

    constructor(
        address _coordinator,
        bytes32 _keyHash,
        uint256 _subId,
        uint16  _requestConfirmations,
        uint32  _callbackGasLimit,
        bytes memory _extraArgs
    ) Ownable(msg.sender) {
        if (_coordinator == address(0)) revert ZeroAddress();
        coordinator          = IVRFCoordinatorV2Plus(_coordinator);
        keyHash              = _keyHash;
        subId                = _subId;
        requestConfirmations = _requestConfirmations;
        callbackGasLimit     = _callbackGasLimit;
        extraArgs            = _extraArgs;
    }

    // ─── Board: request ────────────────────────────────────────────────────

    /**
     * @notice Fire the draw for one table+segment. One request per salt, ever —
     *         except through `rerequest`, and never once fulfilled.
     */
    function requestFor(bytes32 salt) external onlyBoard returns (uint256 requestId) {
        Draw storage d = draws[salt];
        if (d.ready)          revert AlreadyFulfilled(salt);
        if (d.requestId != 0) revert AlreadyRequested(salt);
        return _fire(salt, d, false);
    }

    /**
     * @notice Replace a request that never came back. Permissionless — a stuck
     *         table is everyone's problem, and there is nothing to gain: the
     *         pending word is unknowable, so swapping it for another unknowable
     *         word is not a choice between outcomes.
     */
    function rerequest(bytes32 salt) external returns (uint256 requestId) {
        Draw storage d = draws[salt];
        if (d.ready)          revert AlreadyFulfilled(salt);
        if (d.requestId == 0) revert NothingPending(salt);
        if (block.timestamp < uint256(d.requestedAt) + REREQUEST_DELAY) {
            revert TooSoonToReplace(salt, d.requestedAt);
        }
        // The old requestId keeps its saltOf entry: if the stale request DOES
        // land later, the callback finds the draw and fills it, which is fine —
        // whichever word arrives first is the one nobody could predict.
        return _fire(salt, d, true);
    }

    function _fire(bytes32 salt, Draw storage d, bool replacement) internal returns (uint256 requestId) {
        requestId = coordinator.requestRandomWords(
            IVRFCoordinatorV2Plus.RandomWordsRequest({
                keyHash:              keyHash,
                subId:                subId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit:     callbackGasLimit,
                numWords:             1,
                extraArgs:            extraArgs
            })
        );
        d.requestId   = requestId;
        d.requestedAt = uint64(block.timestamp);
        saltOf[requestId] = salt;
        emit DrawRequested(salt, requestId, replacement);
    }

    // ─── Coordinator: callback ─────────────────────────────────────────────

    /**
     * @notice VRF callback. Kept deliberately tiny — it writes two words and
     *         emits. Settlement is NOT done here: a reverting callback would
     *         burn the request and strand the segment, so the board pulls the
     *         word in its own transaction once this has landed.
     */
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        if (msg.sender != address(coordinator)) revert NotCoordinator();
        if (randomWords.length == 0) revert NoWords();
        bytes32 salt = saltOf[requestId];
        if (salt == bytes32(0)) revert UnknownRequest(requestId);
        Draw storage d = draws[salt];
        if (d.ready) return;              // a replaced request landing late: ignore
        d.word  = randomWords[0];
        d.ready = true;
        emit DrawFulfilled(salt, requestId);
    }

    // ─── Views (the board's read path) ─────────────────────────────────────

    /// @notice Whether this segment's word has landed and can be locked.
    function isReady(bytes32 salt) external view returns (bool) {
        return draws[salt].ready;
    }

    /// @notice Whether a draw has been fired for this segment at all.
    function isRequested(bytes32 salt) external view returns (bool) {
        return draws[salt].requestId != 0;
    }

    /// @notice The segment's entropy word. Reverts until the callback lands, so
    ///         the board cannot lock a segment early even by mistake.
    /// @dev Hashed with the salt so the value the board consumes is domain-
    ///      separated from the raw VRF word, exactly as the commit-reveal module
    ///      hashed its inputs.
    function entropyFor(bytes32 salt) external view returns (bytes32) {
        Draw storage d = draws[salt];
        if (!d.ready) revert NotReady(salt);
        return keccak256(abi.encodePacked(d.word, salt));
    }

    /// @notice Whether `rerequest` would go through right now — the apps' and
    ///         auto-pilot's one-call check for a stuck segment.
    function replaceable(bytes32 salt) external view returns (bool) {
        Draw storage d = draws[salt];
        return !d.ready
            && d.requestId != 0
            && block.timestamp >= uint256(d.requestedAt) + REREQUEST_DELAY;
    }

    // ─── Owner ─────────────────────────────────────────────────────────────

    /// @notice Wire the board once. Renouncing ownership afterwards locks it.
    function setBoard(address _board) external onlyOwner {
        if (_board == address(0)) revert ZeroAddress();
        if (board != address(0))  revert BoardAlreadySet();
        board = _board;
        emit BoardSet(_board);
    }

    /**
     * @notice Retune the request policy. Cannot touch a draw that has already
     *         been fired or fulfilled — only what future requests look like —
     *         so the owner can never move an outcome.
     */
    function setPolicy(
        bytes32 _keyHash,
        uint256 _subId,
        uint16  _requestConfirmations,
        uint32  _callbackGasLimit
    ) external onlyOwner {
        keyHash              = _keyHash;
        subId                = _subId;
        requestConfirmations = _requestConfirmations;
        callbackGasLimit     = _callbackGasLimit;
        emit PolicySet(_keyHash, _subId, _requestConfirmations, _callbackGasLimit);
    }

    /// @notice Replace the v2.5 extraArgs blob (LINK vs native payment).
    function setExtraArgs(bytes calldata _extraArgs) external onlyOwner {
        extraArgs = _extraArgs;
        emit ExtraArgsSet(_extraArgs);
    }
}
