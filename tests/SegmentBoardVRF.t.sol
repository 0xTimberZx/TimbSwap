// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

// Run: forge test --match-contract SegmentBoardVRFTest -vvv
//
// Generation 8 — VRF entropy. NOT DEPLOYED.
//
// The suite is aimed squarely at the property gen-8 exists to buy: there is
// exactly ONE way to produce a char, so nobody can choose between outcomes.
// Everything else (settle, underwrite, retire, tips, the gen-7 bonus-chip rule)
// is gen-7's code and is covered by gen-7's suites; what is re-checked here is
// that the new arming path still hands those a well-formed round.

import "forge-std/Test.sol";
import "../contracts/SegmentBoardVRF.sol";
import "../contracts/VRFEntropy.sol";
import "../contracts/PoolLedger.sol";
import "../contracts/SeedRegistry.sol";
import "../contracts/UnderwriteReserve.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockTIMBS8 is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") {}
    function mintTo(address to, uint256 amt) external { _mint(to, amt); }
}

contract MockTimbPrize8 {
    mapping(uint256 => bytes6) public roundWinningString;
    function setResult(uint256 round, bytes6 s) external { roundWinningString[round] = s; }
}

/// Stands in for Chainlink's VRF v2.5 coordinator: hands out ascending request
/// ids, remembers the last request's parameters so the policy can be asserted,
/// and fulfils only when the test says so.
contract MockVRFCoordinator is IVRFCoordinatorV2Plus {
    uint256 public nextId = 1;
    RandomWordsRequest public last;
    uint256 public requestCount;

    function requestRandomWords(RandomWordsRequest calldata req) external returns (uint256) {
        last = req;
        ++requestCount;
        return nextId++;
    }

    function fulfil(address consumer, uint256 requestId, uint256 word) external {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        VRFEntropy(consumer).rawFulfillRandomWords(requestId, words);
    }
}

contract SegmentBoardVRFTest is Test {
    MockTIMBS8        timbs;
    MockTimbPrize8    prize;
    MockVRFCoordinator coord;
    VRFEntropy        ent;
    PoolLedger        ledger;
    SeedRegistry      registry;
    UnderwriteReserve reserve;
    SegmentBoardVRF   board;

    address treasury = address(0x7EA5);
    address alice    = address(0xA11CE);
    address bob      = address(0xB0B);
    address stranger = address(0x57A);

    uint64 constant ENTRY_MAX    = 40 minutes;
    uint64 constant PLACE_WINDOW = 5 minutes;
    uint64 constant BETS_CLOSE   = 2 minutes;
    uint64 constant SIT_QUIET    = 5 minutes;
    uint64 constant SOLO_WAIT    = 15 minutes;

    uint8 constant CHIP25 = 2;
    uint8 KX;  // KIND_EXACTLY, cached — reading it inline would eat a vm.prank

    uint256 nextRound = 800;

    function setUp() public {
        vm.warp(1_000_000);
        vm.roll(1_000);

        timbs    = new MockTIMBS8();
        prize    = new MockTimbPrize8();
        coord    = new MockVRFCoordinator();
        ledger   = new PoolLedger(address(timbs), treasury);
        registry = new SeedRegistry();
        reserve  = new UnderwriteReserve(address(timbs), treasury, address(0));

        ent = new VRFEntropy(
            address(coord),
            bytes32(uint256(0xABC)),          // key hash
            42,                               // subscription id
            3,                                // confirmations
            200_000,                          // callback gas
            hex"1234"                         // extraArgs blob, supplied whole
        );

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

        KX = board.KIND_EXACTLY();

        timbs.mintTo(treasury, 100_000e18);
        vm.prank(treasury); timbs.approve(address(ledger), type(uint256).max);
        for (uint256 i; i < 2; ++i) {
            address p = [alice, bob][i];
            timbs.mintTo(p, 10_000e18);
            vm.prank(p); timbs.approve(address(ledger), type(uint256).max);
        }
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

    function _open() internal returns (uint256 id) {
        prize.setResult(nextRound, bytes6("ABCDEF"));
        id = board.openTable(nextRound);   // no commitments — that is the point
        ++nextRound;
    }

    /// tables() is a 16-tuple as of gen-8 (armedMask appended). Pulling the few
    /// fields the suite cares about through one helper keeps the positional
    /// destructuring in a single place.
    function _tbl(uint256 id) internal view returns (
        uint64 pickTime, uint8 lockedMask, bool ddSettled, bool retired,
        bytes6 chars, uint64 entryCloseAt, uint8 armedMask
    ) {
        (, pickTime, , , , lockedMask, ddSettled, retired, , chars,
         entryCloseAt, , , , , armedMask) = board.tables(id);
    }

    function _sitLoad(address who, bytes6 ticket, uint256 id) internal {
        vm.startPrank(who);
        board.sit(id, ticket);
        board.loadTokens(id, [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25]);
        vm.stopPrank();
    }

    function _readyTable() internal returns (uint256 id) {
        id = _open();
        _sitLoad(alice, bytes6("AAAAAA"), id);
        _sitLoad(bob,   bytes6("BBBBBB"), id);
        (uint64 pickTime,,,,,,) = _tbl(id);
        vm.warp(uint256(pickTime));
    }

    /// The char a given word produces — the same arithmetic anyone watching can
    /// do from the public fulfilment, which is exactly the property being sold.
    function _charIdxFor(uint256 id, uint8 segment, uint256 word) internal view returns (uint8) {
        bytes32 salt = board.saltFor(id, segment);
        return uint8(uint256(keccak256(abi.encodePacked(word, salt))) % 36);
    }

    function _armLock(uint256 id, uint8 segment, uint256 word) internal {
        uint256 reqId = coord.nextId();
        vm.prank(stranger); board.armSegment(id, segment);
        coord.fulfil(address(ent), reqId, word);
        vm.prank(stranger); board.lockSegment(id, segment);
    }

    // ─── the entropy property ────────────────────────────────────────────────

    /// There is no secret, so locking takes no argument and belongs to nobody.
    function test_LockingIsPermissionlessAndArgumentFree() public {
        uint256 id = _readyTable();
        uint256 reqId = coord.nextId();
        vm.prank(alice); board.armSegment(id, 1);
        coord.fulfil(address(ent), reqId, 0xDEADBEEF);

        vm.prank(stranger);            // not the opener, not even seated
        board.lockSegment(id, 1);

        (, uint8 lockedMask,,, bytes6 chars,,) = _tbl(id);
        assertEq(lockedMask, 0x01, "segment 1 locked");
        string memory ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        assertEq(chars[0], bytes(ALPHA)[_charIdxFor(id, 1, 0xDEADBEEF)],
                 "char is keccak(word, salt) % 36 - verifiable by anyone");
    }

    /// The whole point: one derivation path. A segment cannot be locked before
    /// its draw lands, and there is no second route that would let a stalling
    /// party pick a different outcome.
    function test_NoSecondPath_CannotLockBeforeTheDrawLands() public {
        uint256 id = _readyTable();
        vm.prank(alice); board.armSegment(id, 1);

        vm.expectRevert(abi.encodeWithSelector(SegmentBoardVRF.DrawNotIn.selector, uint8(1)));
        board.lockSegment(id, 1);

        // and no amount of waiting opens a fallback — gens 1-7 unlocked one at 64 blocks
        vm.roll(block.number + 300);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(abi.encodeWithSelector(SegmentBoardVRF.DrawNotIn.selector, uint8(1)));
        board.lockSegment(id, 1);
    }

    /// A landed draw is final: nobody — opener, guardian or owner — can reroll it.
    function test_AFulfilledDrawCanNeverBeReplaced() public {
        uint256 id = _readyTable();
        uint256 reqId = coord.nextId();
        vm.prank(alice); board.armSegment(id, 1);
        coord.fulfil(address(ent), reqId, 12345);

        vm.warp(block.timestamp + 10 hours);         // well past REREQUEST_DELAY
        bytes32 salt = board.saltFor(id, 1);
        vm.expectRevert(abi.encodeWithSelector(VRFEntropy.AlreadyFulfilled.selector, salt));
        board.rearmSegment(id, 1);
    }

    /// A replaced request that lands late must not clobber the draw that already
    /// decided the segment.
    function test_StaleFulfilmentCannotOverwriteALandedDraw() public {
        uint256 id = _readyTable();
        uint256 first = coord.nextId();
        vm.prank(alice); board.armSegment(id, 1);

        vm.warp(block.timestamp + ent.REREQUEST_DELAY() + 1);
        uint256 second = coord.nextId();
        board.rearmSegment(id, 1);                   // permissionless
        coord.fulfil(address(ent), second, 999);     // the replacement lands

        bytes32 salt = board.saltFor(id, 1);
        (, uint256 wordAfter,,) = ent.draws(salt);
        coord.fulfil(address(ent), first, 111);      // the original turns up late
        (, uint256 wordNow,, bool ready) = ent.draws(salt);
        assertTrue(ready);
        assertEq(wordNow, wordAfter, "late fulfilment is ignored");
        assertEq(wordNow, 999, "the draw that landed first stands");
    }

    function test_RerequestIsRefusedBeforeTheDelay() public {
        uint256 id = _readyTable();
        vm.prank(alice); board.armSegment(id, 1);
        vm.expectRevert();                            // TooSoonToReplace
        board.rearmSegment(id, 1);
    }

    /// A draw that never comes back cannot jam the table.
    function test_AStuckDrawIsRecoverable() public {
        uint256 id = _readyTable();
        vm.prank(alice); board.armSegment(id, 1);
        assertEq(coord.requestCount(), 1);

        vm.warp(block.timestamp + ent.REREQUEST_DELAY() + 1);
        (,,, bool lockable, bool replaceable) = board.segmentState(id, 1);
        assertFalse(lockable);
        assertTrue(replaceable, "the apps can see it is stuck");

        uint256 reqId = coord.nextId();
        vm.prank(stranger); board.rearmSegment(id, 1);
        assertEq(coord.requestCount(), 2);
        coord.fulfil(address(ent), reqId, 7);
        vm.prank(stranger); board.lockSegment(id, 1);
        (, uint8 mask,,,,,) = _tbl(id);
        assertEq(mask, 0x01, "recovered");
    }

    // ─── arming rules ────────────────────────────────────────────────────────

    function test_ArmingIsOnePerSegmentAndNotBeforeThePick() public {
        uint256 id = _open();
        _sitLoad(alice, bytes6("AAAAAA"), id);
        _sitLoad(bob,   bytes6("BBBBBB"), id);

        vm.expectRevert(SegmentBoardVRF.NotYetPickTime.selector);
        board.armSegment(id, 1);

        (uint64 pickTime,,,,,,) = _tbl(id);
        vm.warp(uint256(pickTime));
        board.armSegment(id, 1);
        vm.expectRevert(abi.encodeWithSelector(SegmentBoardVRF.SegmentAlreadyArmed.selector, uint8(1)));
        board.armSegment(id, 1);

        vm.expectRevert(SegmentBoardVRF.BadSegment.selector);
        board.armSegment(id, 7);
    }

    /// Six requests a round, one per segment — the cost the staggered drumroll
    /// is worth, and the reason the whole round is not public at once.
    function test_OneRequestPerSegment() public {
        uint256 id = _readyTable();
        for (uint8 s = 1; s <= 6; ++s) _armLock(id, s, uint256(s) * 1e9);
        assertEq(coord.requestCount(), 6, "one VRF draw per segment");
    }

    function test_ArmingNeedsTwoFundedSeats() public {
        uint256 id = _open();
        _sitLoad(alice, bytes6("AAAAAA"), id);
        (uint64 pickTime,,,,,,) = _tbl(id);
        vm.warp(uint256(pickTime));
        vm.expectRevert(abi.encodeWithSelector(SegmentBoardVRF.NotEnoughSeats.selector, uint8(1), uint8(2)));
        board.armSegment(id, 1);
    }

    // ─── the round still works end to end ────────────────────────────────────

    function test_FullRoundSettlesAndTheLedgerDrains() public {
        uint256 id = _readyTable();
        for (uint8 s = 1; s <= 6; ++s) _armLock(id, s, uint256(keccak256(abi.encode("w", s))));

        board.retire(id);
        assertEq(ledger.tableEscrow(id), 0, "table escrow drained at retire");
        (,, bool ddSettled, bool retired,,,) = _tbl(id);
        assertTrue(ddSettled, "DD settled on the sixth lock");
        assertTrue(retired);
    }

    /// A winning Exactly bet still pays out of the pool + reserve, so the gen-6
    /// machinery downstream of the new arming path is intact.
    function test_AWinningBetStillPays() public {
        uint256 id = _open();
        _sitLoad(alice, bytes6("AAAAAA"), id);
        _sitLoad(bob,   bytes6("BBBBBB"), id);

        uint256 word = 0xC0FFEE;
        uint8 idx = _charIdxFor(id, 1, word);
        vm.prank(alice); board.place(id, 1, KX, idx);   // the char that will land
        vm.prank(bob);   board.place(id, 1, KX, uint8((uint256(idx) + 1) % 36));

        (uint64 pickTime,,,,,,) = _tbl(id);
        vm.warp(uint256(pickTime));
        _armLock(id, 1, word);

        assertGt(ledger.credit(alice), 0, "the winner was credited");
        assertEq(ledger.credit(bob), 0, "the loser was not");
    }

    // ─── access control ──────────────────────────────────────────────────────

    function test_OnlyTheBoardRequestsAndOnlyTheCoordinatorFulfils() public {
        bytes32 salt = board.saltFor(1, 1);
        vm.expectRevert(VRFEntropy.NotBoard.selector);
        ent.requestFor(salt);

        uint256[] memory words = new uint256[](1);
        words[0] = 1;
        vm.expectRevert(VRFEntropy.NotCoordinator.selector);
        ent.rawFulfillRandomWords(1, words);
    }

    function test_PolicyReachesTheCoordinatorButCannotTouchALandedDraw() public {
        uint256 id = _readyTable();
        vm.prank(alice); board.armSegment(id, 1);

        (bytes32 keyHash, uint256 subId, uint16 conf, uint32 gas, bytes memory extra) = _lastRequest();
        assertEq(keyHash, bytes32(uint256(0xABC)));
        assertEq(subId, 42);
        assertEq(conf, 3);
        assertEq(gas, 200_000);
        assertEq(extra, hex"1234", "extraArgs is passed through verbatim, never re-encoded here");

        // retuning affects only future requests
        ent.setPolicy(bytes32(uint256(0xDEF)), 43, 5, 300_000);
        (bytes32 k2,,,,) = _lastRequest();
        assertEq(k2, bytes32(uint256(0xABC)), "the in-flight request is untouched");
    }

    function _lastRequest() internal view
        returns (bytes32, uint256, uint16, uint32, bytes memory)
    {
        (bytes32 k, uint256 s, uint16 c, uint32 g, uint32 n, bytes memory e) = coord.last();
        assertEq(n, 1, "exactly one word per request");
        return (k, s, c, g, e);
    }

    // ─── carried rules ───────────────────────────────────────────────────────

    /// Gen-7's bonus-chip rule rides along.
    function test_Gen7BonusChipRuleIsCarried() public {
        uint256 id = _open();
        _sitLoad(alice, bytes6("AAAAAA"), id);
        vm.prank(bob); board.sit(id, bytes6("BBBBBB"));   // seated, never funded
        vm.prank(bob);
        vm.expectRevert(SegmentBoardVRF.NotLoaded.selector);
        board.placeDoubleDigit(id, CHIP25);
    }

    /// cancelTable's premise - nothing settled - is now guarded by armedMask
    /// rather than by the old lockBlock. The guard is belt-and-braces: a table
    /// with two funded seats is refused by the seat check before the arm check
    /// can ever matter, which is the same relationship gen-7 had.
    function test_CancelStillWorksAndIsRefusedOnceTheTableCanProceed() public {
        uint256 id = _open();
        _sitLoad(alice, bytes6("AAAAAA"), id);          // one funded seat only
        (,,,,, uint64 entryCloseAt,) = _tbl(id);
        vm.warp(uint256(entryCloseAt) + 1);
        board.cancelTable(id);
        assertEq(ledger.tableEscrow(id), 0, "cancel refunds everything");

        uint256 id2 = _readyTable();
        board.armSegment(id2, 1);
        (,,,,,, uint8 armedMask) = _tbl(id2);
        assertEq(armedMask, 0x01, "arming is recorded per segment");
        vm.expectRevert(abi.encodeWithSelector(
            SegmentBoardVRF.TableCanProceed.selector, uint8(2), uint8(2)));
        board.cancelTable(id2);
    }
}
