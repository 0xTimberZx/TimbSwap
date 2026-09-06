// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../contracts/GameRegistry.sol";
import "../contracts/UnderwriteReserve.sol";

/// @dev Minimal mintable ERC20 for the reserve/registry (transfer + allowance).
contract GovMockERC20 is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/**
 * @title GovernanceHardeningTest
 * @notice Proves the M3 / M6 / Ownable2Step hardening.
 *
 *  - M3 (GameRegistry): the admin escape hatch can only REFUND the ticket
 *    owner, never sweep a player's escrow to the protocol sink.
 *  - M6 (UnderwriteReserve): the ledger allowance is single-holder (a new
 *    approval revokes the previous one) and revocable by the guardian.
 *  - Ownable2Step: ownership handoff to the timelock is two-step (nominate +
 *    accept), so it cannot land on a wrong/dead address.
 */
contract GovernanceHardeningTest is Test {
    GovMockERC20     timbs;
    GameRegistry     registry;
    UnderwriteReserve reserve;

    address sink     = address(0xBEEF);
    address player   = address(0xA11CE);
    address guardian = address(0x6A6D);
    address treasury = address(0x7EA5);

    uint256 constant ENTRY_ETH = 0.001 ether; // ETH_ENTRY_FLOOR

    function setUp() public {
        timbs    = new GovMockERC20();
        registry = new GameRegistry(address(timbs), sink, address(0));
        reserve  = new UnderwriteReserve(address(timbs), treasury, guardian);
        vm.deal(player, 1 ether);
    }

    // ─── M3: admin hatch refunds the owner, never the sink ─────────────────────

    function _makeIneligibleTicket() internal returns (uint256 id) {
        vm.startPrank(player);
        registry.submitEntry{value: ENTRY_ETH}(bytes6("AB12CD"), true, 0);
        vm.stopPrank();
        id = registry.activeTicketOf(player);
        registry.adminMarkIneligible(id); // owner (this) flags it
    }

    function test_M3_RefundGoesToOwnerNotSink() public {
        uint256 id = _makeIneligibleTicket();

        uint256 playerBefore = player.balance;
        uint256 sinkBefore   = sink.balance;

        registry.adminRefundStuck(id);

        assertEq(player.balance, playerBefore + ENTRY_ETH, "escrow not refunded to owner");
        assertEq(sink.balance,   sinkBefore,               "sink must receive nothing");
    }

    function test_M3_RefundRevertsWhenNotIneligible() public {
        vm.startPrank(player);
        registry.submitEntry{value: ENTRY_ETH}(bytes6("AB12CD"), true, 0);
        vm.stopPrank();
        uint256 id = registry.activeTicketOf(player);

        vm.expectRevert(); // live ticket is not Ineligible
        registry.adminRefundStuck(id);
    }

    function test_M3_RefundIsOwnerGated() public {
        uint256 id = _makeIneligibleTicket();
        vm.prank(address(0xBAD));
        vm.expectRevert();
        registry.adminRefundStuck(id);
    }

    // ─── M6: single-holder, revocable ledger allowance ─────────────────────────

    function test_M6_ApprovingNewLedgerRevokesOld() public {
        address ledgerA = address(0xA1);
        address ledgerB = address(0xB2);

        reserve.approveLedger(ledgerA);
        assertEq(timbs.allowance(address(reserve), ledgerA), type(uint256).max, "A not approved");
        assertEq(reserve.ledger(), ledgerA, "ledger not tracked");

        reserve.approveLedger(ledgerB);
        assertEq(timbs.allowance(address(reserve), ledgerA), 0,                 "old allowance not revoked");
        assertEq(timbs.allowance(address(reserve), ledgerB), type(uint256).max, "B not approved");
        assertEq(reserve.ledger(), ledgerB, "ledger not updated");
    }

    function test_M6_GuardianCanRevoke() public {
        address ledgerA = address(0xA1);
        reserve.approveLedger(ledgerA);

        vm.prank(guardian);
        reserve.revokeLedger();

        assertEq(timbs.allowance(address(reserve), ledgerA), 0, "allowance not killed");
        assertEq(reserve.ledger(), address(0), "ledger not cleared");
    }

    function test_M6_RevokeRejectsStranger() public {
        reserve.approveLedger(address(0xA1));
        vm.prank(address(0xBAD));
        vm.expectRevert();
        reserve.revokeLedger();
    }

    // ─── Ownable2Step: two-step handoff to the timelock ────────────────────────

    function test_Ownable2Step_TwoStepTransfer() public {
        address newOwner = address(0x7157); // stand-in for the timelock

        registry.transferOwnership(newOwner);
        // Ownership does NOT move until accepted.
        assertEq(registry.owner(), address(this), "owner moved too early");
        assertEq(registry.pendingOwner(), newOwner, "pendingOwner not set");

        vm.prank(newOwner);
        registry.acceptOwnership();
        assertEq(registry.owner(), newOwner, "acceptance did not transfer");
    }

    function test_Ownable2Step_NonPendingCannotAccept() public {
        registry.transferOwnership(address(0x7157));
        vm.prank(address(0xBAD));
        vm.expectRevert();
        registry.acceptOwnership();
    }
}
