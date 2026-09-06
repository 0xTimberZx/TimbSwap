// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

// Run: forge test --match-contract PoolLedgerTest -vvv

import "forge-std/Test.sol";
import "../contracts/PoolLedger.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockTIMBS is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") {
        _mint(msg.sender, 1_000_000e18);
    }
    function mintTo(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// @dev The test contract plays the role of the board (as the repo's tests let
///      the test stand in for a collaborator like TimbPrize).
contract PoolLedgerTest is Test {
    MockTIMBS   timbs;
    PoolLedger  ledger;

    address treasury = address(0x7EA5);
    address alice    = address(0xA11CE);
    address bob      = address(0xB0B);
    address carol    = address(0xCA201);

    /// @dev Two table ids. Most tests only need one; the isolation tests need both.
    uint256 constant T1 = 1;
    uint256 constant T2 = 2;

    function setUp() public {
        timbs  = new MockTIMBS();
        ledger = new PoolLedger(address(timbs), treasury);
        ledger.setBoard(address(this)); // this test IS the board

        // fund players and approve the ledger for their stakes
        timbs.mintTo(alice, 1_000e18);
        timbs.mintTo(bob,   1_000e18);
        timbs.mintTo(carol, 1_000e18);
        vm.prank(alice); timbs.approve(address(ledger), type(uint256).max);
        vm.prank(bob);   timbs.approve(address(ledger), type(uint256).max);
        vm.prank(carol); timbs.approve(address(ledger), type(uint256).max);
        // the board (this) holds seed float and approves the ledger too
        timbs.approve(address(ledger), type(uint256).max);
    }

    // ─── wiring ──────────────────────────────────────────────────────────────

    function test_SetBoardOnlyOnce() public {
        PoolLedger l = new PoolLedger(address(timbs), treasury);
        l.setBoard(address(this));
        assertEq(l.board(), address(this));
        vm.expectRevert(PoolLedger.BoardAlreadySet.selector);
        l.setBoard(bob);
    }

    function test_ConstructorRejectsZero() public {
        vm.expectRevert(PoolLedger.ZeroAddress.selector);
        new PoolLedger(address(0), treasury);
        vm.expectRevert(PoolLedger.ZeroAddress.selector);
        new PoolLedger(address(timbs), address(0));
    }

    function test_OnlyBoardCanCollect() public {
        vm.prank(alice);
        vm.expectRevert(PoolLedger.NotBoard.selector);
        ledger.collect(alice, 100e18, T1);
    }

    // ─── intake + credit + withdraw ────────────────────────────────────────────

    function test_CollectPullsStake() public {
        ledger.collect(alice, 100e18, T1);
        assertEq(ledger.heldBalance(), 100e18);
        assertEq(timbs.balanceOf(alice), 900e18);
    }

    function test_CreditThenWithdraw() public {
        ledger.collect(alice, 100e18, T1);
        ledger.collect(bob,   100e18, T1);           // pot = 200

        address[] memory ws = new address[](2);
        uint256[] memory as_ = new uint256[](2);
        ws[0] = alice; as_[0] = 150e18;          // alice won
        ws[1] = bob;   as_[1] = 0;               // bob lost (skipped)
        ledger.creditWinnings(ws, as_, T1);

        assertEq(ledger.credit(alice), 150e18);
        assertEq(ledger.totalCredited(), 150e18);

        vm.prank(alice);
        ledger.withdraw();
        assertEq(timbs.balanceOf(alice), 900e18 + 150e18);
        assertEq(ledger.credit(alice), 0);
        assertEq(ledger.totalCredited(), 0);
    }

    function test_WithdrawNothingReverts() public {
        vm.prank(carol);
        vm.expectRevert(PoolLedger.NothingToWithdraw.selector);
        ledger.withdraw();
    }

    function test_CreditLengthMismatchReverts() public {
        address[] memory ws = new address[](2);
        uint256[] memory as_ = new uint256[](1);
        vm.expectRevert(PoolLedger.LengthMismatch.selector);
        ledger.creditWinnings(ws, as_, T1);
    }

    // ─── escrow is sacred ──────────────────────────────────────────────────────

    function test_CannotCreditMoreThanTheTableHolds() public {
        ledger.collect(alice, 100e18, T1); // T1's escrow = 100
        address[] memory ws = new address[](1);
        uint256[] memory as_ = new uint256[](1);
        ws[0] = alice; as_[0] = 101e18; // more than the table holds
        vm.expectRevert(
            abi.encodeWithSelector(
                PoolLedger.ExceedsTableEscrow.selector, T1, 101e18, 100e18
            )
        );
        ledger.creditWinnings(ws, as_, T1);
    }

    /// @dev The heart of the gen-3 fix: a pool pays out of its OWN table only.
    ///      T2 is flush; T1 is not; T1's payout must still fail.
    function test_ATableCannotPayOutOfAnotherTablesEscrow() public {
        ledger.collect(alice, 10e18,  T1);
        ledger.collect(bob,   500e18, T2);

        address[] memory ws = new address[](1);
        uint256[] memory as_ = new uint256[](1);
        ws[0] = alice; as_[0] = 200e18;   // plenty in the vault, none of it T1's
        vm.expectRevert(
            abi.encodeWithSelector(
                PoolLedger.ExceedsTableEscrow.selector, T1, 200e18, 10e18
            )
        );
        ledger.creditWinnings(ws, as_, T1);
    }

    function test_RefundCannotReachAnotherTablesEscrow() public {
        ledger.collect(alice, 10e18,  T1);
        ledger.collect(bob,   500e18, T2);
        vm.expectRevert(
            abi.encodeWithSelector(
                PoolLedger.ExceedsTableEscrow.selector, T1, 11e18, 10e18
            )
        );
        ledger.refund(alice, 11e18, T1);
    }

    /// @dev Discovery #11, at the ledger. Closing T1 out takes exactly T1's
    ///      remainder and leaves T2 whole — the old sweep(to, amount) took both.
    function test_SweepingOneTableLeavesAnotherIntact() public {
        ledger.collect(alice, 100e18, T1);
        ledger.collect(bob,   100e18, T1);      // T1 escrow 200
        ledger.collect(carol, 400e18, T2);      // T2 escrow 400

        address[] memory ws = new address[](1);
        uint256[] memory as_ = new uint256[](1);
        ws[0] = alice; as_[0] = 120e18;         // T1: credited 120, 80 left as rake
        ledger.creditWinnings(ws, as_, T1);

        assertEq(ledger.tableEscrow(T1), 80e18);
        assertEq(ledger.tableEscrow(T2), 400e18);

        uint256 swept = ledger.sweepTable(treasury, T1);
        assertEq(swept, 80e18);
        assertEq(timbs.balanceOf(treasury), 80e18);

        // T2 untouched, and T1's winner still holds her credit.
        assertEq(ledger.tableEscrow(T2), 400e18);
        assertEq(ledger.totalEscrowed(),  400e18);
        assertEq(ledger.credit(alice),    120e18);

        // T2 can still pay out in full afterwards.
        ws[0] = carol; as_[0] = 400e18;
        ledger.creditWinnings(ws, as_, T2);
        vm.prank(carol);
        ledger.withdraw();
        assertEq(timbs.balanceOf(carol), 1_000e18);
    }

    function test_SweepingATwiceIsANoOp() public {
        ledger.collect(alice, 100e18, T1);
        assertEq(ledger.sweepTable(treasury, T1), 100e18);
        assertEq(ledger.sweepTable(treasury, T1), 0);
        assertEq(timbs.balanceOf(treasury), 100e18);
    }

    /// @dev The old `unowed()` (balance - totalCredited) counted live escrow as
    ///      protocol surplus, so ownerWithdraw could reach a seated player's chips.
    function test_OwnerWithdrawCannotTouchLiveEscrow() public {
        ledger.collect(alice, 100e18, T1);
        address[] memory ws = new address[](1);
        uint256[] memory as_ = new uint256[](1);
        ws[0] = alice; as_[0] = 60e18;      // credited 60, 40 still escrowed
        ledger.creditWinnings(ws, as_, T1);

        // 40 is the table's rake-in-waiting, not surplus. Nothing is withdrawable.
        assertEq(ledger.unowed(), 0);
        vm.expectRevert(
            abi.encodeWithSelector(PoolLedger.ExceedsUnowed.selector, 1e18, 0)
        );
        ledger.ownerWithdraw(treasury, 1e18);

        // Sweeping the table out is the sanctioned route for the 40.
        assertEq(ledger.sweepTable(treasury, T1), 40e18);
        assertEq(timbs.balanceOf(treasury), 40e18);
        assertEq(ledger.credit(alice), 60e18);

        vm.prank(alice);
        ledger.withdraw();
        assertEq(timbs.balanceOf(alice), 900e18 + 60e18);
    }

    /// @dev ownerWithdraw is now for genuine surplus only: dust and tokens sent
    ///      here by accident, which is exactly what a stray transfer creates.
    function test_OwnerWithdrawTakesStrayTokensOnly() public {
        ledger.collect(alice, 100e18, T1);       // live escrow
        timbs.transfer(address(ledger), 7e18);   // someone fat-fingers a transfer

        assertEq(ledger.unowed(), 7e18);
        vm.expectRevert(
            abi.encodeWithSelector(PoolLedger.ExceedsUnowed.selector, 8e18, 7e18)
        );
        ledger.ownerWithdraw(treasury, 8e18);

        ledger.ownerWithdraw(treasury, 7e18);
        assertEq(timbs.balanceOf(treasury), 7e18);
        assertEq(ledger.tableEscrow(T1), 100e18); // the table never noticed
    }

    function test_OnlyOwnerCanOwnerWithdraw() public {
        ledger.collect(alice, 100e18, T1);
        vm.prank(bob);
        vm.expectRevert();
        ledger.ownerWithdraw(bob, 1e18);
    }

    function test_RefundIsBackedCredit() public {
        ledger.collect(alice, 100e18, T1);
        ledger.refund(alice, 100e18, T1);       // dislodge her unplayed chip
        assertEq(ledger.credit(alice), 100e18);
        vm.prank(alice);
        ledger.withdraw();
        assertEq(timbs.balanceOf(alice), 1_000e18); // whole again
    }

    /// @dev Conservation: held >= totalCredited + totalEscrowed at every step,
    ///      and once the table is swept the vault backs credit exactly.
    function test_ConservationHeldGteCreditedPlusEscrowed() public {
        ledger.collect(alice, 300e18, T1);
        ledger.collect(bob,   200e18, T1);      // T1 escrow 500
        assertGe(ledger.heldBalance(), ledger.totalCredited() + ledger.totalEscrowed());

        address[] memory ws = new address[](2);
        uint256[] memory as_ = new uint256[](2);
        ws[0] = alice; as_[0] = 250e18;
        ws[1] = bob;   as_[1] = 150e18;     // credited 400, 100 left as rake
        ledger.creditWinnings(ws, as_, T1);

        assertEq(ledger.totalCredited(), 400e18);
        assertEq(ledger.totalEscrowed(), 100e18);
        assertGe(ledger.heldBalance(), ledger.totalCredited() + ledger.totalEscrowed());
        assertEq(ledger.unowed(), 0);        // nothing here is protocol surplus

        ledger.sweepTable(treasury, T1);     // rake out
        assertEq(ledger.totalEscrowed(), 0);
        assertEq(ledger.heldBalance(), ledger.totalCredited()); // exactly backed
    }
}
