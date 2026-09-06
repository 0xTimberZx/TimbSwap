// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

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
    function setResult(uint256 r, bytes6 s) external { roundWinningString[r] = s; }
}

/// @dev Two tables live at once — the board is designed for ~40 (TABLES_MAX),
///      so this is the normal case, not a corner. Under gen-2's global
///      `unowed()` sweep, closing either one took the other's seed and its
///      players' chips (VALIDATION.md discovery #11). These tests are the
///      inversion of that: per-table escrow, proven end to end through the board.
contract MultiTableSweepTest is Test {
    MockTIMBS timbs; MockTimbPrize prize; PoolLedger ledger;
    UnderwriteReserve reserve;
    SeedRegistry registry; CommitRevealEntropy ent; SegmentBoard board;

    address treasury = address(0x7EA5);
    address alice = address(0xA11CE);
    address bob   = address(0xB0B);
    uint8 constant CHIP25 = 2;
    uint8 kLetter; uint8 kNumber;

    function setUp() public {
        vm.warp(1_000_000); vm.roll(1_000);
        timbs = new MockTIMBS(); prize = new MockTimbPrize();
        ledger = new PoolLedger(address(timbs), treasury);
        registry = new SeedRegistry(); ent = new CommitRevealEntropy();
        reserve = new UnderwriteReserve(address(timbs), treasury, address(0));
        board = new SegmentBoard(address(ledger), address(registry), address(ent),
            address(prize), address(reserve), treasury, treasury, address(0),
            // gen-5 dials chosen so the pick still lands at 45:00 and the
            // adaptive timers (== entryMax) never fire in these tests
            35 minutes, 5 minutes, 5 minutes, 35 minutes, 35 minutes);
        ledger.setBoard(address(board)); registry.addWriter(address(board));
        reserve.setBoard(address(board)); reserve.approveLedger(address(ledger));
        timbs.mintTo(treasury, 10_000e18);
        vm.prank(treasury); timbs.approve(address(ledger), type(uint256).max);
        timbs.mintTo(alice, 10_000e18); timbs.mintTo(bob, 10_000e18);
        vm.prank(alice); timbs.approve(address(ledger), type(uint256).max);
        vm.prank(bob);   timbs.approve(address(ledger), type(uint256).max);
        prize.setResult(7, bytes6("ABCDEF"));
        prize.setResult(8, bytes6("GHIJKL"));
        kLetter = board.KIND_LETTER(); kNumber = board.KIND_NUMBER();
    }

    function _secret(uint256 id, uint8 seg) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("s", id, seg));
    }
    function _salt(uint256 id, uint8 seg) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(id, seg));
    }
    function _commits(uint256 id) internal view returns (bytes32[6] memory cs) {
        for (uint8 i; i < 6; ++i) cs[i] = ent.commitmentOf(_secret(id, i+1), _salt(id, i+1));
    }
    function _seatAndBet(uint256 id, bytes6 t1, bytes6 t2) internal {
        uint8[6] memory chips = [CHIP25,CHIP25,CHIP25,CHIP25,CHIP25,CHIP25];
        vm.startPrank(alice);
        board.sit(id, t1); board.loadTokens(id, chips);
        for (uint8 s=1; s<=6; ++s) board.place(id, s, kLetter, 0);
        vm.stopPrank();
        vm.startPrank(bob);
        board.sit(id, t2); board.loadTokens(id, chips);
        for (uint8 s=1; s<=6; ++s) board.place(id, s, kNumber, 0);
        vm.stopPrank();
    }

    /// @dev The gen-3 fix, stated as its own test. Same setup as the gen-2
    ///      known-bug case (which asserted the opposite): table A's retire must
    ///      take exactly table A's remainder and leave table B whole.
    function test_RetiringOneTableLeavesAnotherLiveTablesEscrowIntact() public {
        uint256 a = board.openTable(7, _commits(1));
        uint256 b = board.openTable(8, _commits(2));
        assertEq(ledger.heldBalance(), 200e18, "two seeds held");

        _seatAndBet(a, bytes6("ABCDEF"), bytes6("123456"));
        _seatAndBet(b, bytes6("ABCDEF"), bytes6("123456"));

        // 100 seed + 2 wallets x 6 x 25 chips, per table
        assertEq(ledger.tableEscrow(a), 400e18);
        assertEq(ledger.tableEscrow(b), 400e18);

        // settle + retire table A only; table B is still live and unsettled
        vm.warp(vm.getBlockTimestamp() + 45 minutes + 1);
        board.armTable(a);
        vm.roll(vm.getBlockNumber() + 1);
        for (uint8 s=1; s<=6; ++s) board.lockSegment(a, s, _secret(a, s));

        uint256 treasuryBefore = timbs.balanceOf(treasury);
        board.retire(a);

        // A's escrow is spent; B's is untouched to the wei.
        assertEq(ledger.tableEscrow(a), 0,      "table A drained");
        assertEq(ledger.tableEscrow(b), 400e18, "table B untouched");
        assertEq(ledger.totalEscrowed(), 400e18);

        // Treasury took only A's leftovers — never more than A ever held.
        uint256 swept = timbs.balanceOf(treasury) - treasuryBefore;
        assertLe(swept, 400e18, "swept beyond table A's own escrow");

        // The vault still backs everyone: B's stake plus A's unwithdrawn credits.
        assertGe(ledger.heldBalance(), ledger.totalCredited() + ledger.totalEscrowed());

        // And table B settles and pays normally afterwards.
        board.armTable(b);
        vm.roll(vm.getBlockNumber() + 1);
        for (uint8 s=1; s<=6; ++s) board.lockSegment(b, s, _secret(b, s));
        board.retire(b);

        assertEq(ledger.tableEscrow(b), 0);
        assertEq(ledger.totalEscrowed(), 0);
        assertGe(ledger.heldBalance(), ledger.totalCredited());

        // Both wallets can pull whatever the two tables owe them.
        if (ledger.credit(alice) > 0) { vm.prank(alice); ledger.withdraw(); }
        if (ledger.credit(bob)   > 0) { vm.prank(bob);   ledger.withdraw(); }
        assertEq(ledger.totalCredited(), 0, "everyone paid out");
    }

    /// @dev Settle the two tables in the opposite order and check each pays out
    ///      of its own stakes — the parallel-scale case the board was always
    ///      meant for (TABLES_MAX is 40) and which no test covered before.
    function test_TwoTablesSettleInEitherOrder() public {
        uint256 a = board.openTable(7, _commits(1));
        uint256 b = board.openTable(8, _commits(2));
        _seatAndBet(a, bytes6("ABCDEF"), bytes6("123456"));
        _seatAndBet(b, bytes6("ABCDEF"), bytes6("123456"));

        vm.warp(vm.getBlockTimestamp() + 45 minutes + 1);
        board.armTable(b);                       // B first this time
        vm.roll(vm.getBlockNumber() + 1);
        for (uint8 s=1; s<=6; ++s) board.lockSegment(b, s, _secret(b, s));
        board.retire(b);

        assertEq(ledger.tableEscrow(a), 400e18, "table A untouched by B's retire");

        board.armTable(a);
        vm.roll(vm.getBlockNumber() + 1);
        for (uint8 s=1; s<=6; ++s) board.lockSegment(a, s, _secret(a, s));
        board.retire(a);

        assertEq(ledger.totalEscrowed(), 0);
        // Nothing was created or destroyed: every token that entered the ledger
        // is now a wallet's credit, in the Treasury, or in the gen-6 reserve
        // (which takes every dead pot plus half the rake at retire).
        assertEq(
            ledger.totalCredited() + timbs.balanceOf(treasury)
                + timbs.balanceOf(address(reserve)) - 10_000e18 + 200e18,
            800e18,
            "conservation across two parallel tables"
        );
    }
}
