// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";

import "../contracts/PrizeEscrow.sol";
import "../contracts/GameRegistry.sol";
import "../contracts/TimbPrize.sol";
import "../contracts/VRFEntropy.sol";
import {MockTIMBS, MockPrizeVRF} from "./PrizeWindows.t.sol";

/**
 * @title PrizeSegmentClockTest
 * @notice A lock within GRID_GRACE of the 60-minute mark anchors the next
 *         segment to the grid; a later lock starts it at lock time. A late VRF
 *         word must not shorten the following segment's interaction window.
 */
contract PrizeSegmentClockTest is Test {
    TimbPrize    prize;
    MockPrizeVRF coord;
    VRFEntropy   entropy;
    GameRegistry registry;

    function setUp() public {
        MockTIMBS timbs = new MockTIMBS();
        PrizeEscrow escrow = new PrizeEscrow();
        registry = new GameRegistry(address(timbs), address(0xBEEF), address(0), 2e18, 1e18);
        prize    = new TimbPrize(address(escrow), address(registry), address(this));
        coord    = new MockPrizeVRF();
        entropy  = new VRFEntropy(address(coord), bytes32(uint256(0xABC)), 42, 3, 200_000, hex"1234");
        entropy.setBoard(address(prize));
        prize.setEntropy(address(entropy));
        registry.setTimbPrize(address(prize));
        escrow.setTimbPrize(address(prize));
        prize.startGame();
    }

    /// @dev Arm at `armAt`, fulfil, lock at `lockAt`. Returns the segment start
    ///      the lock produced.
    function _settleAt(uint256 armAt, uint256 lockAt) internal returns (uint256) {
        uint256 round = prize.currentRound();
        uint256 seg   = prize.currentSegment();
        vm.warp(armAt);
        prize.settleSegment();
        (uint256 reqId, , , ) = entropy.draws(prize.saltFor(round, seg));
        coord.fulfil(address(entropy), reqId, uint256(keccak256(abi.encode(round, seg))));
        vm.warp(lockAt);
        prize.settleSegment();
        if (prize.currentRound() > round) {
            registry.onRoundSettled(round, 0);
        }
        return prize.segmentStartTime();
    }

    function _armTime(uint256 start) internal view returns (uint256) {
        return start + prize.INTERACTION_WINDOW() + 1;
    }

    function test_OnTimeLock_StaysOnGrid() public {
        uint256 start = prize.segmentStartTime();
        uint256 grid  = start + prize.SEGMENT_DURATION();
        uint256 next  = _settleAt(_armTime(start), grid + 5);
        assertEq(next, grid, "on-time lock anchors to the grid mark");
        assertEq(prize.currentSegment(), 2);
    }

    function test_IntermissionLock_StartsAtGridMark() public {
        uint256 start = prize.segmentStartTime();
        uint256 grid  = start + prize.SEGMENT_DURATION();
        uint256 next  = _settleAt(_armTime(start), _armTime(start) + 2);
        assertEq(next, grid, "a lock inside the intermission dates the next segment at 60:00");
    }

    function test_LateLock_NextSegmentKeepsFullWindow() public {
        uint256 start  = prize.segmentStartTime();
        uint256 grid   = start + prize.SEGMENT_DURATION();
        uint256 lockAt = grid + 52 minutes; // the 2026-09-28 testnet case
        uint256 next   = _settleAt(_armTime(start), lockAt);
        assertEq(next, lockAt, "late lock starts the next segment at lock time");
        assertEq(prize.timeRemainingInSegment(), prize.INTERACTION_WINDOW(),
            "the next segment gets its full interaction window");
    }

    function test_LockAtGraceEdge_StaysOnGrid() public {
        uint256 start = prize.segmentStartTime();
        uint256 grid  = start + prize.SEGMENT_DURATION();
        assertEq(_settleAt(_armTime(start), grid + prize.GRID_GRACE()), grid);
    }

    function test_LockJustPastGrace_StartsAtLockTime() public {
        uint256 start  = prize.segmentStartTime();
        uint256 lockAt = start + prize.SEGMENT_DURATION() + prize.GRID_GRACE() + 1;
        assertEq(_settleAt(_armTime(start), lockAt), lockAt);
    }

    function test_DeepStall_StartsAtLockTime() public {
        uint256 start  = prize.segmentStartTime();
        uint256 lockAt = start + 3 * prize.SEGMENT_DURATION();
        assertEq(_settleAt(_armTime(start), lockAt), lockAt);
    }

    function test_LateRoundRollover_NewRoundKeepsFullWindow() public {
        // Segments 1-5 on time.
        for (uint256 i = 0; i < 5; i++) {
            uint256 s = prize.segmentStartTime();
            _settleAt(_armTime(s), s + prize.SEGMENT_DURATION() + 1);
        }
        assertEq(prize.currentSegment(), 6);
        uint256 start  = prize.segmentStartTime();
        uint256 lockAt = start + prize.SEGMENT_DURATION() + 40 minutes;
        uint256 next   = _settleAt(_armTime(start), lockAt);
        assertEq(prize.currentRound(), 2);
        assertEq(prize.currentSegment(), 1);
        assertEq(next, lockAt, "late rollover starts round 2 at lock time");
        assertEq(prize.timeRemainingInSegment(), prize.INTERACTION_WINDOW());
    }
}
