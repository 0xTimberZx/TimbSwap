// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

// Run: forge test --match-contract DDJackpotTest -vvv
//
// M2 — the Rolling Double-Digit Jackpot (SwapTables/docs/GAME_ECONOMY.md),
// exercised against a REAL gen-6 board. Outcomes are deterministic: chars are
// predicted on a state snapshot, and the suite scans table ids until the
// deterministic outcome has (or lacks) a repeat — no test depends on luck.

import "forge-std/Test.sol";
import "../contracts/SegmentBoard.sol";
import "../contracts/PoolLedger.sol";
import "../contracts/SeedRegistry.sol";
import "../contracts/CommitRevealEntropy.sol";
import "../contracts/UnderwriteReserve.sol";
import "../contracts/DDJackpot.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockTIMBSJ is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") {}
    function mintTo(address to, uint256 amt) external { _mint(to, amt); }
}

contract MockTimbPrizeJ {
    mapping(uint256 => bytes6) public roundWinningString;
    function setResult(uint256 round, bytes6 s) external { roundWinningString[round] = s; }
}

contract DDJackpotTest is Test {
    MockTIMBSJ          timbs;
    MockTimbPrizeJ      prize;
    PoolLedger          ledger;
    SeedRegistry        registry;
    CommitRevealEntropy ent;
    UnderwriteReserve   reserve;
    SegmentBoard        board;
    DDJackpot           jackpot;

    address treasury = address(0x7EA5);
    address alice    = address(0xA11CE);
    address bob      = address(0xB0B);

    uint8 constant CHIP25 = 2; // 25 TIMBS
    uint8 constant CHIP50 = 3; // 50 TIMBS

    uint256 constant ARMB = 1_500; // fixed arm block: chars vary per table id

    uint256 nextRound = 7;

    function setUp() public {
        vm.warp(1_000_000);
        vm.roll(1_000);

        timbs    = new MockTIMBSJ();
        prize    = new MockTimbPrizeJ();
        ledger   = new PoolLedger(address(timbs), treasury);
        registry = new SeedRegistry();
        ent      = new CommitRevealEntropy();
        reserve  = new UnderwriteReserve(address(timbs), treasury, address(0));

        board = new SegmentBoard(
            address(ledger), address(registry), address(ent),
            address(prize), address(reserve), treasury, treasury, address(0),
            40 minutes, 5 minutes, 2 minutes, 5 minutes, 15 minutes
        );
        ledger.setBoard(address(board));
        registry.addWriter(address(board));
        reserve.setBoard(address(board));
        reserve.approveLedger(address(ledger));

        jackpot = new DDJackpot(address(timbs), treasury, address(this)); // guardian = this test
        jackpot.setBoard(address(board), true);

        timbs.mintTo(treasury, 100_000e18);
        vm.prank(treasury); timbs.approve(address(ledger), type(uint256).max);
        timbs.mintTo(alice, 10_000e18);
        timbs.mintTo(bob,   10_000e18);
        vm.prank(alice); timbs.approve(address(ledger), type(uint256).max);
        vm.prank(bob);   timbs.approve(address(ledger), type(uint256).max);

        timbs.mintTo(address(this), 100_000e18);
        timbs.approve(address(jackpot), type(uint256).max);
    }

    // ─── helpers (the Gen6 suite's prediction technique) ─────────────────────

    function _secret(uint256 id, uint8 seg) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("jackpot-secret", id, seg));
    }

    function _open() internal returns (uint256 id) {
        prize.setResult(nextRound, bytes6("ABCDEF"));
        uint256 wantId = board.nextTableId();
        bytes32[6] memory secs;
        for (uint8 s = 1; s <= 6; ++s) secs[s-1] = _secret(wantId, s);
        id = board.openTable(nextRound, board.commitmentsFor(secs, wantId));
        ++nextRound;
    }

    function _sitLoad(address who, uint256 id) internal {
        vm.startPrank(who);
        board.sit(id, bytes6("TICKET"));
        board.loadTokens(id, [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25]);
        vm.stopPrank();
    }

    function _pickTimeOf(uint256 id) internal view returns (uint64 pickTime) {
        (, pickTime,,,,,,,,,,,,,) = board.tables(id);
    }

    function _armAndLock(uint256 id) internal {
        vm.warp(uint256(_pickTimeOf(id)) + 1);
        vm.roll(ARMB);
        board.armTable(id);
        vm.roll(ARMB + 1);
        for (uint8 s = 1; s <= 6; ++s) board.lockSegment(id, s, _secret(id, s));
    }

    function _predictChars(uint256 id) internal returns (bytes6 chars) {
        uint256 snap = vm.snapshotState();
        _armAndLock(id);
        chars = board.lockedCharsOf(id);
        vm.revertToState(snap);
    }

    /// @dev Open seated+loaded tables until the deterministic outcome matches.
    function _openWithRepeat(bool wantRepeat) internal returns (uint256 id) {
        for (uint256 i; i < 25; ++i) {
            id = _open();
            _sitLoad(alice, id);
            _sitLoad(bob, id);
            if (board.hasRepeat(_predictChars(id)) == wantRepeat) return id;
        }
        revert("no matching table in 25 tries");
    }

    function _placeDD(address who, uint256 id, uint8 chip) internal {
        vm.prank(who);
        board.placeDoubleDigit(id, chip);
    }

    // ─── strikes ─────────────────────────────────────────────────────────────

    function test_StrikePaysTheMeteredSliceProRata() public {
        jackpot.donate(1_000e18);
        uint256 id = _openWithRepeat(true);
        _placeDD(alice, id, CHIP25);   // 25
        _placeDD(bob,   id, CHIP50);   // 50 — two distinct DD wallets (§9 met)
        _armAndLock(id);

        (bool ok, uint256 preview) = jackpot.strikeable(address(board), id);
        assertTrue(ok, "eligible after the sixth lock");
        // preview is the true post-cap payout: the floored pro-rata shares of
        // the 200 slice (the 1-wei rounding dust stays on the banner)
        assertEq(preview, uint256(200e18) * 25 / 75 + uint256(200e18) * 50 / 75,
            "preview equals what the strike will actually pay");

        uint256 aBefore = timbs.balanceOf(alice);
        uint256 bBefore = timbs.balanceOf(bob);
        jackpot.strike(address(board), id);    // permissionless: test is a rando here

        // pro-rata by DD stake: 25/75 and 50/75 of the 200 slice, pushed
        // straight to the wallets — the banner survives its own payout
        assertEq(timbs.balanceOf(alice) - aBefore, uint256(200e18) * 25 / 75, "alice's share");
        assertEq(timbs.balanceOf(bob)   - bBefore, uint256(200e18) * 50 / 75, "bob's share");
        assertGt(jackpot.balance(), 799e18, "80% of the pot still on the banner");

        vm.expectRevert(abi.encodeWithSelector(DDJackpot.AlreadyStruck.selector, address(board), id));
        jackpot.strike(address(board), id);
    }

    function test_SoloDDNeverStrikes() public {
        jackpot.donate(1_000e18);
        uint256 id = _openWithRepeat(true);
        _placeDD(alice, id, CHIP25);           // one wallet only
        _armAndLock(id);
        vm.expectRevert(abi.encodeWithSelector(DDJackpot.NotEnoughDDWallets.selector, 1, 2));
        jackpot.strike(address(board), id);
    }

    function test_NoRepeatNeverStrikes() public {
        jackpot.donate(1_000e18);
        uint256 id = _openWithRepeat(false);
        _placeDD(alice, id, CHIP25);
        _placeDD(bob,   id, CHIP25);
        _armAndLock(id);
        vm.expectRevert(abi.encodeWithSelector(DDJackpot.DDDidNotHit.selector, id));
        jackpot.strike(address(board), id);
    }

    function test_UnsettledTableRejected() public {
        jackpot.donate(1_000e18);
        uint256 id = _openWithRepeat(true);
        _placeDD(alice, id, CHIP25);
        _placeDD(bob,   id, CHIP25);
        // no locks yet
        vm.expectRevert(abi.encodeWithSelector(DDJackpot.DDNotSettled.selector, id));
        jackpot.strike(address(board), id);
    }

    function test_UnknownBoardRejected() public {
        jackpot.donate(1_000e18);
        vm.expectRevert(abi.encodeWithSelector(DDJackpot.BoardNotTrusted.selector, address(0xBAD)));
        jackpot.strike(address(0xBAD), 1);
    }

    function test_FloorAndClampMetering() public {
        // 20% of 100 is 20 — the 50 floor wins
        jackpot.donate(100e18);
        uint256 id = _openWithRepeat(true);
        _placeDD(alice, id, CHIP25);
        _placeDD(bob,   id, CHIP25);
        _armAndLock(id);
        uint256 aBefore = timbs.balanceOf(alice);
        uint256 bBefore = timbs.balanceOf(bob);
        jackpot.strike(address(board), id);
        assertEq((timbs.balanceOf(alice)-aBefore)+(timbs.balanceOf(bob)-bBefore), 50e18, "floor applies");
        assertEq(jackpot.balance(), 50e18);

        // and the floor clamps to the balance when the pot holds less
        uint256 id2 = _openWithRepeat(true);
        _placeDD(alice, id2, CHIP25);
        _placeDD(bob,   id2, CHIP25);
        _armAndLock(id2);
        (bool ok, uint256 preview) = jackpot.strikeable(address(board), id2);
        assertTrue(ok);
        assertEq(preview, 50e18, "whole remaining balance");
        jackpot.strike(address(board), id2);
        assertEq(jackpot.balance(), 0, "banner empties, never reverts");
    }

    function test_HaltBlocksStrikesAndDrainRetires() public {
        jackpot.donate(500e18);
        uint256 id = _openWithRepeat(true);
        _placeDD(alice, id, CHIP25);
        _placeDD(bob,   id, CHIP25);
        _armAndLock(id);

        jackpot.setHalted(true);               // guardian = this test
        (bool ok,) = jackpot.strikeable(address(board), id);
        assertFalse(ok);
        vm.expectRevert(DDJackpot.Halted.selector);
        jackpot.strike(address(board), id);

        uint256 tBefore = timbs.balanceOf(treasury);
        jackpot.drainToTreasury();
        assertEq(timbs.balanceOf(treasury) - tBefore, 500e18, "everything to Treasury");
        assertEq(jackpot.balance(), 0);
    }

    /// The operator's question, answered in code: a 5-chip DD bet can carry
    /// at most 10x its own chip out of the banner. Two 5-chips on a 1000
    /// jackpot draw 50 each — not the full 200 slice a 1000-chip table would.
    function test_SmallChipsCannotDrainTheBanner() public {
        jackpot.donate(1_000e18);
        uint256 id = _openWithRepeat(true);
        _placeDD(alice, id, 0);                // 5-TIMBS chips
        _placeDD(bob,   id, 0);
        _armAndLock(id);

        (bool ok, uint256 preview) = jackpot.strikeable(address(board), id);
        assertTrue(ok);
        assertEq(preview, 100e18, "stake cap: 2 x (10 x 5), not the 200 slice");

        uint256 aBefore = timbs.balanceOf(alice);
        jackpot.strike(address(board), id);
        assertEq(timbs.balanceOf(alice) - aBefore, 50e18, "10x your chip, no more");
        assertEq(jackpot.balance(), 900e18, "the uncollected slice stays on the banner");
    }

    function test_MeterBoundsEnforced() public {
        vm.expectRevert(abi.encodeWithSelector(DDJackpot.BadMeter.selector, 6_000));
        jackpot.setMeter(6_000, 50e18, 10);    // >50% refused
        vm.expectRevert(abi.encodeWithSelector(DDJackpot.BadMeter.selector, 2_000));
        jackpot.setMeter(2_000, 50e18, 0);     // zero stake cap refused
        jackpot.setMeter(2_500, 100e18, 8);    // fine
        assertEq(jackpot.sliceBps(), 2_500);
        assertEq(jackpot.stakeCapMult(), 8);
        vm.prank(alice);
        vm.expectRevert();                     // OwnableUnauthorizedAccount
        jackpot.setMeter(1_000, 1e18, 10);
    }
}
