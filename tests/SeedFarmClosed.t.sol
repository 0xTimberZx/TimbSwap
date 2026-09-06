// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

// Run: forge test --match-contract SeedFarmClosedTest -vvv
//
// Gen-9 acceptance test. The mirror of tests/SeedFarmExploit.t.sol: the SAME
// two-wallet Red/Black hedge is run against SegmentBoardVRF9, where the seed no
// longer enters any pool. The operator now nets a LOSS (the rake), the seed
// lands in the reserve, and an honest winner is still topped to the same target.
//
// Read the two files together: SeedFarmExploit asserts the drain against gen-8,
// this asserts its absence against gen-9. When both are green, the fix is proven
// by the same scenario that proved the bug.

import "forge-std/Test.sol";
import "../contracts/SegmentBoardVRF9.sol";
import "../contracts/VRFEntropy.sol";
import "../contracts/PoolLedger.sol";
import "../contracts/SeedRegistry.sol";
import "../contracts/UnderwriteReserve.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockTIMBS9 is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") {}
    function mintTo(address to, uint256 amt) external { _mint(to, amt); }
}

contract MockTimbPrize9 {
    mapping(uint256 => bytes6) public roundWinningString;
    function setResult(uint256 round, bytes6 s) external { roundWinningString[round] = s; }
}

contract MockVRFCoordinator9 is IVRFCoordinatorV2Plus {
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

contract SeedFarmClosedTest is Test {
    MockTIMBS9          timbs;
    MockTimbPrize9      prize;
    MockVRFCoordinator9 coord;
    VRFEntropy          ent;
    PoolLedger          ledger;
    SeedRegistry        registry;
    UnderwriteReserve   reserve;
    SegmentBoardVRF9    board;

    address treasury = address(0x7EA5);
    address guardian = address(0x6DA12);
    address seedFund = address(0x5EED);
    address walletA  = address(0xA11CE);
    address walletB  = address(0xB0B);
    address stranger = address(0x57A);

    uint64 constant ENTRY_MAX    = 40 minutes;
    uint64 constant PLACE_WINDOW = 5 minutes;
    uint64 constant BETS_CLOSE   = 2 minutes;
    uint64 constant SIT_QUIET    = 5 minutes;
    uint64 constant SOLO_WAIT    = 15 minutes;

    uint8 constant CHIP5  = 0;
    uint8 constant CHIP25 = 2;
    uint8 KX;
    uint8 KCOLOR;

    uint256 constant RESERVE_START = 100_000e18;
    uint256 nextRound = 600;

    function setUp() public {
        vm.warp(1_000_000);
        vm.roll(1_000);

        timbs    = new MockTIMBS9();
        prize    = new MockTimbPrize9();
        coord    = new MockVRFCoordinator9();
        ledger   = new PoolLedger(address(timbs), treasury);
        registry = new SeedRegistry();
        reserve  = new UnderwriteReserve(address(timbs), treasury, guardian);

        ent = new VRFEntropy(address(coord), bytes32(uint256(0xABC)), 42, 3, 200_000, hex"1234");

        board = new SegmentBoardVRF9(
            address(ledger), address(registry), address(ent),
            address(prize), address(reserve), treasury, seedFund, guardian,
            ENTRY_MAX, PLACE_WINDOW, BETS_CLOSE, SIT_QUIET, SOLO_WAIT
        );
        ledger.setBoard(address(board));
        registry.addWriter(address(board));
        reserve.setBoard(address(board));
        reserve.approveLedger(address(ledger));
        ent.setBoard(address(board));

        KX     = board.KIND_EXACTLY();
        KCOLOR = board.KIND_COLOR();

        timbs.mintTo(seedFund, 1_000_000e18);
        vm.prank(seedFund); timbs.approve(address(ledger), type(uint256).max);
        timbs.mintTo(address(reserve), RESERVE_START);

        for (uint256 i; i < 2; ++i) {
            address p = [walletA, walletB][i];
            timbs.mintTo(p, 10_000e18);
            vm.prank(p); timbs.approve(address(ledger), type(uint256).max);
        }
    }

    function _open() internal returns (uint256 id) {
        prize.setResult(nextRound, bytes6("ABCDEF"));
        id = board.openTable(nextRound);
        ++nextRound;
    }

    function _pickTime(uint256 id) internal view returns (uint64 pt) {
        (, pt,,,,,,,,,,,,,,) = board.tables(id);
    }

    function _sitLoad(address who, uint256 id, uint8 chip) internal {
        vm.startPrank(who);
        board.sit(id, bytes6("ZZZZZZ"));
        board.loadTokens(id, [chip, chip, chip, chip, chip, chip]);
        vm.stopPrank();
    }

    function _armLock(uint256 id, uint8 segment, uint256 word) internal {
        uint256 reqId = coord.nextId();
        vm.prank(stranger); board.armSegment(id, segment);
        coord.fulfil(address(ent), reqId, word);
        vm.prank(stranger); board.lockSegment(id, segment);
    }

    function _charFor(uint256 id, uint8 segment, uint256 word) internal view returns (uint8) {
        return uint8(uint256(keccak256(abi.encodePacked(word, board.saltFor(id, segment)))) % 36);
    }

    // ─── the farm is closed ──────────────────────────────────────────────────

    /// The identical hedge from SeedFarmExploit, now against gen-9. With no seed
    /// in the pot, the operator gets back only the chips minus rake — a small
    /// LOSS — instead of the +78 seed harvest. The seed lands in the reserve.
    function test_HedgeNoLongerFarmsTheSeed() public {
        uint256 reserveBefore = timbs.balanceOf(address(reserve));

        uint256 id = _open();
        _sitLoad(walletA, id, CHIP5);
        _sitLoad(walletB, id, CHIP5);

        for (uint8 seg = 1; seg <= 6; ++seg) {
            vm.prank(walletA); board.place(id, seg, KCOLOR, 0); // Red
            vm.prank(walletB); board.place(id, seg, KCOLOR, 1); // Black
        }

        uint256 staked = 12 * board.CHIPS(CHIP5); // 60
        vm.warp(uint256(_pickTime(id)));
        uint256[6] memory words = [uint256(11), 22, 33, 44, 55, 66];
        for (uint8 seg = 1; seg <= 6; ++seg) _armLock(id, seg, words[seg - 1]);
        board.retire(id);

        uint256 got = ledger.credit(walletA) + ledger.credit(walletB);

        // The hedge no longer profits: the operator is out the rake, not up the seed.
        assertLt(got, staked, "gen-9: the hedge must lose money, not farm the seed");
        assertGt(got, staked * 90 / 100, "and the loss is only the rake, not a wipeout");

        // The seed went to the reserve, not into anyone's pocket. The reserve
        // grows by at least the whole seed (plus its half-rake share).
        assertGe(timbs.balanceOf(address(reserve)) - reserveBefore, board.TABLE_SEED(),
            "the whole seed is routed to the reserve at retire");

        // The seed funder is still out exactly the seed it bankrolled — but now
        // that value became reserve float, not attacker credit.
        assertEq(timbs.balanceOf(seedFund), 1_000_000e18 - board.TABLE_SEED(),
            "seed funder out exactly the seed, as before");

        emit log_named_decimal_int("operator net (TIMBS)", int256(got) - int256(staked), 18);
    }

    // ─── honest play is unchanged ────────────────────────────────────────────

    /// A genuine winner in a CONTESTED pool is still topped to stake x fair x 0.90,
    /// exactly as under gen-8 — the reserve just covers more of it now. walletA
    /// wins an Exactly on a pool walletB also bet (so n=2, contested), and lands
    /// on the fair target of 25 x 36 x 0.90 = 810 with no refund mixed in.
    function test_HonestContestedWinnerStillToppedToTarget() public {
        uint256 id = _open();
        _sitLoad(walletA, id, CHIP25);
        _sitLoad(walletB, id, CHIP25);

        uint256[6] memory words = [uint256(11), 22, 33, 44, 55, 66];
        // A: win seg 1 (Exactly the char that locks), lose 2-6 -> no refund.
        vm.startPrank(walletA);
        board.place(id, 1, KX, _charFor(id, 1, words[0]));
        for (uint8 seg = 2; seg <= 6; ++seg) {
            board.place(id, seg, KX, (_charFor(id, seg, words[seg - 1]) + 1) % 36);
        }
        vm.stopPrank();
        // B: make seg 1 contested with a losing Exactly. Compute the pick BEFORE
        // the prank — vm.prank only covers the next external call, and _charFor's
        // saltFor() would otherwise consume it, sending place() as the test.
        uint8 bPick = (_charFor(id, 1, words[0]) + 1) % 36;
        vm.prank(walletB); board.place(id, 1, KX, bPick);

        vm.warp(uint256(_pickTime(id)));
        for (uint8 seg = 1; seg <= 6; ++seg) _armLock(id, seg, words[seg - 1]);
        board.retire(id);

        uint256 target = board.CHIPS(CHIP25) * 36 * 9000 / 10000; // 810e18
        assertEq(ledger.credit(walletA), target,
            "honest contested winner still reaches stake x fair x 0.90");
    }

    // ─── solvency: nothing stranded ──────────────────────────────────────────

    /// A full round settles and the ledger drains to zero owed — every chip is
    /// either credited to a winner, refunded, or swept. The seed leaving to the
    /// reserve must not break the escrow-sacred invariant.
    function test_FullRoundSettlesAndLedgerDrains() public {
        uint256 id = _open();
        _sitLoad(walletA, id, CHIP25);
        _sitLoad(walletB, id, CHIP25);

        uint256[6] memory words = [uint256(11), 22, 33, 44, 55, 66];
        for (uint8 seg = 1; seg <= 6; ++seg) {
            vm.prank(walletA); board.place(id, seg, KCOLOR, 0);
            vm.prank(walletB); board.place(id, seg, KCOLOR, 1);
        }
        vm.warp(uint256(_pickTime(id)));
        for (uint8 seg = 1; seg <= 6; ++seg) _armLock(id, seg, words[seg - 1]);
        board.retire(id);

        // Escrow-sacred throughout, and this table's escrow is fully resolved.
        assertGe(ledger.heldBalance(), ledger.totalCredited() + ledger.totalEscrowed(),
            "escrow-sacred invariant holds");
        assertEq(ledger.tableEscrow(id), 0, "table escrow fully swept/credited");

        // Both operator wallets can withdraw their credit, and the ledger's owed
        // total returns to zero.
        vm.prank(walletA); ledger.withdraw();
        vm.prank(walletB); ledger.withdraw();
        assertEq(ledger.totalCredited(), 0, "no credit left owed after withdrawals");
    }
}
