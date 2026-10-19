// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";

import "../contracts/GameRegistry.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockTimbsRW is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") { _mint(msg.sender, 1_000_000e18); }
}

/**
 * @title RefundWindowTest
 * @notice Fix list 70: the principal refund window is a bounded owner setting
 *         (4..24 rounds) that only ever changes at a fresh generation, so every
 *         ticket keeps the window it was minted under and the settlement sweep
 *         (which reads the live value) always finds the tickets that are due.
 *         This contract plays TimbPrize, as in GameRegistryGenerationsTest.
 *
 * Run: forge test --match-contract RefundWindowTest -vvv
 */
contract RefundWindowTest is Test {
    MockTimbsRW  timbs;
    GameRegistry registry;

    address sink  = address(0xBEEF);
    address alice = address(0xA11CE);
    address bob   = address(0xB0B);

    uint256 constant ENTRY_ETH = 0.001 ether;
    bytes6  constant STR_A = bytes6("ABCDEF");
    bytes6  constant STR_B = bytes6("GHIJKL");

    function setUp() public {
        timbs    = new MockTimbsRW();
        registry = new GameRegistry(address(timbs), sink, address(this), 2e18, 1e18);
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _submit(address who, bytes6 s) internal returns (uint256 id) {
        vm.prank(who);
        registry.submitEntry{value: ENTRY_ETH}(s, true, 0);
        id = registry.activeTicketOf(who);
    }

    function _activate(uint256 round, address a, address b) internal {
        registry.setCurrentRound(round);
        address[] memory ps = new address[](b == address(0) ? 1 : 2);
        ps[0] = a;
        if (b != address(0)) ps[1] = b;
        registry.activateRoundEntries(round, ps);
    }

    function _settle(uint256 round) internal {
        registry.setCurrentRound(round + 1);
        registry.onRoundSettled(round, 0);
    }

    function _ticket(uint256 id) internal view returns (GameRegistry.Ticket memory t) {
        (t,) = registry.getTicket(id);
    }

    // ─── Bounds and access ───────────────────────────────────────────────────

    function test_DefaultIsFourRounds() public view {
        assertEq(registry.refundWindowRounds(), 4);
        assertEq(registry.pendingRefundWindowRounds(), 0);
        assertEq(registry.MIN_REFUND_WINDOW_ROUNDS(), 4);
        assertEq(registry.MAX_REFUND_WINDOW_ROUNDS(), 24);
    }

    function test_BoundsEnforced() public {
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.InvalidRefundWindow.selector, 3));
        registry.setRefundWindowRounds(3);
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.InvalidRefundWindow.selector, 25));
        registry.setRefundWindowRounds(25);
        registry.setRefundWindowRounds(24);
        assertEq(registry.refundWindowRounds(), 24);
    }

    function test_OwnerOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        registry.setRefundWindowRounds(12);
    }

    // ─── Before any ticket: applies at once ──────────────────────────────────

    function test_NoTicketsYetAppliesAtOnce() public {
        registry.onGameStarted();
        registry.setRefundWindowRounds(12);
        assertEq(registry.refundWindowRounds(), 12, "applied immediately");
        assertEq(registry.pendingRefundWindowRounds(), 0);

        uint256 id = _submit(alice, STR_A);
        GameRegistry.Ticket memory t = _ticket(id);
        assertEq(t.forfeitRound, t.lastEligibleRound + 12, "minted under 12");
    }

    // ─── After a ticket exists: staged, nothing changes this generation ──────

    function test_MidGenerationSetIsStagedAndChangesNothing() public {
        registry.onGameStarted();
        uint256 a = _submit(alice, STR_A);              // plays round 2
        registry.setRefundWindowRounds(12);
        assertEq(registry.refundWindowRounds(), 4, "live value unchanged");
        assertEq(registry.pendingRefundWindowRounds(), 12, "staged");

        uint256 b = _submit(bob, STR_B);                // same generation, after the set
        assertEq(_ticket(a).forfeitRound, _ticket(a).lastEligibleRound + 4);
        assertEq(_ticket(b).forfeitRound, _ticket(b).lastEligibleRound + 4, "still minted under 4");

        _activate(2, alice, bob);
        // Both lapse at LER + 4 = 6, exactly as before the set.
        _settle(2); _settle(3); _settle(4); _settle(5);
        assertEq(uint8(_ticket(a).status), uint8(GameRegistry.TicketStatus.Active), "not yet due");
        _settle(6);
        assertEq(uint8(_ticket(a).status), uint8(GameRegistry.TicketStatus.Ineligible), "swept at LER+4");
        assertEq(uint8(_ticket(b).status), uint8(GameRegistry.TicketStatus.Ineligible), "swept at LER+4");
    }

    function test_FirstGameStartDoesNotApplyStagedWindow() public {
        uint256 a = _submit(alice, STR_A);              // pre-start ticket, generation 1
        registry.setRefundWindowRounds(12);             // staged: a ticket exists
        registry.onGameStarted();                       // first game keeps generation 1
        assertEq(registry.generation(), 1);
        assertEq(registry.refundWindowRounds(), 4, "gen-1 tickets keep their window");
        assertEq(registry.pendingRefundWindowRounds(), 12);
        assertEq(_ticket(a).forfeitRound, _ticket(a).lastEligibleRound + 4);
    }

    // ─── At a fresh generation: the staged window takes over ─────────────────

    function test_NextGenerationAppliesAndSweepsOnTheNewWindow() public {
        registry.onGameStarted();
        uint256 old = _submit(alice, STR_A);            // gen 1, minted under 4
        _activate(2, alice, address(0));
        registry.setRefundWindowRounds(12);

        registry.onGameStarted();                       // gen 2: staged value applies
        assertEq(registry.generation(), 2);
        assertEq(registry.refundWindowRounds(), 12);
        assertEq(registry.pendingRefundWindowRounds(), 0);

        // The gen-1 ticket is untouched and reclaimable as before.
        assertEq(_ticket(old).forfeitRound, _ticket(old).lastEligibleRound + 4);
        vm.prank(alice);
        registry.reclaimFromPastGame(old);
        assertEq(uint8(_ticket(old).status), uint8(GameRegistry.TicketStatus.Closed));

        uint256 a = _submit(alice, STR_A);              // gen 2, plays round 2
        uint256 b = _submit(bob, STR_B);
        assertEq(_ticket(a).forfeitRound, 2 + 12);
        _activate(2, alice, bob);
        for (uint256 r = 2; r <= 13; r++) _settle(r);   // through LER + 11
        assertEq(uint8(_ticket(b).status), uint8(GameRegistry.TicketStatus.Active), "not due before LER+12");

        // Alice refunds on the last refundable round.
        registry.setCurrentRound(14);
        uint256 before = alice.balance;
        vm.prank(alice);
        registry.claimRefund(a);
        assertEq(alice.balance, before + ENTRY_ETH, "refundable through LER+12");

        // Bob, who never claimed, lapses when round 14 settles.
        _settle(14);
        assertEq(uint8(_ticket(b).status), uint8(GameRegistry.TicketStatus.Ineligible), "swept at LER+12");
    }

    function test_RecordWinnersUsesTheGenerationWindow() public {
        registry.onGameStarted();
        registry.setRefundWindowRounds(12);
        uint256 a = _submit(alice, STR_A);              // plays round 2, LER 2
        _activate(2, alice, address(0));
        address[] memory w = new address[](1);
        w[0] = alice;
        registry.recordWinners(2, w);
        assertEq(_ticket(a).forfeitRound, 2 + 2 + 12, "claim window then the full refund window");
    }

    function test_StagedValueCanBeReplacedBeforeTheBump() public {
        registry.onGameStarted();
        _submit(alice, STR_A);
        registry.setRefundWindowRounds(12);
        registry.setRefundWindowRounds(8);
        registry.onGameStarted();
        assertEq(registry.refundWindowRounds(), 8, "last staged value wins");
    }
}
