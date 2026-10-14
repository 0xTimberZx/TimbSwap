// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import {PrizeWindowsTest} from "./PrizeWindows.t.sol";

/// TS-051: the distinct-char draw is uniform over the chars of the class that
/// are not yet locked. The earlier linear probe slid a VRF start that hit a
/// locked char forward to the next free one, so the char after a run of locked
/// chars absorbed every start on that run: ABCDEF won 720/26^6 against a flat
/// string's 1/26^6, 012345 won 1 in 1,389 against a fair 1 in 151,200.
///
/// The lock now draws `mix % free` and walks to that free char. Over the `free`
/// residues of the mix each free char must be hit exactly once and a locked
/// char never, for every prefix of a run string — which is exactly what the
/// probe failed (the k-th char of the run collected k residues).
contract DistinctDrawFairnessTest is PrizeWindowsTest {
    /// @dev A VRF word whose mix `keccak(word, salt) % modulus == residue`.
    function _wordForResidue(uint256 round, uint256 seg, uint256 residue, uint256 modulus)
        internal view returns (uint256 w)
    {
        bytes32 salt = prize.saltFor(round, seg);
        for (w = 1; ; w++) {
            if (uint256(keccak256(abi.encodePacked(w, salt))) % modulus == residue) return w;
        }
    }

    /// @dev arm + fulfil + lock the current segment with a chosen VRF word.
    function _lockWith(uint256 word) internal returns (bytes1 c) {
        uint256 round = prize.currentRound();
        uint256 seg   = prize.currentSegment();
        vm.warp(prize.segmentStartTime() + prize.INTERACTION_WINDOW() + 1);
        prize.settleSegment();                                   // arm
        (uint256 reqId, , , ) = entropy.draws(prize.saltFor(round, seg));
        coord.fulfil(address(entropy), reqId, word);
        prize.settleSegment();                                   // lock (+ roll on seg 6)
        if (seg < 6) c = prize.segmentLockedChar(seg);
        else         c = prize.roundWinningString(round)[5];
    }

    /// @dev For every segment, run the real lock once per residue of the mix
    ///      modulo the free count, with `target[0..k-1]` already locked. Returns
    ///      how many residues landed on target[k] and asserts that no locked
    ///      char was ever drawn and every free char was drawn exactly once.
    function _hitsFor(bytes6 target) internal returns (uint256[6] memory hits) {
        uint256 root  = vm.snapshotState();
        uint256 round = prize.currentRound();
        for (uint256 seg = 1; seg <= 6; seg++) {
            uint256 free = 26 - (seg - 1);
            uint256 hitWord;
            uint256 seenMask;
            for (uint256 r = 0; r < free; r++) {
                uint256 snap = vm.snapshotState();
                uint256 w    = _wordForResidue(round, seg, r, free);
                bytes1  got  = _lockWith(w);
                vm.revertToState(snap);

                uint256 idx = uint256(uint8(got)) - 0x41;            // 'A' == 0x41
                assertTrue(idx < 26, "letter class");
                for (uint256 j = 0; j + 1 < seg; j++) {
                    assertTrue(got != target[j], "drew an already-locked char");
                }
                assertEq(seenMask & (1 << idx), 0, "free char drawn twice");
                seenMask |= (1 << idx);
                if (got == target[seg - 1]) { hits[seg - 1]++; if (hitWord == 0) hitWord = w; }
            }
            assertEq(hits[seg - 1], 1, "every free char owns exactly one residue");
            if (seg < 6) _lockWith(hitWord);                      // lock this char, move on
        }
        vm.revertToState(root);
    }

    function test_TS051_RunStringNoLongerFavoured() public {
        assertFalse(registry.allowRepeatedChars(), "default: distinct draw");
        uint256[6] memory run  = _hitsFor(bytes6("ABCDEF"));
        uint256[6] memory flat = _hitsFor(bytes6("ACEGIK"));
        for (uint256 i = 0; i < 6; i++) {
            // the old probe gave run[i] == i + 1 (A:1, B:2, ... F:6)
            assertEq(run[i],  1, "run char no longer absorbs the run before it");
            assertEq(flat[i], 1, "non-adjacent char unchanged");
        }
    }

    function test_TS051_WinningStringStillDistinct() public {
        for (uint256 r = 1; r <= 6; r++) {
            for (uint256 s = 0; s < 6; s++) settleOne();
            assertFalse(hasRepeats(prize.roundWinningString(r)), "repeat in winning string");
        }
    }
}
