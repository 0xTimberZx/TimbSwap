// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title SeedRegistry
 * @notice The one long-lived, cross-generation record of which TimbPrize rounds
 *         have already been consumed as SegmentBoard seeds. Guarantees a winning
 *         string is never reused as a seed across ANY board generation.
 *
 * Design:
 *   - SegmentBoard is immutable and redeployed per generation; this registry is
 *     NOT — it outlives every generation so the never-reuse rule spans them all.
 *   - Append-only: a round can be marked used exactly once, and can never be
 *     un-used. There is no function that clears a mark.
 *   - Authorised writers are the deployed board generations. The owner adds each
 *     new generation as a writer; first-come wins if two draining generations
 *     race for the same round.
 *
 * Security:
 *   - Only a registered writer can mark a round used; only the owner can
 *     register/deregister writers.
 *   - Holds no funds. Owner is renounceable once the final generation is wired
 *     (after which no new writer can be added — the registry is frozen open,
 *     serving reads and the existing writers' marks forever).
 */
contract SeedRegistry is Ownable {
    // ─── State ─────────────────────────────────────────────────────────────────

    /// @notice TimbPrize round => whether it has been consumed as a seed.
    mapping(uint256 => bool) public usedRound;

    /// @notice Board generations authorised to mark rounds used.
    mapping(address => bool) public isWriter;

    /// @notice Lifetime count of rounds marked used (monotonic).
    uint256 public totalUsed;

    // ─── Events ────────────────────────────────────────────────────────────────

    event WriterAdded(address indexed writer);
    event WriterRemoved(address indexed writer);
    event SeedUsed(uint256 indexed round, address indexed writer);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error NotWriter();
    error AlreadyWriter();
    error UnknownWriter();
    error SeedAlreadyUsed(uint256 round);

    // ─── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyWriter() {
        if (!isWriter[msg.sender]) revert NotWriter();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor() Ownable(msg.sender) {}

    // ─── Writer: consume a seed ──────────────────────────────────────────────

    /**
     * @notice Mark a TimbPrize round consumed as a seed. Reverts if already used,
     *         so the same winning string can never seed two tables — across every
     *         generation. Called atomically by a board when it opens a table.
     */
    function markUsed(uint256 round) external onlyWriter {
        if (usedRound[round]) revert SeedAlreadyUsed(round);
        usedRound[round] = true;
        unchecked { ++totalUsed; }
        emit SeedUsed(round, msg.sender);
    }

    // ─── Owner: writer management ──────────────────────────────────────────────

    /// @notice Authorise a board generation to mark rounds used.
    function addWriter(address writer) external onlyOwner {
        if (writer == address(0)) revert ZeroAddress();
        if (isWriter[writer])     revert AlreadyWriter();
        isWriter[writer] = true;
        emit WriterAdded(writer);
    }

    /// @notice Deregister a writer (e.g. a fully-drained old generation).
    function removeWriter(address writer) external onlyOwner {
        if (!isWriter[writer]) revert UnknownWriter();
        isWriter[writer] = false;
        emit WriterRemoved(writer);
    }

    // ─── View ──────────────────────────────────────────────────────────────────

    /// @notice Whether `round` has already been consumed as a seed.
    function isUsed(uint256 round) external view returns (bool) {
        return usedRound[round];
    }
}
