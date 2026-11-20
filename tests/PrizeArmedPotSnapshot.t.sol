// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";

import "../contracts/PrizeEscrow.sol";
import "../contracts/TimbPrize.sol";
import "../contracts/VRFEntropy.sol";
import {MockPrizeVRF} from "./PrizeWindows.t.sol";
import {ScriptedRegistry} from "./TimbPrizeMoneyPaths.t.sol";

/**
 * The round's pot is frozen when its final segment arms. After the segment-6
 * VRF word lands the winning string is knowable before the lock, so anything
 * credited to the pot in that gap (top-ups, recycled winnings, lapse shares,
 * LP fees) must roll to the next round instead of the round being settled.
 */
contract PrizeArmedPotSnapshotTest is Test {
    PrizeEscrow      escrow;
    ScriptedRegistry registry;
    TimbPrize        prize;
    MockPrizeVRF     coord;
    VRFEntropy       entropy;

    address constant W1       = address(0x1001);
    address constant ATTACKER = address(0xBAD);

    event LateInflowDeferred(uint256 indexed round, uint256 amount);

    function setUp() public {
        escrow   = new PrizeEscrow();
        registry = new ScriptedRegistry();
        prize    = new TimbPrize(address(escrow), address(registry), address(this));
        registry.setPrize(prize);
        coord   = new MockPrizeVRF();
        entropy = new VRFEntropy(address(coord), bytes32(uint256(0xABC)), 42, 3, 200_000, hex"1234");
        entropy.setBoard(address(prize));
        prize.setEntropy(address(entropy));
        escrow.setTimbPrize(address(prize));
        prize.startGame();
        registry.add(W1, ScriptedRegistry.Mode.Match); // W1 wins every round
        vm.deal(ATTACKER, 10 ether);
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    function _armAndFulfil() internal {
        uint256 r = prize.currentRound();
        uint256 s = prize.currentSegment();
        vm.warp(prize.segmentStartTime() + prize.INTERACTION_WINDOW() + 1);
        prize.settleSegment();                                   // arm
        (uint256 reqId,,, bool ready) = entropy.draws(prize.saltFor(r, s));
        if (!ready) coord.fulfil(address(entropy), reqId, uint256(keccak256(abi.encode(r, s))));
    }

    function _settleOneSegment() internal {
        _armAndFulfil();
        prize.settleSegment();                                   // lock (+ settle on segment 6)
    }

    /// Settle segments 1-5, then arm segment 6 and land its word. The winning
    /// string is now knowable; the lock has not run.
    function _toFinalWordLanded() internal {
        while (prize.currentSegment() < prize.SEGMENTS_PER_ROUND()) _settleOneSegment();
        _armAndFulfil();
    }

    function _settleRound() internal {
        uint256 r = prize.currentRound();
        while (prize.currentRound() == r) _settleOneSegment();
    }

    // ─── Tests ──────────────────────────────────────────────────────────────

    /// The snapshot is taken at the final segment's arm and cleared at settle.
    function test_SnapshotTakenAtFinalArmAndCleared() public {
        prize.fundPot{value: 1 ether}();
        while (prize.currentSegment() < prize.SEGMENTS_PER_ROUND()) {
            _settleOneSegment();
            assertEq(prize.armedPot(), 0, "no snapshot on segments 1-5");
        }
        _armAndFulfil();
        assertEq(prize.armedPot(), 1 ether, "snapshot at the segment-6 arm");
        prize.settleSegment();
        assertEq(prize.currentRound(), 2);
        assertEq(prize.armedPot(), 0, "cleared at settle");
    }

    /// A top-up made after the final word lands is not paid to the round being
    /// settled; it rolls to the next round.
    function test_TopUpAfterFinalWord_RollsToNextRound() public {
        prize.fundPot{value: 1 ether}();
        _toFinalWordLanded();

        vm.prank(ATTACKER);
        prize.addToPot{value: 0.5 ether}();

        vm.expectEmit(true, false, false, true, address(prize));
        emit LateInflowDeferred(1, 0.5 ether);
        prize.settleSegment();

        (, uint256 pot, address[] memory winners, uint256 perWinner, uint256 remainder) = prize.getRoundResult(1);
        assertEq(winners.length, 1);
        assertEq(pot, 0.98 ether, "round 1 pays the armed pot less the 2% cut");
        assertEq(perWinner, 0.98 ether);
        assertEq(remainder, 0);
        assertEq(prize.currentAccumulatedRewards(), 0.5 ether, "late top-up carried to round 2");
        assertEq(prize.gameUnclaimed_winningsPool(), 0.98 ether);
    }

    /// The reported path: an expired round's unclaimed winnings recycled
    /// between the final word and the lock go to the next round.
    function test_RecycleAfterFinalWord_RollsToNextRound() public {
        prize.fundPot{value: 1 ether}();
        _settleRound();                                          // round 1: W1 wins 0.98, never claims
        assertEq(prize.gameUnclaimed_winningsPool(), 0.98 ether);

        // Run empty rounds until round 1's claim window has passed.
        while (prize.currentRound() <= 1 + prize.CLAIM_WINDOW_ROUNDS()) _settleRound();
        uint256 r = prize.currentRound();
        assertEq(prize.currentAccumulatedRewards(), 0, "empty pot going in");

        _toFinalWordLanded();
        vm.prank(ATTACKER);
        prize.recycleUnclaimed(1);
        assertEq(prize.currentAccumulatedRewards(), 0.98 ether, "recycled into the live counter");
        prize.settleSegment();

        (, uint256 pot,, uint256 perWinner,) = prize.getRoundResult(r);
        assertEq(pot, 0, "the known winner's round gains nothing");
        assertEq(perWinner, 0);
        assertEq(prize.currentAccumulatedRewards(), 0.98 ether, "recycled winnings roll forward");

        // The next round pays it normally.
        _settleRound();
        (, uint256 nextPot,,,) = prize.getRoundResult(r + 1);
        assertEq(nextPot, 0.98 ether - (0.98 ether * 200) / 10_000, "paid in the next round, less the cut");
    }

    /// Inflows before the final arm still count for the current round.
    function test_TopUpBeforeFinalArm_CountsThisRound() public {
        prize.fundPot{value: 1 ether}();
        while (prize.currentSegment() < prize.SEGMENTS_PER_ROUND()) _settleOneSegment();
        vm.prank(ATTACKER);
        prize.addToPot{value: 0.5 ether}();                      // segment 6 still open
        _settleOneSegment();

        (, uint256 pot,,,) = prize.getRoundResult(1);
        assertEq(pot, 1.47 ether, "1.5 ETH less the 2% cut");
        assertEq(prize.currentAccumulatedRewards(), 0, "nothing deferred");
    }

    /// Escrow stays fully backed: every wei in PrizeEscrow is either owed to
    /// winners, the protocol cut, or the live pot.
    function test_EscrowBackingHoldsAcrossTheGap() public {
        prize.fundPot{value: 1 ether}();
        _toFinalWordLanded();
        vm.prank(ATTACKER);
        prize.addToPot{value: 0.3 ether}();
        prize.settleSegment();
        assertEq(
            address(escrow).balance,
            prize.gameUnclaimed_winningsPool() + prize.protocolCutAccrued() + prize.currentAccumulatedRewards(),
            "escrow == owed + cut + live pot"
        );
    }
}
