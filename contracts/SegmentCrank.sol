// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

interface ISegmentBoardCrank {
    function lockSegment(uint256 tableId, uint8 segment, bytes32 secret) external;
    function lockSegmentFallback(uint256 tableId, uint8 segment) external;
    function retire(uint256 tableId) external;
    function tables(uint256 tableId)
        external
        view
        returns (
            uint64 openedAt,
            uint64 pickTime,
            uint64 lockBlock,
            uint32 seedRound,
            uint8 seatCount,
            uint8 lockedMask,
            bool ddSettled,
            bool retired,
            bytes6 seedString,
            bytes6 lockedChars
        );
}

/**
 * @title SegmentCrank
 * @notice One wallet approval instead of seven. Locking a table is six
 *         transactions plus a retire, and every one of the board functions
 *         involved is PERMISSIONLESS — so batching them needs no privilege,
 *         only a contract to make the calls in sequence.
 *
 *         Stateless, ownerless, holds nothing, custodies nothing. It can be
 *         pointed at any board generation that keeps the same signatures, and
 *         throwing it away costs nothing.
 *
 * @dev The ARM is deliberately not included: locks must land in a later block
 *      than the arm (`SameBlockAsArm`), so arm-then-lock cannot be one
 *      transaction on an L2 where a transaction is a block. Arm first, then
 *      crank.
 *
 *      Secrets appear in calldata — exactly as public as they are when sent
 *      one by one; reveals were always public the moment they land.
 */
contract SegmentCrank {
    error NothingToDo(uint256 tableId);

    /// @notice Reveal-path batch: lock every still-open segment with its
    ///         secret, then optionally retire. Skips already-locked segments,
    ///         so a partial manual run can be finished with the crank.
    function lockAll(
        ISegmentBoardCrank board,
        uint256 tableId,
        bytes32[6] calldata secrets,
        bool alsoRetire
    ) external {
        uint8 mask = _mask(board, tableId);
        if (mask == 0x3F && !alsoRetire) revert NothingToDo(tableId);
        for (uint8 i; i < 6; ++i) {
            if (mask & (uint8(1) << i) != 0) continue;
            board.lockSegment(tableId, i + 1, secrets[i]);
        }
        if (alsoRetire) board.retire(tableId);
    }

    /// @notice Fallback-path batch: after the reveal window, finish the pick
    ///         with no secrets at all, then optionally retire. This is what
    ///         the play page's "finish the pick" should cost: one approval.
    function fallbackAll(
        ISegmentBoardCrank board,
        uint256 tableId,
        bool alsoRetire
    ) external {
        uint8 mask = _mask(board, tableId);
        if (mask == 0x3F && !alsoRetire) revert NothingToDo(tableId);
        for (uint8 i; i < 6; ++i) {
            if (mask & (uint8(1) << i) != 0) continue;
            board.lockSegmentFallback(tableId, i + 1);
        }
        if (alsoRetire) board.retire(tableId);
    }

    function _mask(ISegmentBoardCrank board, uint256 tableId) internal view returns (uint8 mask) {
        (, , , , , mask, , , , ) = board.tables(tableId);
    }
}
