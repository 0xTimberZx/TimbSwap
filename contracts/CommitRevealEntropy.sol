// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

/**
 * @title CommitRevealEntropy
 * @notice The "now" entropy source for a SegmentBoard generation: commit-reveal
 *         bound to a future block hash (spec §10.1/§10.4). Stateless and pure/
 *         view only — the board holds the per-segment commitments and lock
 *         blocks and calls in to verify a reveal and derive the entropy word.
 *
 * Design:
 *   - At table open the board stores `commitment = keccak256(secret, salt)` for
 *     each segment (salt binds it to tableId+segment). The protocol holds the
 *     secret off-chain.
 *   - At settle the board reveals the secret; `deriveEntropy` verifies it against
 *     the commitment and mixes in `blockhash(lockBlock)` — a value unknowable to
 *     everyone (the protocol included) until that block is mined, which is after
 *     bets close. That future block hash, not the secret, pins the outcome
 *     (exploit guard #1).
 *   - Swaps never enter here (exploit guard #2): entropy is a function only of
 *     the secret, the block hash, and the salt.
 *
 * Reveal-liveness:
 *   - `blockhash` only exposes the last 256 blocks, so the board must settle
 *     within that window (W < 256). If the block hash is unavailable the
 *     derivation reverts rather than silently using zero.
 *   - `fallbackEntropy` lets a missed reveal be settled permissionlessly from the
 *     block hash alone (no secret), so a table can never stall; the board slashes
 *     the protocol's bond in that path.
 *
 * Swappable: a later generation can deploy a VRF-backed module behind the same
 * board seam (spec §10.6). This contract is immutable and holds no state.
 */
contract CommitRevealEntropy {
    // ─── Errors ──────────────────────────────────────────────────────────────

    error BadReveal();
    error LockBlockUnavailable(uint256 lockBlock);
    error LockBlockNotPast(uint256 lockBlock);

    // ─── Commit ────────────────────────────────────────────────────────────────

    /**
     * @notice The commitment the board stores at table open for a segment.
     * @param secret The protocol's per-segment secret (revealed at settle).
     * @param salt   Binds the commitment to a specific table+segment.
     */
    function commitmentOf(bytes32 secret, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(secret, salt));
    }

    // ─── Reveal / derive ─────────────────────────────────────────────────────

    /**
     * @notice Verify a reveal against its commitment and derive the entropy word,
     *         mixing the lock block's hash. Reverts if the reveal is wrong or the
     *         block hash is no longer / not yet available.
     */
    function deriveEntropy(
        bytes32 commitment,
        bytes32 secret,
        uint256 lockBlock,
        bytes32 salt
    ) external view returns (bytes32) {
        if (commitmentOf(secret, salt) != commitment) revert BadReveal();
        bytes32 bh = _lockHash(lockBlock);
        return keccak256(abi.encodePacked(secret, bh, salt));
    }

    /**
     * @notice Permissionless fallback for a missed reveal: derive from the lock
     *         block hash alone (no secret). Still unpredictable before `lockBlock`
     *         is mined, so a detected fallback grants no edge (spec §10.6).
     */
    function fallbackEntropy(uint256 lockBlock, bytes32 salt)
        external
        view
        returns (bytes32)
    {
        bytes32 bh = _lockHash(lockBlock);
        return keccak256(abi.encodePacked(bh, salt, bytes32("fallback")));
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    /// @dev Fetch a past lock block's hash, reverting if it's the current/future
    ///      block or older than the 256-block horizon (hash returns zero).
    function _lockHash(uint256 lockBlock) internal view returns (bytes32) {
        if (lockBlock >= block.number) revert LockBlockNotPast(lockBlock);
        bytes32 bh = blockhash(lockBlock);
        if (bh == bytes32(0)) revert LockBlockUnavailable(lockBlock);
        return bh;
    }
}
