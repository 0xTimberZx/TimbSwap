// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";

import "../contracts/GameRegistry.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Minimal TIMBS stand-in.
contract MockTimbsGen is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") { _mint(msg.sender, 1_000_000e18); }
}

/**
 * @title GameRegistryGenerationsTest
 * @notice Game-generation epochs (GameRegistry v4) — cross-game round-collision
 *         fix. This test contract plays the role of TimbPrize (it is the
 *         registry's `timbPrize`), so it can drive onGameStarted / round
 *         lifecycle directly without a full prize deploy.
 *
 * Coverage:
 *   - A generation bump retires a prior-game ticket: it stops being valid for a
 *     COLLIDING new round, and it stops blocking its wallet from entering.
 *   - reclaimFromPastGame returns principal (ETH + TIMBS) immediately.
 *   - reclaim reverts for a current-generation ticket and for terminal statuses.
 *   - The settlement forfeit sweep is generation-scoped: a gen-2 settle never
 *     touches a gen-1 ticket's escrow.
 *
 * Run: forge test --match-contract GameRegistryGenerationsTest -vvv
 */
contract GameRegistryGenerationsTest is Test {
    MockTimbsGen     timbs;
    GameRegistry  registry;

    address sink   = address(0xBEEF);
    address player = address(0xA11CE);

    // v5 dynamic pricing floors — this test does a single entry per generation,
    // so escrow stays on the floor (ETH < 1.1 ETH threshold, one TIMBS seat).
    uint256 constant ENTRY_ETH   = 0.001 ether; // ETH_ENTRY_FLOOR
    uint256 constant ENTRY_TIMBS = 2e18;         // TIMBS_ENTRY_FLOOR
    bytes6  constant STR_A = bytes6("ABCDEF");
    bytes6  constant STR_B = bytes6("GHIJKL");

    function setUp() public {
        timbs    = new MockTimbsGen();
        // This test contract is the timbPrize — lets us call onGameStarted etc.
        registry = new GameRegistry(address(timbs), sink, address(this), 2e18, 1e18);
        registry.setTimbsEntryEnabled(true); // TIMBS leg is off by default (ETH-only beta)
        // Entry costs are dynamic in v5 — no setter; they compute from live state.
        registry.onGameStarted();          // first game: generation stays 1, round 1

        vm.deal(player, 1 ether);
        timbs.transfer(player, 10_000e18);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _submitETH(address who, bytes6 s) internal returns (uint256 id) {
        vm.prank(who);
        registry.submitEntry{value: ENTRY_ETH}(s, true, 0);
        id = registry.activeTicketOf(who);
    }

    function _activate(address who, uint256 round) internal {
        registry.setCurrentRound(round);
        address[] memory ps = new address[](1);
        ps[0] = who;
        registry.activateRoundEntries(round, ps);
    }

    function _status(uint256 id) internal view returns (GameRegistry.TicketStatus) {
        (GameRegistry.Ticket memory t,) = registry.getTicket(id);
        return t.status;
    }

    // TS-025: isTicketLive is generation-aware; the stored status is not.
    function test_TS025_IsTicketLiveFollowsGeneration() public {
        uint256 id = _submitETH(player, STR_A);
        (GameRegistry.Ticket memory t,) = registry.getTicket(id);
        _activate(player, t.playRound);
        assertTrue(registry.isTicketLive(id), "live in its own generation");
        assertEq(uint8(_status(id)), uint8(GameRegistry.TicketStatus.Active));

        registry.onGameStarted();              // generation bump, no sweep
        assertFalse(registry.isTicketLive(id), "retired generation is not live");
        assertEq(uint8(_status(id)), uint8(GameRegistry.TicketStatus.Active), "stored status unchanged");
        assertEq(registry.activeTicketOf(player), id, "slot not cleared by the bump");
    }

    // TS-022: a ticket whose activation was missed frees the wallet once its
    // run ends, instead of blocking re-entry until the LER+4 forfeiture sweep.
    function test_TS022_EndedPendingTicketFreesWallet() public {
        uint256 id = _submitETH(player, STR_A);            // plays round 2, never activated
        (GameRegistry.Ticket memory t,) = registry.getTicket(id);
        assertEq(uint8(t.status), uint8(GameRegistry.TicketStatus.Pending));

        // Still inside its run: re-entry is refused.
        registry.setCurrentRound(t.lastEligibleRound);
        vm.prank(player);
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.ActiveTicketExists.selector, id));
        registry.submitEntry{value: ENTRY_ETH}(STR_B, true, 0);

        // Run over: the wallet can enter again straight away.
        registry.setCurrentRound(t.lastEligibleRound + 1);
        uint256 id2 = _submitETH(player, STR_B);
        assertTrue(id2 != id, "new ticket minted");
    }

    // ─── Tests ───────────────────────────────────────────────────────────────

    function test_FirstGameKeepsGenerationOne() public view {
        assertEq(registry.generation(), 1);
    }

    function test_GenerationBumpRetiresOldTicketAndFreesWallet() public {
        uint256 tid = _submitETH(player, STR_A);   // gen 1, playRound 2
        _activate(player, 2);                        // Active, eligible for round 2

        (bool okBefore,) = registry.verifyEntryValid(player, 2);
        assertTrue(okBefore, "gen-1 ticket valid at its round pre-bump");

        registry.onGameStarted();                    // generation -> 2, round 1
        assertEq(registry.generation(), 2);

        // The colliding round 2 of the NEW game must NOT see the old ticket.
        (bool okAfter,) = registry.verifyEntryValid(player, 2);
        assertFalse(okAfter, "gen-1 ticket must be inert at colliding gen-2 round");

        // Wallet is freed: it can enter the new game despite the stranded ticket.
        uint256 newId = _submitETH(player, STR_B);
        assertGt(newId, tid, "wallet can mint a fresh ticket in the new generation");
    }

    function test_ReclaimReturnsEthPrincipal() public {
        uint256 tid = _submitETH(player, STR_A);
        registry.onGameStarted();                    // gen -> 2, ticket now prior-gen

        uint256 balBefore = player.balance;
        vm.prank(player);
        registry.reclaimFromPastGame(tid);

        assertEq(player.balance, balBefore + ENTRY_ETH, "ETH principal returned");
        assertEq(uint8(_status(tid)), uint8(GameRegistry.TicketStatus.Closed));
    }

    function test_ReclaimReturnsTimbsPrincipal() public {
        vm.startPrank(player);
        timbs.approve(address(registry), ENTRY_TIMBS);
        registry.submitEntry(STR_A, false, 0);       // TIMBS escrow
        vm.stopPrank();
        uint256 tid = registry.activeTicketOf(player);

        registry.onGameStarted();                    // gen -> 2

        uint256 balBefore = timbs.balanceOf(player);
        vm.prank(player);
        registry.reclaimFromPastGame(tid);

        assertEq(timbs.balanceOf(player), balBefore + ENTRY_TIMBS, "TIMBS principal returned");
        assertEq(uint8(_status(tid)), uint8(GameRegistry.TicketStatus.Closed));
    }

    function test_ReclaimRevertsForCurrentGeneration() public {
        uint256 tid = _submitETH(player, STR_A);     // still current gen (1)
        vm.prank(player);
        vm.expectRevert(GameRegistry.TicketNotReclaimable.selector);
        registry.reclaimFromPastGame(tid);
    }

    function test_ReclaimRevertsForTerminalStatus() public {
        uint256 tid = _submitETH(player, STR_A);     // Pending, playRound 2 > round 1
        vm.prank(player);
        registry.cancelEntry();                       // -> Cancelled (terminal, refunded)

        registry.onGameStarted();                     // gen -> 2
        vm.prank(player);
        vm.expectRevert(
            abi.encodeWithSelector(
                GameRegistry.TicketNotRefundable.selector,
                GameRegistry.TicketStatus.Cancelled
            )
        );
        registry.reclaimFromPastGame(tid);
    }

    function test_ReclaimRevertsForNonOwner() public {
        uint256 tid = _submitETH(player, STR_A);
        registry.onGameStarted();
        vm.prank(address(0xD00D));
        vm.expectRevert(
            abi.encodeWithSelector(
                GameRegistry.NotTicketOwner.selector, tid, address(0xD00D)
            )
        );
        registry.reclaimFromPastGame(tid);
    }

    function test_ForfeitSweepIsGenerationScoped() public {
        uint256 tid = _submitETH(player, STR_A);      // gen 1, playRound 2, LER 2
        _activate(player, 2);                          // Active, escrow registered

        registry.onGameStarted();                      // gen -> 2, round 1

        // In gen 2, settle a round whose lapse sweep targets LER bucket 2
        // (settledRound - REFUND_WINDOW_ROUNDS = 6 - 4 = 2). If the sweep were
        // not generation-scoped it would forfeit the gen-1 ticket sitting in
        // roundEntrants[1][2]. It must remain untouched.
        registry.setCurrentRound(7); // H2: round 6 is "settled" once currentRound > 6
        registry.onRoundSettled(6, 0); // paginated (0 = do all)

        assertEq(uint8(_status(tid)), uint8(GameRegistry.TicketStatus.Active), "gen-1 ticket not swept");
        (GameRegistry.Ticket memory t,) = registry.getTicket(tid);
        assertEq(t.escrowAmount, ENTRY_ETH, "gen-1 escrow intact");

        // And it is still reclaimable by its owner.
        vm.prank(player);
        registry.reclaimFromPastGame(tid);
        assertEq(uint8(_status(tid)), uint8(GameRegistry.TicketStatus.Closed));
    }

    // ─── TS-043: an outgoing registry can be retired so its tickets reclaim ──

    function test_TS043_StrandedTicketReclaimsAfterRetire() public {
        uint256 id = _submitETH(player, STR_A);              // gen-1 ticket holding ETH
        uint256 before = player.balance;
        // No further onGameStarted ever reaches an abandoned registry.
        vm.prank(player);
        vm.expectRevert(GameRegistry.TicketNotReclaimable.selector);
        registry.reclaimFromPastGame(id);
        registry.retireGame();
        assertTrue(registry.retired(), "flag set");
        vm.prank(player);
        registry.reclaimFromPastGame(id);
        assertEq(player.balance, before + ENTRY_ETH, "principal returned in full");
    }

    function test_TS043_RetiredRegistryRefusesEntriesAndStart() public {
        registry.retireGame();
        uint256 gen = registry.generation();
        vm.prank(player);
        vm.expectRevert(GameRegistry.RegistryRetired.selector);
        registry.submitEntry{value: ENTRY_ETH}(STR_A, true, 0);
        vm.expectRevert(GameRegistry.RegistryRetired.selector);
        registry.onGameStarted();
        registry.retireGame();                               // idempotent
        assertEq(registry.generation(), gen, "second retire is a no-op");
    }

    function test_TS043_RetireIsOwnerOnly() public {
        vm.prank(player);
        vm.expectRevert();
        registry.retireGame();
    }
}
