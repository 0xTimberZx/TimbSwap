// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../contracts/TimbSwapRouter.sol";

// ─── Mock prize ───────────────────────────────────────────────────────────────
// Only the surface the router's free-nudge path touches: currentRound(),
// currentSegment(), nudgeScroll(). A fresh instance stands in for a new game
// generation (each generation deploys a new TimbPrize).
contract MockPrize {
    uint256 public currentRound;
    uint256 public currentSegment;
    uint256 public nudged;

    function set(uint256 r, uint256 s) external { currentRound = r; currentSegment = s; }
    function nudgeScroll() external { nudged++; }
    function isSettlementWindow() external pure returns (bool) { return false; }
}

contract RouterFreeNudgeTest is Test {
    TimbSwapRouter router;
    MockPrize prizeA;
    MockPrize prizeB;

    address factory  = address(0xF00);   // constructor only null-checks these
    address treasury = address(0x7EA);
    address alice    = address(0xA11CE);

    uint256 constant CAP = 10; // freeNudgeCapPerSeg default

    function setUp() public {
        prizeA = new MockPrize();
        prizeB = new MockPrize();
        prizeA.set(1, 2);
        prizeB.set(1, 2); // same (round, segment) as A — the collision case

        router = new TimbSwapRouter(factory, treasury, address(0), address(prizeA));
        // owner == this; default freeNudgeCapPerSeg == 10.
    }

    function test_FreshWalletHasFullCap() public {
        assertEq(router.freeNudgesRemaining(alice), CAP);
    }

    function test_AdvanceConsumesCap() public {
        vm.prank(alice);
        router.advanceScroll(3);
        assertEq(prizeA.nudged(), 3, "3 nudges applied");
        assertEq(router.freeNudgesRemaining(alice), CAP - 3);
    }

    function test_PerSegmentResetWithinGeneration() public {
        vm.prank(alice);
        router.advanceScroll(CAP);
        assertEq(router.freeNudgesRemaining(alice), 0, "spent this segment");

        prizeA.set(1, 3); // next segment
        assertEq(router.freeNudgesRemaining(alice), CAP, "cap resets each segment");
    }

    // The gen-3 bug: a reused router must NOT carry a wallet's free-nudge usage
    // from a prior generation's (round, segment) into the new generation's.
    function test_GenerationIsolationAcrossPrizeSwap() public {
        // Spend the whole cap under prize A at round 1 / segment 2.
        vm.prank(alice);
        router.advanceScroll(CAP);
        assertEq(router.freeNudgesRemaining(alice), 0, "spent under prize A");

        // Migrate: repoint the reused router at a fresh prize, same (round, seg).
        router.setTimbPrize(address(prizeB));

        // Under the OLD key (round, seg, user) this would still read 0. Namespaced
        // by the prize instance, the new generation starts clean.
        assertEq(router.freeNudgesRemaining(alice), CAP, "fresh generation resets");

        vm.prank(alice);
        router.advanceScroll(4);
        assertEq(prizeB.nudged(), 4, "nudges land on the new prize");
        assertEq(prizeA.nudged(), CAP, "old prize untouched");
        assertEq(router.freeNudgesRemaining(alice), CAP - 4);
    }

    function test_CapReachedReverts() public {
        vm.prank(alice);
        router.advanceScroll(CAP);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.FreeNudgeCapReached.selector, uint256(1), uint256(2)));
        router.advanceScroll(1);
    }
}
