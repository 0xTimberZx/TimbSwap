// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../contracts/TimbSwapRouter.sol";

// ─── Mocks ────────────────────────────────────────────────────────────────────
// Only the surface the router's free-nudge path touches. A fresh MockPrize
// stands in for a new game generation (each generation deploys a new TimbPrize).
contract MockPrize {
    uint256 public currentRound;
    uint256 public currentSegment;
    uint256 public nudged;
    uint256 public positionCounter;
    address public gameRegistry;
    bool    public frozen; // TS-029: awaiting VRF — nudgeScroll is a no-op
    uint256 public settleAt;      // nudge number that settles the segment (0 = never)
    bool    public settleRollsRound; // the settling nudge also starts the next round

    function setFrozen(bool f) external { frozen = f; }
    function setRegistry(address r) external { gameRegistry = r; }
    function set(uint256 r, uint256 s) external { currentRound = r; currentSegment = s; }
    function setSettleAt(uint256 n, bool rollsRound) external { settleAt = n; settleRollsRound = rollsRound; }

    function nudgeScroll() external {
        if (frozen) return;
        nudged++;
        positionCounter++;
        if (nudged == settleAt) {
            if (settleRollsRound) { currentRound++; currentSegment = 1; }
            else currentSegment++;
        }
    }
    function isSettlementWindow() external pure returns (bool) { return false; }
}

contract MockRegistry {
    mapping(address => mapping(uint256 => bool)) public holder;
    mapping(uint256 => uint256) public live;
    function setHolder(address w, uint256 round, bool v) external { holder[w][round] = v; }
    function setLive(uint256 round, uint256 n) external { live[round] = n; }
    function verifyEntryValid(address player, uint256 round) external view returns (bool, bytes6) {
        return (holder[player][round], bytes6(0));
    }
    function liveEntrantCount(uint256 round) external view returns (uint256) { return live[round]; }
}

contract RouterFreeNudgeTest is Test {
    TimbSwapRouter router;
    MockPrize prizeA;
    MockPrize prizeB;
    MockRegistry reg;

    address factory  = address(0xF00);   // constructor only null-checks these
    address treasury = address(0x7EA);
    address weth     = address(0x9E14);   // non-zero; ETH swaps not exercised here
    address alice    = address(0xA11CE);  // no ticket: public pool
    address holder   = address(0x4011);   // ticket in play

    uint256 constant TICKET = 10; // own allowance per segment
    uint256 constant PUB    = 3;  // public share per wallet per segment
    uint256 constant FLOOR  = 40; // test floor (the real one stays out of the repo)
    uint256 constant PER    = 10; // public pool growth per live ticket

    function setUp() public {
        reg = new MockRegistry();
        prizeA = new MockPrize();
        prizeB = new MockPrize();
        prizeA.set(1, 2);
        prizeB.set(1, 2); // same (round, segment) as A — the collision case
        prizeA.setRegistry(address(reg));
        prizeB.setRegistry(address(reg));

        router = new TimbSwapRouter(factory, treasury, address(0), address(prizeA), weth);
        router.setFreeNudgeConfig(TICKET, PUB, FLOOR, PER); // owner == this
        reg.setHolder(holder, 1, true);
    }

    function _wallet(uint256 i) internal pure returns (address) {
        return address(uint160(0x10000 + i));
    }

    // ─── Defaults and config ──────────────────────────────────────────────────

    function test_DefaultsKeepTheFloorOutOfSource() public {
        TimbSwapRouter fresh = new TimbSwapRouter(factory, treasury, address(0), address(prizeA), weth);
        assertEq(fresh.ticketNudgesPerSeg(), 10);
        assertEq(fresh.publicNudgesPerWallet(), 3);
        assertEq(fresh.perTicketPublicNudges(), 10);
        // Floor starts at 0, so with no live tickets the public pool is empty
        // until the deploy sets it.
        assertEq(fresh.freeNudgesRemaining(alice), 0, "no floor, no tickets: empty pool");
        reg.setLive(1, 1);
        assertEq(fresh.freeNudgesRemaining(alice), PUB, "a live ticket opens the pool");
    }

    function test_ConfigBounds() public {
        uint256 maxW = router.MAX_FREE_NUDGES_PER_WALLET();
        uint256 maxF = router.MAX_PUBLIC_NUDGE_FLOOR();
        uint256 maxT = router.MAX_PER_TICKET_PUBLIC();
        vm.expectRevert(TimbSwapRouter.FreeNudgeConfigOutOfRange.selector);
        router.setFreeNudgeConfig(maxW + 1, PUB, FLOOR, PER);
        vm.expectRevert(TimbSwapRouter.FreeNudgeConfigOutOfRange.selector);
        router.setFreeNudgeConfig(TICKET, maxW + 1, FLOOR, PER);
        vm.expectRevert(TimbSwapRouter.FreeNudgeConfigOutOfRange.selector);
        router.setFreeNudgeConfig(TICKET, PUB, maxF + 1, PER);
        vm.expectRevert(TimbSwapRouter.FreeNudgeConfigOutOfRange.selector);
        router.setFreeNudgeConfig(TICKET, PUB, FLOOR, maxT + 1);
    }

    function test_ConfigIsOwnerOnly() public {
        vm.prank(alice);
        vm.expectRevert();
        router.setFreeNudgeConfig(TICKET, PUB, FLOOR, PER);
    }

    function test_AllZeroTurnsTheFreePathOff() public {
        router.setFreeNudgeConfig(0, 0, FLOOR, PER);
        assertEq(router.freeNudgeCapPerSeg(), 0, "compat view reads off");
        assertEq(router.freeNudgesRemaining(alice), 0);
        assertEq(router.freeNudgesRemaining(holder), 0);
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.FreeNudgeCapReached.selector, 1, 2));
        router.advanceScroll(1);
    }

    function test_CompatCapViewIsTheLargerAllowance() public {
        assertEq(router.freeNudgeCapPerSeg(), TICKET);
        router.setFreeNudgeConfig(2, 5, FLOOR, PER);
        assertEq(router.freeNudgeCapPerSeg(), 5);
    }

    // ─── Ticket holders ───────────────────────────────────────────────────────

    function test_HolderGetsOwnAllowance() public {
        assertEq(router.freeNudgesRemaining(holder), TICKET);
        vm.prank(holder);
        router.advanceScroll(TICKET + 5); // clamped
        assertEq(prizeA.nudged(), TICKET, "clamped to the ticket allowance");
        assertEq(router.freeNudgesRemaining(holder), 0);
    }

    function test_HolderNeverDrawsOnThePublicPool() public {
        vm.prank(holder);
        router.advanceScroll(TICKET);
        bytes32 k = keccak256(abi.encode(address(prizeA), uint256(1), uint256(2)));
        assertEq(router.publicNudgesUsed(k), 0, "public pool untouched");
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.FreeNudgeCapReached.selector, 1, 2));
        router.advanceScroll(1);
    }

    function test_HolderResetsEachSegment() public {
        vm.prank(holder);
        router.advanceScroll(TICKET);
        prizeA.set(1, 3);
        assertEq(router.freeNudgesRemaining(holder), TICKET);
    }

    function test_PendingTicketGivesNothingUntilItsRound() public {
        // A ticket for round 2 (still cancellable) is not a holder in round 1.
        address pending = address(0x9E9D);
        reg.setHolder(pending, 2, true);
        assertEq(router.freeNudgesRemaining(pending), PUB, "public share only");
        prizeA.set(2, 1);
        assertEq(router.freeNudgesRemaining(pending), TICKET, "own allowance once in play");
    }

    function test_ConcedeMidSegmentCannotAddAPublicShare() public {
        vm.prank(holder);
        router.advanceScroll(TICKET);
        reg.setHolder(holder, 1, false); // conceded mid-round: no longer valid
        assertEq(router.freeNudgesRemaining(holder), 0, "shared counter: already spent more than 3");
    }

    // ─── Public pool ──────────────────────────────────────────────────────────

    function test_NonHolderCappedPerWallet() public {
        assertEq(router.freeNudgesRemaining(alice), PUB);
        vm.prank(alice);
        router.advanceScroll(20); // clamped
        assertEq(prizeA.nudged(), PUB);
        assertEq(router.freeNudgesRemaining(alice), 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.FreeNudgeCapReached.selector, 1, 2));
        router.advanceScroll(1);
    }

    function test_PoolCapsTheTotalAcrossWallets() public {
        // FLOOR 40 at 3 per wallet: 13 wallets take 39, the 14th gets 1, the 15th none.
        for (uint256 i = 0; i < 13; i++) {
            vm.prank(_wallet(i));
            router.advanceScroll(PUB);
        }
        assertEq(prizeA.nudged(), 39);
        assertEq(router.freeNudgesRemaining(_wallet(13)), 1, "last unit of the pool");
        vm.prank(_wallet(13));
        router.advanceScroll(PUB);
        assertEq(prizeA.nudged(), FLOOR, "pool exhausted");
        assertEq(router.freeNudgesRemaining(_wallet(14)), 0);
        vm.prank(_wallet(14));
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.FreeNudgeCapReached.selector, 1, 2));
        router.advanceScroll(1);
        // Holders are unaffected by an empty public pool.
        assertEq(router.freeNudgesRemaining(holder), TICKET);
    }

    function test_PoolGrowsWithLiveTickets() public {
        for (uint256 i = 0; i < 14; i++) { vm.prank(_wallet(i)); router.advanceScroll(PUB); }
        assertEq(router.freeNudgesRemaining(_wallet(20)), 0, "floor spent");
        reg.setLive(1, 2); // two tickets in play: +20
        assertEq(router.freeNudgesRemaining(_wallet(20)), PUB, "pool reopened");
        bytes32 k = keccak256(abi.encode(address(prizeA), uint256(1), uint256(2)));
        assertEq(router.publicNudgesUsed(k), FLOOR);
    }

    function test_PoolResetsEachSegment() public {
        for (uint256 i = 0; i < 14; i++) { vm.prank(_wallet(i)); router.advanceScroll(PUB); }
        prizeA.set(1, 3);
        assertEq(router.freeNudgesRemaining(_wallet(0)), PUB, "new segment, fresh pool and share");
    }

    function test_NoRegistryMeansFloorOnlyAndNoHolders() public {
        prizeA.setRegistry(address(0));
        assertEq(router.freeNudgesRemaining(holder), PUB, "no registry: nobody is a holder");
        assertEq(router.freeNudgesRemaining(alice), PUB);
    }

    // ─── Generations and settlement edges (kept from the per-address cap) ─────

    // The gen-3 bug: a reused router must NOT carry usage from a prior
    // generation's (round, segment) into the new generation's.
    function test_GenerationIsolationAcrossPrizeSwap() public {
        vm.prank(alice);
        router.advanceScroll(PUB);
        for (uint256 i = 0; i < 12; i++) { vm.prank(_wallet(i)); router.advanceScroll(PUB); }
        vm.prank(_wallet(12));
        router.advanceScroll(1); // 3 + 36 + 1 = the whole floor of 40
        assertEq(router.freeNudgesRemaining(alice), 0, "spent under prize A");
        assertEq(router.freeNudgesRemaining(_wallet(13)), 0, "pool spent under prize A");

        router.setTimbPrize(address(prizeB));
        assertEq(router.freeNudgesRemaining(alice), PUB, "fresh generation resets wallet");
        assertEq(router.freeNudgesRemaining(_wallet(13)), PUB, "fresh generation resets the pool");

        vm.prank(alice);
        router.advanceScroll(2);
        assertEq(prizeB.nudged(), 2, "nudges land on the new prize");
        assertEq(router.freeNudgesRemaining(alice), PUB - 2);
    }

    // TS-013: a batch that settles the segment mid-way must not carry the rest
    // of the batch into the next segment uncharged.
    function test_TS013_BatchStopsAtSettlement() public {
        prizeA.setSettleAt(1, false); // the first nudge settles segment 2 -> 3
        vm.prank(holder);
        router.advanceScroll(TICKET);
        assertEq(prizeA.nudged(), 1, "batch ends once the segment moves");
        assertEq(prizeA.currentSegment(), 3);
        assertEq(router.freeNudgesRemaining(holder), TICKET - 1, "landed nudge charged to the new segment");

        vm.prank(holder);
        router.advanceScroll(TICKET);
        assertEq(prizeA.nudged(), TICKET, "at most TICKET nudges in the new segment");
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.FreeNudgeCapReached.selector, 1, 3));
        router.advanceScroll(1);
    }

    // TS-013 across a round boundary: the landed nudge is charged with the
    // caller's status in the NEW round (here: no ticket there, so public pool).
    function test_TS013_LandingInNextRoundChargesItsPool() public {
        prizeA.setSettleAt(1, true); // first nudge settles the round: (1,2) -> (2,1)
        vm.prank(holder);
        router.advanceScroll(5);
        assertEq(prizeA.nudged(), 1);
        bytes32 k = keccak256(abi.encode(address(prizeA), uint256(2), uint256(1)));
        assertEq(router.publicNudgesUsed(k), 1, "charged to round 2's public pool");
        assertEq(router.freeNudgesRemaining(holder), PUB - 1, "no ticket in round 2: public share");
    }

    // TS-029: a no-op nudge (segment awaiting its VRF word) must not spend the
    // caller's allowance or the pool, and the batch ends at the first no-op.
    function test_TS029_NoopNudgeIsNotCharged() public {
        prizeA.setFrozen(true);
        vm.prank(alice);
        router.advanceScroll(3);
        assertEq(prizeA.nudged(), 0, "nothing applied");
        assertEq(router.freeNudgesRemaining(alice), PUB, "allowance untouched");
        bytes32 k = keccak256(abi.encode(address(prizeA), uint256(1), uint256(2)));
        assertEq(router.publicNudgesUsed(k), 0, "pool untouched");

        prizeA.setFrozen(false);
        vm.prank(alice);
        router.advanceScroll(2);
        assertEq(prizeA.nudged(), 2);
        assertEq(router.freeNudgesRemaining(alice), PUB - 2, "real nudges still charged");
    }

    function test_InvalidCountReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidNudgeCount.selector, 0, 20));
        router.advanceScroll(0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidNudgeCount.selector, 21, 20));
        router.advanceScroll(21);
    }
}
