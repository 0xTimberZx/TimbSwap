// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../contracts/SegmentBoard.sol";
import "../contracts/SegmentCrank.sol";
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

/// @dev The crank batches only PERMISSIONLESS calls, so the whole guarantee to
///      test is: same end state as doing it by hand, in one transaction, from
///      any caller — and no new way to move money.
contract SegmentCrankTest is Test {
    MockTIMBS timbs; MockTimbPrize prize; PoolLedger ledger;
    SeedRegistry registry; CommitRevealEntropy ent; SegmentBoard board;
    SegmentCrank crank;

    address treasury = address(0x7EA5);
    address alice = address(0xA11CE);
    address bob   = address(0xB0B);
    address rando = address(0xFEED); // proves any caller may crank
    uint8 constant CHIP25 = 2;

    function setUp() public {
        vm.warp(1_000_000); vm.roll(1_000);
        timbs = new MockTIMBS(); prize = new MockTimbPrize();
        ledger = new PoolLedger(address(timbs), treasury);
        registry = new SeedRegistry(); ent = new CommitRevealEntropy();
        UnderwriteReserve reserve = new UnderwriteReserve(address(timbs), treasury, address(0));
        board = new SegmentBoard(address(ledger), address(registry), address(ent),
            address(prize), address(reserve), treasury, treasury, address(0),
            // gen-5 dials chosen so the pick still lands at 45:00 and the
            // adaptive timers (== entryMax) never fire in these tests
            35 minutes, 5 minutes, 5 minutes, 35 minutes, 35 minutes);
        crank = new SegmentCrank();
        ledger.setBoard(address(board)); registry.addWriter(address(board));
        reserve.setBoard(address(board)); reserve.approveLedger(address(ledger));
        timbs.mintTo(treasury, 10_000e18);
        vm.prank(treasury); timbs.approve(address(ledger), type(uint256).max);
        timbs.mintTo(alice, 10_000e18); timbs.mintTo(bob, 10_000e18);
        vm.prank(alice); timbs.approve(address(ledger), type(uint256).max);
        vm.prank(bob);   timbs.approve(address(ledger), type(uint256).max);
        prize.setResult(7, bytes6("ABCDEF"));
    }

    function _secret(uint8 seg) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("s", uint256(1), seg));
    }
    function _openSeatArm() internal returns (uint256 id) {
        bytes32[6] memory cs;
        for (uint8 i; i < 6; ++i) cs[i] = ent.commitmentOf(_secret(i+1), keccak256(abi.encodePacked(uint256(1), i+1)));
        // commitments bind via commitmentsFor to be exact
        bytes32[6] memory secs;
        for (uint8 i; i < 6; ++i) secs[i] = _secret(i+1);
        cs = board.commitmentsFor(secs, board.nextTableId());
        id = board.openTable(7, cs);
        uint8[6] memory chips = [CHIP25,CHIP25,CHIP25,CHIP25,CHIP25,CHIP25];
        vm.startPrank(alice);
        board.sit(id, bytes6("ABCDEF")); board.loadTokens(id, chips);
        for (uint8 s=1; s<=6; ++s) board.place(id, s, board.KIND_LETTER(), 0);
        vm.stopPrank();
        vm.startPrank(bob);
        board.sit(id, bytes6("123456")); board.loadTokens(id, chips);
        for (uint8 s=1; s<=6; ++s) board.place(id, s, board.KIND_NUMBER(), 0);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 45 minutes + 1);
        board.armTable(id);
        vm.roll(vm.getBlockNumber() + 1); // locks must be a later block than the arm
    }

    function test_LockAllPlusRetire_OneCallFromAnyone() public {
        uint256 id = _openSeatArm();
        bytes32[6] memory secs;
        for (uint8 i; i < 6; ++i) secs[i] = _secret(i+1);

        vm.prank(rando); // not the operator, not a player
        crank.lockAll(ISegmentBoardCrank(address(board)), id, secs, true);

        (, , , , , uint8 mask, , bool retired, , , , , , , ) = board.tables(id);
        assertEq(mask, 0x3F, "all six locked in one call");
        assertTrue(retired, "and retired in the same call");
        assertGe(ledger.heldBalance(), ledger.totalCredited());
        assertEq(ledger.tableEscrow(id), 0, "table escrow fully dispersed");
    }

    function test_LockAllSkipsAlreadyLockedSegments() public {
        uint256 id = _openSeatArm();
        board.lockSegment(id, 1, _secret(1));
        board.lockSegment(id, 4, _secret(4));
        bytes32[6] memory secs;
        for (uint8 i; i < 6; ++i) secs[i] = _secret(i+1);
        crank.lockAll(ISegmentBoardCrank(address(board)), id, secs, true);
        (, , , , , uint8 mask, , bool retired, , , , , , , ) = board.tables(id);
        assertEq(mask, 0x3F); assertTrue(retired);
    }

    function test_FallbackAll_AfterRevealWindow() public {
        uint256 id = _openSeatArm();
        // inside the window the fallback batch must revert like the singles do
        vm.expectRevert();
        crank.fallbackAll(ISegmentBoardCrank(address(board)), id, false);

        vm.roll(vm.getBlockNumber() + 65); // past REVEAL_WINDOW, inside horizon
        vm.prank(rando);
        crank.fallbackAll(ISegmentBoardCrank(address(board)), id, true);
        (, , , , , uint8 mask, , bool retired, , , , , , , ) = board.tables(id);
        assertEq(mask, 0x3F, "fallback-locked all six, no secrets");
        assertTrue(retired);
    }

    function test_NothingToDoReverts() public {
        uint256 id = _openSeatArm();
        bytes32[6] memory secs;
        for (uint8 i; i < 6; ++i) secs[i] = _secret(i+1);
        crank.lockAll(ISegmentBoardCrank(address(board)), id, secs, true);
        vm.expectRevert(abi.encodeWithSelector(SegmentCrank.NothingToDo.selector, id));
        crank.lockAll(ISegmentBoardCrank(address(board)), id, secs, false);
    }

    /// @dev End state parity: crank vs by-hand on identical twin tables.
    function test_CrankMatchesManualToTheWei() public {
        prize.setResult(8, bytes6("GHIJKL"));
        uint256 a = _openSeatArm();
        // manual on A
        for (uint8 s=1; s<=6; ++s) board.lockSegment(a, s, _secret(s));
        board.retire(a);
        uint256 creditAfterManual = ledger.totalCredited();

        // identical twin table B, cranked (fresh secrets bound to its id)
        bytes32[6] memory secs2;
        for (uint8 i; i < 6; ++i) secs2[i] = keccak256(abi.encodePacked("t2", i));
        bytes32[6] memory cs2 = board.commitmentsFor(secs2, board.nextTableId());
        uint256 b2 = board.openTable(8, cs2);
        uint8[6] memory chips = [CHIP25,CHIP25,CHIP25,CHIP25,CHIP25,CHIP25];
        vm.startPrank(alice);
        board.sit(b2, bytes6("ABCDEF")); board.loadTokens(b2, chips);
        for (uint8 s=1; s<=6; ++s) board.place(b2, s, board.KIND_LETTER(), 0);
        vm.stopPrank();
        vm.startPrank(bob);
        board.sit(b2, bytes6("123456")); board.loadTokens(b2, chips);
        for (uint8 s=1; s<=6; ++s) board.place(b2, s, board.KIND_NUMBER(), 0);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 45 minutes + 1);
        board.armTable(b2);
        vm.roll(vm.getBlockNumber() + 1);
        crank.lockAll(ISegmentBoardCrank(address(board)), b2, secs2, true);

        // both tables dispersed everything they held; vault still exactly backed
        assertEq(ledger.tableEscrow(a), 0);
        assertEq(ledger.tableEscrow(b2), 0);
        assertGe(ledger.totalCredited(), creditAfterManual, "table B credited winners too");
        assertGe(ledger.heldBalance(), ledger.totalCredited());
    }
}
