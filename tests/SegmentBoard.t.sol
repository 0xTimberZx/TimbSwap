// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

// Run: forge test --match-contract SegmentBoardTest -vvv

import "forge-std/Test.sol";
import "../contracts/SegmentBoard.sol";
import "../contracts/PoolLedger.sol";
import "../contracts/SeedRegistry.sol";
import "../contracts/CommitRevealEntropy.sol";
import "../contracts/UnderwriteReserve.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockTIMBS is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") {}
    function mintTo(address to, uint256 amt) external { _mint(to, amt); }
}

contract MockTimbPrize {
    mapping(uint256 => bytes6) public roundWinningString;
    function setResult(uint256 round, bytes6 s) external { roundWinningString[round] = s; }
}

contract SegmentBoardTest is Test {
    MockTIMBS           timbs;
    MockTimbPrize       prize;
    PoolLedger          ledger;
    SeedRegistry        registry;
    CommitRevealEntropy ent;
    SegmentBoard        board;
    UnderwriteReserve   reserve;

    address treasury = address(0x7EA5);
    address guardian = address(0x6A4D);
    address alice    = address(0xA11CE);
    address bob      = address(0xB0B);

    // Gen-5 dials. Quiet/solo timers equal the ceiling so the adaptive
    // schedule degenerates to the fixed gen-4 one for this legacy suite —
    // entryCloseAt never moves off openedAt + ENTRY_WINDOW. The adaptive
    // behaviour itself is exercised in SegmentBoardVRFTiming.t.sol, against the
    // board that is actually deployed.
    uint64 constant ENTRY_WINDOW   = 40 minutes;              // entryMax
    uint64 constant PLACE_WINDOW   = 5 minutes;
    uint64 constant BETS_CLOSE     = 5 minutes;
    uint64 constant SIT_QUIET      = 40 minutes;
    uint64 constant SOLO_WAIT      = 40 minutes;
    uint64 constant PICK_DELAY     = ENTRY_WINDOW + PLACE_WINDOW + BETS_CLOSE; // 50 min

    uint256 constant SEED = 100e18;

    // chip index 2 = 25 TIMBS
    uint8 constant CHIP25 = 2;

    // cached so tests never make an external call inside a vm.expectRevert window
    uint8 kLetter;
    uint8 kNumber;

    function setUp() public {
        vm.warp(1_000_000);
        vm.roll(1_000);

        timbs    = new MockTIMBS();
        prize    = new MockTimbPrize();
        ledger   = new PoolLedger(address(timbs), treasury);
        registry = new SeedRegistry();
        ent      = new CommitRevealEntropy();

        // Gen-6 reserve, deployed EMPTY: grantTopUp returns 0 with no float,
        // so every payout in this legacy suite is pure pool money — the
        // pre-underwrite behaviour this suite regression-tests. The funded
        // reserve is exercised in SegmentBoardVRFEconomics.t.sol, against the board
        // that is actually deployed.
        reserve = new UnderwriteReserve(address(timbs), treasury, guardian);

        board = new SegmentBoard(
            address(ledger), address(registry), address(ent),
            address(prize), address(reserve), treasury, treasury, guardian,
            ENTRY_WINDOW, PLACE_WINDOW, BETS_CLOSE, SIT_QUIET, SOLO_WAIT
        );

        ledger.setBoard(address(board));
        registry.addWriter(address(board));
        reserve.setBoard(address(board));
        reserve.approveLedger(address(ledger));

        // treasury funds the seed float and approves the ledger
        timbs.mintTo(treasury, 10_000e18);
        vm.prank(treasury); timbs.approve(address(ledger), type(uint256).max);

        // players
        timbs.mintTo(alice, 10_000e18);
        timbs.mintTo(bob,   10_000e18);
        vm.prank(alice); timbs.approve(address(ledger), type(uint256).max);
        vm.prank(bob);   timbs.approve(address(ledger), type(uint256).max);

        // a settled TimbPrize round to seed from
        prize.setResult(7, bytes6("ABCDEF"));

        kLetter = board.KIND_LETTER();
        kNumber = board.KIND_NUMBER();
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

    function _commitments(uint256 tableId) internal view returns (bytes32[6] memory cs) {
        for (uint8 i; i < 6; ++i) {
            cs[i] = ent.commitmentOf(_secret(i + 1), _salt(tableId, i + 1));
        }
    }

    function _secret(uint8 segment) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("secret", segment));
    }

    function _salt(uint256 tableId, uint8 segment) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(tableId, segment));
    }

    function _openTable() internal returns (uint256 id) {
        id = board.openTable(7, _commitments(1));
    }

    /// @dev Seat both players, load all six tokens, and put complementary
    ///      Letter/Number bets on every segment so exactly one side always wins.
    function _seatAndBet(uint256 id) internal {
        uint8[6] memory chips =
            [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25];

        vm.startPrank(alice);
        board.sit(id, bytes6("ABCDEF"));
        board.loadTokens(id, chips);
        for (uint8 s = 1; s <= 6; ++s) board.place(id, s, kLetter, 0);
        vm.stopPrank();

        vm.startPrank(bob);
        board.sit(id, bytes6("123456"));
        board.loadTokens(id, chips);
        for (uint8 s = 1; s <= 6; ++s) board.place(id, s, kNumber, 0);
        vm.stopPrank();
    }

    /**
     * @dev Advance the chain by `n` blocks / `s` seconds.
     *
     *      Do NOT write `vm.roll(block.number + n)` in these tests. NUMBER and
     *      TIMESTAMP have no dependency on external calls in real EVM semantics,
     *      so the via-IR Yul optimizer is free to hoist or sink those reads
     *      across a call — and under `via_ir = true` it does exactly that around
     *      the vm.roll/vm.warp cheatcodes that quietly mutate them. The result
     *      is a test that reads a stale (or prematurely updated) block number
     *      and passes without via-IR while failing with it, on the same solc.
     *
     *      vm.getBlockNumber()/vm.getBlockTimestamp() are staticcalls to the
     *      cheatcode address, which the optimizer cannot reorder, so they always
     *      observe the post-cheatcode value.
     */
    function _advance(uint256 n) internal {
        vm.roll(vm.getBlockNumber() + n);
    }

    function _fastForward(uint256 s) internal {
        vm.warp(vm.getBlockTimestamp() + s);
    }

    function _lockAll(uint256 id) internal {
        _fastForward(PICK_DELAY + 1);
        board.armTable(id);
        _advance(1);
        for (uint8 s = 1; s <= 6; ++s) {
            board.lockSegment(id, s, _secret(s));
        }
    }

    // ─── constructor dial sanity ──────────────────────────────────────────────

    /// @dev The dials are immutable, so an unusable set bricks the generation with
    ///      no recovery. These are the two ways that happens.
    function _deployWithDials(uint64 e, uint64 pw, uint64 b, uint64 q, uint64 so)
        internal returns (SegmentBoard)
    {
        return new SegmentBoard(
            address(ledger), address(registry), address(ent),
            address(prize), address(reserve), treasury, treasury, guardian, e, pw, b, q, so
        );
    }

    function test_ZeroDialsRejected() public {
        // Every dial is load-bearing: zero placeWindow closes bets the moment
        // entry closes; zero lead lets bets ride into the entropy window; zero
        // timers close entry the instant quorum forms.
        vm.expectRevert(abi.encodeWithSelector(SegmentBoard.BadDials.selector,
            uint64(0), uint64(300), uint64(120), uint64(300), uint64(900)));
        _deployWithDials(0, 300, 120, 300, 900);

        vm.expectRevert(abi.encodeWithSelector(SegmentBoard.BadDials.selector,
            uint64(900), uint64(0), uint64(120), uint64(300), uint64(900)));
        _deployWithDials(900, 0, 120, 300, 900);

        vm.expectRevert(abi.encodeWithSelector(SegmentBoard.BadDials.selector,
            uint64(900), uint64(300), uint64(0), uint64(300), uint64(900)));
        _deployWithDials(900, 300, 0, 300, 900);
    }

    function test_TimersCannotExceedTheCeiling() public {
        // sitQuiet or soloWait beyond entryMax could only ever be clamped, so
        // the constructor rejects the set as a mis-configuration.
        vm.expectRevert(abi.encodeWithSelector(SegmentBoard.BadDials.selector,
            uint64(900), uint64(300), uint64(120), uint64(901), uint64(900)));
        _deployWithDials(900, 300, 120, 901, 900);

        vm.expectRevert(abi.encodeWithSelector(SegmentBoard.BadDials.selector,
            uint64(900), uint64(300), uint64(120), uint64(300), uint64(901)));
        _deployWithDials(900, 300, 120, 300, 901);
    }

    function test_RealDialSetsAreAccepted() public {
        _deployWithDials(2400, 300, 300, 2400, 2400); // this legacy suite's set
        _deployWithDials(2400, 300, 120, 300, 900);   // gen-5 production target
        _deployWithDials(240,  60,  30,  60,  120);   // compressed test set
    }

    // ─── lifecycle ───────────────────────────────────────────────────────────

    function test_OpenTablePullsSeedAndConsumesRound() public {
        uint256 id = _openTable();
        assertEq(id, 1);
        assertEq(ledger.heldBalance(), SEED);
        assertTrue(registry.isUsed(7));
    }

    function test_SeedRoundCannotBeReused() public {
        _openTable();
        bytes32[6] memory cs = _commitments(2);
        vm.expectRevert(abi.encodeWithSelector(SeedRegistry.SeedAlreadyUsed.selector, 7));
        board.openTable(7, cs);
    }

    function test_UnsettledSeedRoundReverts() public {
        bytes32[6] memory cs = _commitments(1);
        vm.expectRevert(abi.encodeWithSelector(SegmentBoard.SeedNotSettled.selector, uint256(99)));
        board.openTable(99, cs);
    }

    function test_CannotPlaceWithoutLoading() public {
        uint256 id = _openTable();
        vm.startPrank(alice);
        board.sit(id, bytes6("ABCDEF"));
        vm.expectRevert(SegmentBoard.NotLoaded.selector);
        board.place(id, 1, kLetter, 0);
        vm.stopPrank();
    }

    function test_OneTokenPerSegment() public {
        uint256 id = _openTable();
        uint8[6] memory chips = [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25];
        vm.startPrank(alice);
        board.sit(id, bytes6("ABCDEF"));
        board.loadTokens(id, chips);
        board.place(id, 1, kLetter, 0);
        // the guard that makes complementary outside bets farm-safe (§6.1)
        vm.expectRevert(abi.encodeWithSelector(SegmentBoard.AlreadyPlaced.selector, uint8(1)));
        board.place(id, 1, kNumber, 0);
        vm.stopPrank();
    }

    function test_BetsCloseBeforePick() public {
        uint256 id = _openTable();
        uint8[6] memory chips = [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25];
        vm.startPrank(alice);
        board.sit(id, bytes6("ABCDEF"));
        board.loadTokens(id, chips);
        vm.stopPrank();

        _fastForward(PICK_DELAY - BETS_CLOSE); // exactly at the cutoff
        vm.prank(alice);
        vm.expectRevert(SegmentBoard.BetsClosed.selector);
        board.place(id, 1, kLetter, 0);
    }

    function test_ArmNeedsMinSeats() public {
        uint256 id = _openTable();
        uint8[6] memory chips = [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25];
        vm.startPrank(alice);
        board.sit(id, bytes6("ABCDEF"));
        board.loadTokens(id, chips);
        vm.stopPrank();

        _fastForward(PICK_DELAY + 1);
        vm.expectRevert(
            abi.encodeWithSelector(SegmentBoard.NotEnoughSeats.selector, uint8(1), uint8(2))
        );
        board.armTable(id);
    }

    function test_CannotLockInSameBlockAsArm() public {
        uint256 id = _openTable();
        _seatAndBet(id);
        _fastForward(PICK_DELAY + 1);
        board.armTable(id);
        vm.expectRevert(SegmentBoard.SameBlockAsArm.selector);
        board.lockSegment(id, 1, _secret(1));
    }

    // ─── full round + conservation ────────────────────────────────────────────

    function test_FullRoundSettlesAndConserves() public {
        uint256 id = _openTable();
        _seatAndBet(id);

        // 2 players x 6 chips x 25 + seed
        uint256 staked = 2 * 6 * 25e18;
        assertEq(ledger.heldBalance(), staked + SEED);

        _lockAll(id);

        // exactly one of Letter/Number won each segment, so every segment pool
        // paid out; credit must be fully backed at all times
        assertGe(ledger.heldBalance(), ledger.totalCredited());
        assertGt(ledger.totalCredited(), 0);

        uint256 beforeTreasury = timbs.balanceOf(treasury);
        board.retire(id);

        // leftovers (rake + any forfeited seed + dust) swept to Treasury
        assertGt(timbs.balanceOf(treasury), beforeTreasury);
        // after the sweep the vault holds exactly what it owes players
        assertEq(ledger.heldBalance(), ledger.totalCredited());

        // and the winner can actually pull their credit
        uint256 aliceCredit = ledger.credit(alice);
        uint256 bobCredit   = ledger.credit(bob);
        assertGt(aliceCredit + bobCredit, 0);
        if (aliceCredit > 0) {
            vm.prank(alice);
            ledger.withdraw();
        }
        if (bobCredit > 0) {
            vm.prank(bob);
            ledger.withdraw();
        }
        assertEq(ledger.totalCredited(), 0);
        assertEq(ledger.heldBalance(), 0); // fully drained: nothing stranded
    }

    function test_UnplayedChipsAreRefundedAtRetire() public {
        uint256 id = _openTable();
        uint8[6] memory chips = [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25];

        // alice loads all six but only places five; bob plays all six
        vm.startPrank(alice);
        board.sit(id, bytes6("ABCDEF"));
        board.loadTokens(id, chips);
        for (uint8 s = 1; s <= 5; ++s) board.place(id, s, kLetter, 0);
        vm.stopPrank();

        vm.startPrank(bob);
        board.sit(id, bytes6("123456"));
        board.loadTokens(id, chips);
        for (uint8 s = 1; s <= 6; ++s) board.place(id, s, kNumber, 0);
        vm.stopPrank();

        uint256 creditBefore = ledger.credit(alice);
        _lockAll(id);
        board.retire(id);

        // her unplayed segment-6 chip came back as credit, on top of any winnings
        assertGe(ledger.credit(alice), creditBefore + 25e18);
    }

    function test_SoloPoolForfeitsSeed() public {
        uint256 id = _openTable();
        uint8[6] memory chips = [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25];

        // both seat (so the table can arm) but only alice bets segment 1
        vm.startPrank(alice);
        board.sit(id, bytes6("ABCDEF"));
        board.loadTokens(id, chips);
        board.place(id, 1, kLetter, 0);
        board.place(id, 2, kLetter, 0);
        vm.stopPrank();

        vm.startPrank(bob);
        board.sit(id, bytes6("123456"));
        board.loadTokens(id, chips);
        board.place(id, 2, kNumber, 0); // only segment 2 is contested
        vm.stopPrank();

        _lockAll(id);

        // Solo segment-1 pool: at most its own 25 chip back (no seed share), and
        // taxed at the full 8% base rake. Contested pools may draw the seed.
        assertGe(ledger.heldBalance(), ledger.totalCredited());
        board.retire(id);
        assertEq(ledger.heldBalance(), ledger.totalCredited());
    }

    // ─── re-arm: recovering a table whose lock block aged out ──────────────────

    /// @dev Past BLOCKHASH_HORIZON the lock block's hash reads zero, so BOTH
    ///      lockSegment and lockSegmentFallback revert while retire() still wants
    ///      all six — the table would jam with every bet inside. On Arbitrum that
    ///      horizon is ~65 seconds, so this is a live risk, not a corner case.
    function test_RearmRecoversATableWhoseLockBlockExpired() public {
        uint256 id = _openTable();
        _seatAndBet(id);
        _fastForward(PICK_DELAY + 1);
        board.armTable(id);
        _advance(1);

        board.lockSegment(id, 1, _secret(1)); // one settles fine

        // ...then the hash ages out before the rest are locked
        _advance(board.BLOCKHASH_HORIZON() + 1);

        vm.expectRevert(); // LockBlockUnavailable — happy path dead
        board.lockSegment(id, 2, _secret(2));
        vm.expectRevert(); // ...and so is the fallback
        board.lockSegmentFallback(id, 2);

        // anyone may re-arm onto a fresh block, and the rest settle normally
        vm.prank(bob);
        board.rearmTable(id);
        _advance(1);
        for (uint8 s = 2; s <= 6; ++s) board.lockSegment(id, s, _secret(s));

        board.retire(id);
        assertEq(ledger.heldBalance(), ledger.totalCredited(), "exactly backed");
        assertGt(ledger.totalCredited(), 0, "players were paid");
    }

    function test_CannotRearmWhileLockBlockStillLive() public {
        uint256 id = _openTable();
        _seatAndBet(id);
        _fastForward(PICK_DELAY + 1);
        board.armTable(id);
        uint256 lb = vm.getBlockNumber();
        _advance(10); // well inside the horizon
        vm.expectRevert(
            abi.encodeWithSelector(
                SegmentBoard.LockBlockStillLive.selector, lb, lb + 256
            )
        );
        board.rearmTable(id);
    }

    function test_CannotRearmAFullySettledTable() public {
        uint256 id = _openTable();
        _seatAndBet(id);
        _lockAll(id);
        _advance(board.BLOCKHASH_HORIZON() + 1);
        vm.expectRevert(SegmentBoard.NothingLeftToLock.selector);
        board.rearmTable(id);
    }

    // ─── cancel: the under-seated escape hatch ─────────────────────────────────

    /// @dev A table below SEATS_MIN can never be armed, so without this path its
    ///      loaded chips would be stranded forever. Cancel must return every chip
    ///      and hand the seed back, leaving nothing behind.
    function test_CancelRefundsEverythingOnUnderSeatedTable() public {
        uint256 id = _openTable();
        uint8[6] memory chips = [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25];

        // one wallet sits, loads all six and even places — then nobody else joins
        vm.startPrank(alice);
        board.sit(id, bytes6("ABCDEF"));
        board.loadTokens(id, chips);
        for (uint8 s = 1; s <= 6; ++s) board.place(id, s, kLetter, 0);
        board.placeDoubleDigit(id, CHIP25);
        vm.stopPrank();

        uint256 staked = 7 * 25e18; // six segment chips + the DD stake
        assertEq(ledger.heldBalance(), staked + SEED);

        // entry closes with only one seat: armTable is impossible
        _fastForward(PICK_DELAY + 1);
        vm.expectRevert(
            abi.encodeWithSelector(SegmentBoard.NotEnoughSeats.selector, uint8(1), uint8(2))
        );
        board.armTable(id);

        // ...so anyone may cancel it
        uint256 treasuryBefore = timbs.balanceOf(treasury);
        vm.prank(bob); // permissionless
        board.cancelTable(id);

        // every chip came back, placed ones included — nothing settled, so
        // nothing can have been won or lost
        assertEq(ledger.credit(alice), staked, "all seven chips refunded");
        // seedFunder == treasury in this fixture; the dedicated test below
        // proves the seed goes to the FUNDER when the two are different wallets
        assertEq(timbs.balanceOf(treasury) - treasuryBefore, SEED, "seed returned");
        assertEq(ledger.heldBalance(), ledger.totalCredited(), "exactly backed");

        vm.prank(alice);
        ledger.withdraw();
        assertEq(timbs.balanceOf(alice), 10_000e18, "player made whole");
        assertEq(ledger.heldBalance(), 0, "vault fully drained");
    }

    /// @dev A cancelled table had no round and earned no rake, so its seed goes
    ///      back where it was pulled from — the ops wallet — not to Treasury.
    ///      Without this, every cancel drained seedFunder by 100 TIMBS one-way.
    function test_CancelReturnsSeedToFunderNotTreasury() public {
        address ops = address(0x0F5);
        timbs.mintTo(ops, 1_000e18);
        vm.prank(ops); timbs.approve(address(ledger), type(uint256).max);
        board.setSeedFunder(ops);

        uint256 id = _openTable();
        assertEq(timbs.balanceOf(ops), 900e18, "seed pulled from ops");

        vm.prank(alice);
        board.sit(id, bytes6("ABCDEF")); // one seat: can never arm

        _fastForward(PICK_DELAY + 1);
        uint256 treasuryBefore = timbs.balanceOf(treasury);
        board.cancelTable(id);

        assertEq(timbs.balanceOf(ops), 1_000e18, "ops wallet made whole");
        assertEq(timbs.balanceOf(treasury), treasuryBefore, "treasury took nothing");
    }

    function test_CannotCancelWhileEntryOpen() public {
        uint256 id = _openTable();
        vm.expectRevert(SegmentBoard.EntryStillOpen.selector);
        board.cancelTable(id);
    }

    function test_CannotCancelATableThatCanProceed() public {
        uint256 id = _openTable();
        _seatAndBet(id); // two seats -> it can arm, so it must not be cancellable
        _fastForward(PICK_DELAY + 1);
        vm.expectRevert(
            abi.encodeWithSelector(SegmentBoard.TableCanProceed.selector, uint8(2), uint8(2))
        );
        board.cancelTable(id);
    }

    function test_CannotCancelTwice() public {
        uint256 id = _openTable();
        vm.prank(alice);
        board.sit(id, bytes6("ABCDEF"));
        _fastForward(PICK_DELAY + 1);
        board.cancelTable(id);
        vm.expectRevert(SegmentBoard.TableRetiredAlready.selector);
        board.cancelTable(id);
    }

    // ─── missed reveal ────────────────────────────────────────────────────────

    function test_FallbackOnlyAfterRevealWindow() public {
        uint256 id = _openTable();
        _seatAndBet(id);
        _fastForward(PICK_DELAY + 1);
        board.armTable(id);
        _advance(1);

        vm.expectRevert(SegmentBoard.RevealWindowOpen.selector);
        board.lockSegmentFallback(id, 1);

        // once the protocol has missed its window, anyone can settle the table
        _advance(board.REVEAL_WINDOW() + 1);
        vm.prank(bob); // permissionless
        board.lockSegmentFallback(id, 1);
        assertGe(ledger.heldBalance(), ledger.totalCredited());
    }

    function test_BadRevealIsRejected() public {
        uint256 id = _openTable();
        _seatAndBet(id);
        _fastForward(PICK_DELAY + 1);
        board.armTable(id);
        _advance(1);

        vm.expectRevert(CommitRevealEntropy.BadReveal.selector);
        board.lockSegment(id, 1, keccak256("not-the-secret"));
    }

    // ─── guardian / owner ─────────────────────────────────────────────────────

    function test_GuardianCanOnlyHalt() public {
        vm.prank(guardian);
        board.setNewTablesHalted(true);
        bytes32[6] memory cs = _commitments(1);
        vm.expectRevert(SegmentBoard.Halted.selector);
        board.openTable(7, cs);

        vm.prank(guardian);
        board.setNewTablesHalted(false);
        _openTable(); // flows again
    }

    function test_HaltedBetsStillAllowWithdrawals() public {
        uint256 id = _openTable();
        _seatAndBet(id);
        _lockAll(id);

        vm.prank(guardian);
        board.setNewBetsHalted(true);

        // settlement already credited; withdrawal is never pausable
        if (ledger.credit(alice) > 0) {
            vm.prank(alice);
            ledger.withdraw();
        }
        assertGe(ledger.heldBalance(), ledger.totalCredited());
    }

    function test_NonGuardianCannotHalt() public {
        vm.prank(alice);
        vm.expectRevert(SegmentBoard.NotGuardian.selector);
        board.setNewTablesHalted(true);
    }

    function test_RetireGuardianIsTerminal() public {
        vm.prank(guardian);
        board.retireGuardian();
        assertEq(board.guardian(), address(0));
        vm.prank(guardian);
        vm.expectRevert(SegmentBoard.NotGuardian.selector);
        board.setNewTablesHalted(true);
    }

    function test_RenounceIsTerminalForOwner() public {
        board.renounceOwnership();
        assertEq(board.owner(), address(0));
        vm.expectRevert();
        board.setGuardian(alice);
        // play still works with no admin present
        uint256 id = _openTable();
        _seatAndBet(id);
        _lockAll(id);
        board.retire(id);
        assertEq(ledger.heldBalance(), ledger.totalCredited());
    }

    // ─── pure helpers ────────────────────────────────────────────────────────

    function test_FairMultipleWeights() public view {
        assertEq(board.weightBps(board.KIND_EXACTLY()),  35 * 10_000);
        assertEq(board.weightBps(board.KIND_COLUMN()),    2 * 10_000);
        assertEq(board.weightBps(board.KIND_VOWELS()),    5 * 10_000);
        assertEq(board.weightBps(board.KIND_COLOR()),         10_000);
        assertEq(board.weightBps(board.KIND_LETTER()),  uint256(10 * 10_000) / 26);
        assertEq(board.weightBps(board.KIND_NUMBER()),  uint256(26 * 10_000) / 10);
    }

    /// @dev The seed is PULLED (transferFrom) but sweeps are PUSHED, so the two
    ///      addresses have different requirements: a treasury *contract* with no
    ///      generic approve() can still receive sweeps, but can never fund a seed.
    ///      Splitting them is what lets the real TimbTreasury stay the sweep
    ///      destination while an ops wallet supplies the float.
    function test_SeedFunderSeparateFromTreasury() public {
        address opsWallet = address(0x0F5);
        address coldVault = address(0xC01D); // stands in for a no-approve contract

        PoolLedger l2 = new PoolLedger(address(timbs), coldVault);
        SegmentBoard b2 = new SegmentBoard(
            address(l2), address(registry), address(ent),
            address(prize), address(reserve), coldVault, opsWallet, guardian,
            ENTRY_WINDOW, PLACE_WINDOW, BETS_CLOSE, SIT_QUIET, SOLO_WAIT
        );
        l2.setBoard(address(b2));
        registry.addWriter(address(b2));

        assertEq(b2.treasury(), coldVault, "sweeps go to the treasury");
        assertEq(b2.seedFunder(), opsWallet, "seed is pulled from the ops wallet");

        // only the ops wallet funds; the treasury never needs to approve anything
        timbs.mintTo(opsWallet, 1_000e18);
        vm.prank(opsWallet); timbs.approve(address(l2), type(uint256).max);

        prize.setResult(8, bytes6("ZYXWVU"));
        bytes32[6] memory cs;
        for (uint8 i; i < 6; ++i) cs[i] = ent.commitmentOf(_secret(i + 1), _salt(1, i + 1));
        b2.openTable(8, cs);

        assertEq(l2.heldBalance(), SEED, "seed came from the ops wallet");
        assertEq(timbs.balanceOf(opsWallet), 1_000e18 - SEED);
        assertEq(timbs.balanceOf(coldVault), 0, "treasury paid nothing");
    }

    function test_OnlyOwnerCanRepointSeedFunder() public {
        vm.prank(alice);
        vm.expectRevert();
        board.setSeedFunder(alice);

        board.setSeedFunder(bob);
        assertEq(board.seedFunder(), bob);

        vm.expectRevert(SegmentBoard.ZeroAddress.selector);
        board.setSeedFunder(address(0));
    }

    /// @dev The on-chain commitment helpers must produce commitments that
    ///      actually reveal — this is the guard against binding a commitment to
    ///      the wrong table id, which otherwise only surfaces at lock time.
    function test_CommitmentHelpersRoundTrip() public {
        assertEq(board.nextTableId(), 1, "fresh board opens table 1 next");

        bytes32[6] memory secrets;
        for (uint8 i; i < 6; ++i) secrets[i] = _secret(i + 1);

        uint256 id = board.nextTableId();
        bytes32[6] memory cs = board.commitmentsFor(secrets, id);

        // helper output must match the salt/commitment the board derives itself
        for (uint8 i; i < 6; ++i) {
            assertEq(cs[i], board.commitmentFor(secrets[i], id, i + 1));
            assertEq(board.saltFor(id, i + 1), _salt(id, i + 1));
        }

        // and a table opened on them reveals cleanly for every segment
        assertEq(board.openTable(7, cs), id);
        _seatAndBet(id);
        _lockAll(id);
        assertEq(board.lockedCharsOf(id).length, 6);
        assertGe(ledger.heldBalance(), ledger.totalCredited());
    }

    /// @dev Commitments bound to the wrong table id open fine but cannot reveal.
    function test_CommitmentsForWrongTableIdFailAtLock() public {
        bytes32[6] memory secrets;
        for (uint8 i; i < 6; ++i) secrets[i] = _secret(i + 1);

        bytes32[6] memory wrong = board.commitmentsFor(secrets, 99); // not the id it gets
        uint256 id = board.openTable(7, wrong);
        _seatAndBet(id);
        _fastForward(PICK_DELAY + 1);
        board.armTable(id);
        _advance(1);

        vm.expectRevert(CommitRevealEntropy.BadReveal.selector);
        board.lockSegment(id, 1, secrets[0]);
    }

    /// @dev Regression: RED_MASK must be 36 bits wide. A 32-bit literal silently
    ///      colours indices 32-35 black and breaks the even-money 18/18 split.
    function test_RedBlackIsAnEvenEighteenSplit() public view {
        uint256 reds;
        for (uint8 i; i < 36; ++i) {
            if (board.isRed(i)) ++reds;
        }
        assertEq(reds, 18, "red/black must be an even 18/18 split across all 36 symbols");
    }

    function test_LockedCharsAccumulateInSegmentOrder() public {
        uint256 id = _openTable();
        _seatAndBet(id);
        _fastForward(PICK_DELAY + 1);
        board.armTable(id);
        _advance(1);

        // lock out of order; each char must land in its own slot and leave the
        // others untouched
        board.lockSegment(id, 3, _secret(3));
        bytes6 afterThird = board.lockedCharsOf(id);
        assertTrue(afterThird[2] != 0, "segment 3 writes index 2");
        assertTrue(afterThird[0] == 0 && afterThird[5] == 0, "other slots untouched");

        board.lockSegment(id, 1, _secret(1));
        bytes6 afterFirst = board.lockedCharsOf(id);
        assertTrue(afterFirst[0] != 0, "segment 1 writes index 0");
        assertEq(afterFirst[2], afterThird[2], "segment 3's char survived");
    }

    function test_DoubleDigitRepeatDetection() public view {
        assertFalse(board.hasRepeat(bytes6("ABCDEF")));
        assertTrue(board.hasRepeat(bytes6("ABCDEA")));
        assertTrue(board.hasRepeat(bytes6("A1B1C2")));
    }
}
