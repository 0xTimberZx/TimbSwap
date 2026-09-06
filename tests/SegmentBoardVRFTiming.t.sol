// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

// Run: forge test --match-contract SegmentBoardVRFTimingTest -vvv
//
// Adaptive entry timing and the bonus-chip rule, on the LIVE board.
//
// Companion to `SegmentBoardVRFEconomics.t.sol`. That one ported gen-6's money
// rules; this one ports gen-5's adaptive entry windows and gen-7's bonus-chip
// gate — the other two things gen-8 inherited wholesale and that had no test
// pointed at the board actually running.
//
// None of this is entropy-dependent: entry clocks, late loading and the chip
// ladder behave identically whichever way a character is drawn. That is exactly
// why it is worth having here — code that did not change is still code that
// ships, and the only suites guarding it were aimed at a board that can never be
// deployed again.
//
// Two adaptations from the gen-5 originals:
//   • `armTable(id)` became `armSegment(id, seg)`, so "can this table arm?" is
//     asked of a single segment;
//   • `tables()` is a 16-tuple (gen-5 appended four fields, gen-6 `opener`,
//     gen-8 `armedMask`), so the positional reads carry two trailing gaps.

import "forge-std/Test.sol";
import "../contracts/SegmentBoardVRF.sol";
import "../contracts/VRFEntropy.sol";
import "../contracts/PoolLedger.sol";
import "../contracts/SeedRegistry.sol";
import "../contracts/UnderwriteReserve.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockTIMBST is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") {}
    function mintTo(address to, uint256 amt) external { _mint(to, amt); }
}

contract MockTimbPrizeT {
    mapping(uint256 => bytes6) public roundWinningString;
    function setResult(uint256 round, bytes6 s) external { roundWinningString[round] = s; }
}

contract MockVRFCoordinatorT is IVRFCoordinatorV2Plus {
    uint256 public nextId = 1;
    function requestRandomWords(RandomWordsRequest calldata) external returns (uint256) {
        return nextId++;
    }
    function fulfil(address consumer, uint256 requestId, uint256 word) external {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        VRFEntropy(consumer).rawFulfillRandomWords(requestId, words);
    }
}

contract SegmentBoardVRFTimingTest is Test {
    MockTIMBST          timbs;
    MockTimbPrizeT      prize;
    MockVRFCoordinatorT coord;
    VRFEntropy          ent;
    PoolLedger          ledger;
    SeedRegistry        registry;
    UnderwriteReserve   reserve;
    SegmentBoardVRF     board;

    address treasury = address(0x7EA5);
    address alice    = address(0xA11CE);
    address bob      = address(0xB0B);
    address carol    = address(0xCA401);
    address stranger = address(0x57A);

    uint64 constant ENTRY_MAX    = 40 minutes;
    uint64 constant PLACE_WINDOW = 5 minutes;
    uint64 constant BETS_CLOSE   = 2 minutes;
    uint64 constant SIT_QUIET    = 5 minutes;
    uint64 constant SOLO_WAIT    = 15 minutes;

    uint8 constant CHIP5  = 0;
    uint8 constant CHIP25 = 2;
    uint256 constant SEED_SHARE_WEI = uint256(100e18) / 7;

    uint256 nextRound = 700;

    function setUp() public {
        vm.warp(1_000_000);
        vm.roll(1_000);

        timbs    = new MockTIMBST();
        prize    = new MockTimbPrizeT();
        coord    = new MockVRFCoordinatorT();
        ledger   = new PoolLedger(address(timbs), treasury);
        registry = new SeedRegistry();
        // Empty reserve: grants are zero, so the timing behaviour under test is
        // not entangled with the underwrite. That is the gen-5 fixture's choice
        // and it is still the right one.
        reserve  = new UnderwriteReserve(address(timbs), treasury, address(0));

        ent = new VRFEntropy(address(coord), bytes32(uint256(0xABC)), 42, 3, 200_000, hex"1234");

        board = new SegmentBoardVRF(
            address(ledger), address(registry), address(ent),
            address(prize), address(reserve), treasury, treasury, address(0),
            ENTRY_MAX, PLACE_WINDOW, BETS_CLOSE, SIT_QUIET, SOLO_WAIT
        );
        ledger.setBoard(address(board));
        registry.addWriter(address(board));
        reserve.setBoard(address(board));
        reserve.approveLedger(address(ledger));
        ent.setBoard(address(board));

        timbs.mintTo(treasury, 100_000e18);
        vm.prank(treasury); timbs.approve(address(ledger), type(uint256).max);
        address[3] memory players = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            timbs.mintTo(players[i], 10_000e18);
            vm.prank(players[i]); timbs.approve(address(ledger), type(uint256).max);
        }
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

    function _open() internal returns (uint256 id) {
        prize.setResult(nextRound, bytes6("ABCDEF"));
        id = board.openTable(nextRound);
        ++nextRound;
    }

    /// The four schedule marks. `tables()` is a 16-tuple on gen-8, hence the two
    /// trailing gaps — keeping the positional read in one place means the next
    /// appended field is a one-line change rather than a sweep.
    function _marks(uint256 id) internal view
        returns (uint64 openedAt, uint64 pickTime, uint64 entryCloseAt, uint8 loadedCount)
    {
        (openedAt, pickTime,,,,,,,,, entryCloseAt,,, loadedCount,,) = board.tables(id);
    }

    function _sitLoad(address who, uint256 id) internal {
        vm.startPrank(who);
        board.sit(id, bytes6("TICKET"));
        board.loadTokens(id, [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25]);
        vm.stopPrank();
    }

    function _armLock(uint256 id, uint8 segment, uint256 word) internal {
        uint256 reqId = coord.nextId();
        vm.prank(stranger); board.armSegment(id, segment);
        coord.fulfil(address(ent), reqId, word);
        vm.prank(stranger); board.lockSegment(id, segment);
    }

    function _lockAllSix(uint256 id) internal {
        for (uint8 s = 1; s <= 6; ++s) _armLock(id, s, 1000 + uint256(s));
    }

    // ─── adaptive entry ──────────────────────────────────────────────────────

    function test_CeilingStandsWhileNobodyIsFunded() public {
        uint256 id = _open();
        (uint64 openedAt, uint64 pickTime, uint64 closeAt,) = _marks(id);
        assertEq(closeAt, openedAt + ENTRY_MAX, "ceiling on open");
        assertEq(pickTime, closeAt + PLACE_WINDOW + BETS_CLOSE, "schedule rides the close");

        vm.prank(alice); board.sit(id, bytes6("AAAAAA"));
        vm.prank(bob);   board.sit(id, bytes6("BBBBBB"));
        (,, uint64 closeAt2,) = _marks(id);
        assertEq(closeAt2, closeAt, "unfunded sits never pull the close in");
    }

    function test_QuorumQuietClosesEntry() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        vm.warp(vm.getBlockTimestamp() + 60);
        _sitLoad(bob, id);

        (uint64 openedAt, uint64 pickTime, uint64 closeAt, uint8 loaded) = _marks(id);
        assertEq(loaded, 2);
        assertEq(closeAt, uint64(vm.getBlockTimestamp()) + SIT_QUIET, "quiet clock from last join");
        assertLt(closeAt, openedAt + ENTRY_MAX, "earlier than the ceiling");
        assertEq(pickTime, closeAt + PLACE_WINDOW + BETS_CLOSE);

        vm.warp(closeAt);
        vm.prank(carol);
        vm.expectRevert(SegmentBoardVRF.TableClosedForEntry.selector);
        board.sit(id, bytes6("CCCCCC"));
    }

    function test_EveryJoinPushesTheQuietClock() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        _sitLoad(bob, id);
        (,, uint64 closeA,) = _marks(id);

        vm.warp(vm.getBlockTimestamp() + 3 minutes);
        vm.prank(carol); board.sit(id, bytes6("CCCCCC"));   // a bare sit is a join too
        (,, uint64 closeB,) = _marks(id);
        assertEq(closeB, uint64(vm.getBlockTimestamp()) + SIT_QUIET, "sit pushed the clock");
        assertGt(closeB, closeA, "later than before");
    }

    function test_QuietClockClampsAtTheCeiling() public {
        uint256 id = _open();
        (uint64 openedAt,,,) = _marks(id);
        vm.prank(alice); board.sit(id, bytes6("AAAAAA"));
        vm.prank(bob);   board.sit(id, bytes6("BBBBBB"));

        // quorum forms 30s before the ceiling: the quiet clock would land past
        // it, so close and schedule clamp instead
        vm.warp(openedAt + ENTRY_MAX - 30);
        vm.prank(alice); board.loadTokens(id, [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25]);
        vm.prank(bob);   board.loadTokens(id, [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25]);
        (, uint64 pickTime, uint64 closeAt, uint8 loaded) = _marks(id);
        assertEq(loaded, 2);
        assertEq(closeAt, openedAt + ENTRY_MAX, "clamped to the ceiling");
        assertEq(pickTime, closeAt + PLACE_WINDOW + BETS_CLOSE);
    }

    function test_LoneFundedPlayerWaitsSoloWaitOnly() public {
        uint256 id = _open();
        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        _sitLoad(alice, id);
        (uint64 openedAt,, uint64 closeAt, uint8 loaded) = _marks(id);
        assertEq(loaded, 1);
        assertEq(closeAt, uint64(vm.getBlockTimestamp()) + SOLO_WAIT, "solo clock from first load");
        assertLt(closeAt, openedAt + ENTRY_MAX);
    }

    function test_SoloToQuorumTransitionNeverWritesThePast() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        (,, uint64 soloClose,) = _marks(id);

        vm.warp(vm.getBlockTimestamp() + SOLO_WAIT - 1 minutes);
        _sitLoad(bob, id);
        (,, uint64 closeAt,) = _marks(id);
        assertEq(closeAt, uint64(vm.getBlockTimestamp()) + SIT_QUIET,
            "quiet clock measured from the join that formed quorum");
        assertGe(closeAt, uint64(vm.getBlockTimestamp()), "never in the past");
        assertLt(closeAt, soloClose + SIT_QUIET);
    }

    // ─── late loading ────────────────────────────────────────────────────────

    function test_SeatedWalletLoadsAndPlacesAfterEntryCloses() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        _sitLoad(bob, id);
        vm.prank(carol); board.sit(id, bytes6("CCCCCC"));   // seated, unfunded

        (, uint64 pickTime, uint64 closeAt,) = _marks(id);
        vm.warp(closeAt + 1);

        // gen-4 stranded this seat; gen-5 lets it fund until bets close, and
        // gen-8 inherits that unchanged
        vm.startPrank(carol);
        board.loadTokens(id, [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25]);
        board.place(id, 1, board.KIND_LETTER(), 0);
        vm.stopPrank();
        (,,, uint8 loaded) = _marks(id);
        assertEq(loaded, 3, "late load counted");

        vm.warp(pickTime - BETS_CLOSE);
        vm.prank(address(0xDEAD));
        vm.expectRevert(SegmentBoardVRF.TableClosedForEntry.selector);
        board.sit(id, bytes6("DDDDDD"));
    }

    function test_LoadRejectedOnceBetsClose() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        _sitLoad(bob, id);
        vm.prank(carol); board.sit(id, bytes6("CCCCCC"));

        (, uint64 pickTime,,) = _marks(id);
        vm.warp(pickTime - BETS_CLOSE);          // exactly at the cutoff
        vm.prank(carol);
        vm.expectRevert(SegmentBoardVRF.BetsClosed.selector);
        board.loadTokens(id, [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25]);
    }

    function test_LateLoadCannotReopenEntry() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        _sitLoad(bob, id);
        vm.prank(carol); board.sit(id, bytes6("CCCCCC"));
        (,, uint64 closeAt,) = _marks(id);
        vm.warp(closeAt + 30);

        vm.prank(carol);
        board.loadTokens(id, [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25]);
        (, uint64 pickAfter, uint64 closeAfter,) = _marks(id);
        assertEq(closeAfter, closeAt, "a late load must not move a closed window");
        assertEq(pickAfter, closeAt + PLACE_WINDOW + BETS_CLOSE);
    }

    // ─── arming needs FUNDED seats, not seated ones ──────────────────────────

    function test_ArmRefusesUnfundedQuorum() public {
        uint256 id = _open();
        _sitLoad(alice, id);                              // 1 funded
        vm.prank(bob); board.sit(id, bytes6("BBBBBB"));   // 2 seated, 1 funded

        (, uint64 pickTime,,) = _marks(id);
        vm.warp(pickTime + 1);
        vm.expectRevert(abi.encodeWithSelector(
            SegmentBoardVRF.NotEnoughSeats.selector, uint8(1), uint8(2)));
        vm.prank(stranger); board.armSegment(id, 1);

        // and the table is cancellable: funded count is below the minimum
        board.cancelTable(id);
        (,,,,,,, bool retired,,,,,,,,) = board.tables(id);
        assertTrue(retired, "under-funded table cancels");
    }

    function test_TwoFundedSeatsArm() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        _sitLoad(bob, id);
        (, uint64 pickTime,,) = _marks(id);
        vm.warp(pickTime + 1);

        vm.prank(stranger); board.armSegment(id, 1);      // must not revert
        (,, uint64 armedAt,,,,,,,,,,,,,) = board.tables(id);
        assertGt(armedAt, 0, "armed");
        (bool armed,,,,) = board.segmentState(id, 1);
        assertTrue(armed, "segment 1 carries a draw");
    }

    // ─── Layer 0: no rake on an uncontested pool ─────────────────────────────

    function test_SoloPoolsPayParOrForfeitWhole_ContestedPoolStillRaked() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        _sitLoad(bob, id);

        // Segment 1 CONTESTED: alice letters vs bob numbers, exactly one wins.
        // Segments 2-6 SOLO alice letter bets; bob leaves five tokens unplaced.
        uint8 L = board.KIND_LETTER();
        uint8 N = board.KIND_NUMBER();
        vm.startPrank(alice);
        for (uint8 s = 1; s <= 6; ++s) board.place(id, s, L, 0);
        vm.stopPrank();
        vm.prank(bob); board.place(id, 1, N, 0);

        (, uint64 pickTime,,) = _marks(id);
        vm.warp(pickTime + 1);
        vm.recordLogs();
        _lockAllSix(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 sig = keccak256("PoolSettled(uint256,uint8,uint256,uint256,uint256)");
        uint256 chip = 25e18;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != sig) continue;
            uint8 pool = uint8(uint256(logs[i].topics[2]));
            (uint256 pot, uint256 rake, uint256 distributed) =
                abi.decode(logs[i].data, (uint256, uint256, uint256));
            if (pool == 0) {
                assertEq(pot, 2 * chip + SEED_SHARE_WEI, "contested pot");
                uint256 expDist = (pot * (10000 - 487)) / 10000; // rake(2) = 175 + 625/2
                assertEq(distributed, expDist, "graduated rake still taken when contested");
                assertEq(rake, pot - distributed);
            } else if (pool >= 1 && pool <= 5) {
                assertEq(pot, chip, "solo pot is the player's own chip, no seed");
                if (distributed > 0) {
                    assertEq(distributed, pot, "Layer 0: solo winner takes par, zero rake");
                    assertEq(rake, 0, "no rake without a contest");
                } else {
                    assertEq(rake, pot, "no winner: whole pot forfeits");
                }
            }
        }
    }

    // ─── gen-7's bonus-chip rule, carried into gen-8 ─────────────────────────

    /// A seat with no chips down could once buy the Repeats-a-Digit stake — and,
    /// with the jackpot live, buy into a strike — while contributing nothing to
    /// the six segment pools.
    function test_UnloadedSeatCannotBuyTheBonusChip() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        vm.prank(bob); board.sit(id, bytes6("BBBBBB"));   // seated, never funded

        vm.prank(bob);
        vm.expectRevert(SegmentBoardVRF.NotLoaded.selector);
        board.placeDoubleDigit(id, CHIP25);
    }

    function test_LoadedSeatBuysTheBonusChip() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        vm.prank(alice); board.placeDoubleDigit(id, CHIP25);
        (,, uint8 ddChip,,) = board.seats(id, alice);
        assertEq(ddChip, CHIP25 + 1, "stake recorded");
    }

    /// Late loading still earns it: fund after entry closes, still get the
    /// bonus chip, right up until bets close.
    function test_LateLoaderStillEarnsTheBonusChip() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        _sitLoad(bob, id);
        vm.prank(carol); board.sit(id, bytes6("CCCCCC"));

        (,, uint64 entryCloseAt,) = _marks(id);
        vm.warp(uint256(entryCloseAt) + 1);               // entry shut

        vm.startPrank(carol);
        board.loadTokens(id, [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25]);
        board.placeDoubleDigit(id, CHIP25);               // now allowed
        vm.stopPrank();
        (,, uint8 ddChip,,) = board.seats(id, carol);
        assertEq(ddChip, CHIP25 + 1, "late loader keeps the bonus chip");
    }

    /// The ladder's floor IS 5 TIMBS — nothing sits beneath it and loadTokens
    /// rejects any index off the end, so "every one of the six is worth at least
    /// 5" holds by construction rather than by a check that could be forgotten.
    function test_ChipLadderFloorIsFive() public {
        assertEq(board.CHIPS(0), 5e18, "smallest denomination");
        uint256 id = _open();
        vm.startPrank(alice);
        board.sit(id, bytes6("AAAAAA"));
        board.loadTokens(id, [CHIP5, CHIP5, CHIP5, CHIP5, CHIP5, CHIP5]);
        vm.stopPrank();
        assertEq(ledger.tableEscrow(id), 100e18 + 6 * 5e18, "six floor chips landed");

        uint256 id2 = _open();
        vm.startPrank(bob);
        board.sit(id2, bytes6("BBBBBB"));
        vm.expectRevert(SegmentBoardVRF.BadChip.selector);
        board.loadTokens(id2, [uint8(7), 7, 7, 7, 7, 7]);  // off the end of the ladder
        vm.stopPrank();
    }

    // ─── the tuple's shape ───────────────────────────────────────────────────

    /// `tables()` has only ever GROWN at the tail — gen-5 appended four fields,
    /// gen-6 `opener`, gen-8 `armedMask` — so every older decoder still reads
    /// the positions it knows. SegmentCrank depends on this for generations 4-7.
    function test_TablesGetterAppendsFieldsOnly() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        (uint64 openedAt,,,, uint8 seatCount, uint8 lockedMask,,,,,,,,,,) = board.tables(id);
        assertEq(openedAt, uint64(vm.getBlockTimestamp()));
        assertEq(seatCount, 1);
        assertEq(lockedMask, 0);
    }
}
