// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../contracts/GameRegistry.sol";

// Minimal mintable TIMBS for escrow.
contract MockTIMBS is ERC20 {
    constructor() ERC20("TIMBS", "TIMBS") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/**
 * @title GameRegistry v5 — dynamic entry pricing tests
 * @notice Exercises the per-round-fixed, both-ways-floating entry costs and the
 *         pricing-meter invariants:
 *           ETH   = escrow <= 1.1 ETH ? 0.001 ETH : escrow / 1000
 *           TIMBS = 2 + activeTimbEntries, re-fixed only outside a +/-2 deadband
 *         plus seat conservation (+1 at submit, -1 at exactly one terminal exit;
 *         concession net-neutral; expiry not terminal) and generation resets.
 *
 * The test contract is set as `timbPrize`, so it can drive the round lifecycle
 * (setCurrentRound / activateRoundEntries / onRoundSettled / onGameStarted).
 * yieldVault is left unset (address(0)) so the vault hooks are inert.
 */
contract GameRegistryDynamicPricingTest is Test {
    MockTIMBS timbs;
    GameRegistry reg;

    address constant SINK = address(0xFEE);

    bytes6 constant S1 = bytes6("ABC123");
    bytes6 constant S2 = bytes6("DEF456");

    uint256 constant ETH_FLOOR = 0.001 ether; // ETH_ENTRY_FLOOR
    uint256 constant TIMBS_FLOOR = 2e18;       // TIMBS_ENTRY_FLOOR

    function setUp() public {
        timbs = new MockTIMBS();
        reg = new GameRegistry(address(timbs), SINK, address(this));
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

    function _fundTimbs(address who) internal {
        timbs.mint(who, 1_000_000e18);
        vm.prank(who);
        timbs.approve(address(reg), type(uint256).max);
    }

    function _timbsEntry(address who, bytes6 s) internal {
        _fundTimbs(who);
        vm.prank(who);
        reg.submitEntry(s, false, 0);
    }

    function _ethEntry(address who, bytes6 s) internal {
        vm.deal(who, 1 ether);
        vm.prank(who);
        reg.submitEntry{value: ETH_FLOOR}(s, true, 0);
    }

    function _one(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    // ─── TIMBS pricing ─────────────────────────────────────────────────────────

    function test_TimbsFloor_FirstEntryIsTwo() public {
        // Quoted before any entry: the floor.
        assertEq(reg.entryCostTIMBS(), TIMBS_FLOOR, "quote floor");

        _timbsEntry(address(0xA1), S1);

        assertEq(reg.activeTimbEntries(), 1, "meter +1");
        assertEq(reg.fixedTimbsCost(), TIMBS_FLOOR, "fixed at floor");
        assertEq(reg.pricedForRound(), 1, "priced for playRound 1");
        assertEq(reg.entryCostTIMBS(), TIMBS_FLOOR, "locked for the round");
        assertEq(timbs.balanceOf(address(reg)), TIMBS_FLOOR, "escrow held");
    }

    // Count drifts by 1 across a round → within the +/-2 deadband → price holds.
    function test_TimbsDeadband_Holds() public {
        _timbsEntry(address(0xA1), S1);       // active 1, fixed 2, ref 0
        assertEq(reg.timbsPriceRefCount(), 0);

        reg.setCurrentRound(1);
        (, uint256 timbsNext) = reg.nextRoundPrices();
        assertEq(timbsNext, TIMBS_FLOOR, "held (drift 1 < 2)");

        _timbsEntry(address(0xA2), S1);
        assertEq(reg.fixedTimbsCost(), TIMBS_FLOOR, "still 2");
        assertEq(reg.timbsPriceRefCount(), 0, "ref unchanged");
        assertEq(reg.activeTimbEntries(), 2);
    }

    // Count drifts by >=2 → deadband breached → price steps to 2 + active.
    function test_TimbsDeadband_Steps() public {
        _timbsEntry(address(0xA1), S1);
        _timbsEntry(address(0xA2), S1);
        _timbsEntry(address(0xA3), S1);       // active 3, fixed 2 (locked round 1), ref 0
        assertEq(reg.activeTimbEntries(), 3);
        assertEq(reg.fixedTimbsCost(), TIMBS_FLOOR);

        reg.setCurrentRound(1);
        (, uint256 timbsNext) = reg.nextRoundPrices();
        assertEq(timbsNext, 5e18, "stepped: 2 + 3");

        _timbsEntry(address(0xA4), S1);
        assertEq(reg.fixedTimbsCost(), 5e18, "re-fixed");
        assertEq(reg.timbsPriceRefCount(), 3, "ref = active at fix");
        assertEq(reg.activeTimbEntries(), 4);
    }

    // ─── ETH pricing ─────────────────────────────────────────────────────────

    function test_EthFloor_UnderThreshold() public {
        assertEq(reg.entryCostETH(), ETH_FLOOR, "quote floor");

        _ethEntry(address(0xB1), S1);
        assertEq(reg.totalEthEscrow(), ETH_FLOOR, "escrow += cost");
        assertEq(reg.fixedEthCost(), ETH_FLOOR, "fixed at floor");

        reg.setCurrentRound(1);
        (uint256 ethNext,) = reg.nextRoundPrices();
        assertEq(ethNext, ETH_FLOOR, "still floor under 1.1 ETH");
    }

    // Push escrow above the 1.1 ETH threshold (all pay the round's locked floor),
    // then the next round re-prices to escrow / 1000.
    function test_EthScales_AboveThreshold() public {
        uint256 n = 1101; // 1101 * 0.001 = 1.101 ETH > 1.1 ETH
        for (uint256 i = 0; i < n; i++) {
            _ethEntry(address(uint160(0xC0000 + i)), S1);
        }
        uint256 escrow = n * ETH_FLOOR;
        assertEq(reg.totalEthEscrow(), escrow, "escrow summed");
        assertEq(reg.fixedEthCost(), ETH_FLOOR, "round 0 stayed on the floor (locked)");

        reg.setCurrentRound(1);
        (uint256 ethNext,) = reg.nextRoundPrices();
        assertEq(ethNext, escrow / 1000, "re-priced: escrow / 1000");
        assertGt(ethNext, ETH_FLOOR, "scaled above the floor");
    }

    // ─── Seat conservation ─────────────────────────────────────────────────────

    function test_Seat_TimbsCancelDecrements() public {
        _timbsEntry(address(0xA1), S1);
        assertEq(reg.activeTimbEntries(), 1);
        vm.prank(address(0xA1));
        reg.cancelEntry();
        assertEq(reg.activeTimbEntries(), 0, "cancel releases the seat");
    }

    function test_Seat_EthCancelDecrements() public {
        _ethEntry(address(0xB1), S1);
        assertEq(reg.totalEthEscrow(), ETH_FLOOR);
        vm.prank(address(0xB1));
        reg.cancelEntry();
        assertEq(reg.totalEthEscrow(), 0, "cancel releases the ETH escrow");
    }

    // Replace concedes the senior ticket and carries its seat to the replacement
    // → the meter must not move; the replacement's own exit releases it once.
    function test_Seat_ConcessionNetNeutral() public {
        _fundTimbs(address(0xA1));
        vm.prank(address(0xA1));
        reg.submitEntry(S1, false, 0);
        assertEq(reg.activeTimbEntries(), 1);

        vm.prank(address(0xA1));
        reg.replaceEntry(S2, 0);
        assertEq(reg.activeTimbEntries(), 1, "concession is net-neutral");

        vm.prank(address(0xA1));
        reg.cancelEntry();
        assertEq(reg.activeTimbEntries(), 0, "replacement exit releases once");
    }

    // Refund is a terminal exit → releases. Expiry (onRoundSettled) is NOT, so the
    // seat is still counted through the refund window until refund/forfeit.
    function test_Seat_RefundDecrements_ExpiryDoesNot() public {
        _fundTimbs(address(0xA1));
        vm.prank(address(0xA1));
        reg.submitEntry(S1, false, 0); // ticket id 1, LER 1, forfeit at 5

        reg.setCurrentRound(1);
        reg.activateRoundEntries(1, _one(address(0xA1)));

        reg.setCurrentRound(2);
        reg.onRoundSettled(1, 0); // H2: paginated (0 = do all); expiry — NOT terminal
        assertEq(reg.activeTimbEntries(), 1, "expiry keeps the seat counted");

        vm.prank(address(0xA1));
        reg.claimRefund(1);
        assertEq(reg.activeTimbEntries(), 0, "refund releases the seat");
    }

    // Forfeit (unclaimed past the window) is the other terminal exit → releases.
    function test_Seat_ForfeitDecrements() public {
        _fundTimbs(address(0xA1));
        vm.prank(address(0xA1));
        reg.submitEntry(S1, false, 0); // LER 1, forfeit at 5

        reg.setCurrentRound(1);
        reg.activateRoundEntries(1, _one(address(0xA1)));

        reg.setCurrentRound(6); // H2: round 5 is "settled" once currentRound > 5
        reg.onRoundSettled(5, 0); // forfeitRound == 5 → Ineligible, escrow to sink
        assertEq(reg.activeTimbEntries(), 0, "forfeit releases the seat");
        assertEq(timbs.balanceOf(SINK), TIMBS_FLOOR, "escrow absorbed to sink");
    }

    // H2: onRoundSettled is paginated — the cursor resumes across chunked calls,
    // forfeits each entrant exactly once, and only flips settleDone when the whole
    // scan is consumed. This is the DoS fix: a large entrant set is drained in
    // bounded chunks instead of one settle-time loop that could OOG-freeze the game.
    function test_Paginated_ForfeitureResumesAcrossChunks() public {
        address[3] memory who = [address(0xA1), address(0xA2), address(0xA3)];
        for (uint256 i; i < 3; i++) _timbsEntry(who[i], S1); // each LER 1, forfeit at 5

        reg.setCurrentRound(1);
        for (uint256 i; i < 3; i++) reg.activateRoundEntries(1, _one(who[i]));
        assertEq(reg.activeTimbEntries(), 3, "3 seats");

        reg.setCurrentRound(6); // round 5 settled

        uint256 gen = reg.generation();

        assertFalse(reg.onRoundSettled(5, 1), "chunk 1 not done");
        assertFalse(reg.settleDone(gen, 5), "not marked done mid-scan");
        assertEq(reg.activeTimbEntries(), 2, "one forfeited");

        assertFalse(reg.onRoundSettled(5, 1), "chunk 2 not done");
        assertEq(reg.activeTimbEntries(), 1, "two forfeited");

        assertTrue(reg.onRoundSettled(5, 1), "final chunk completes");
        assertTrue(reg.settleDone(gen, 5), "marked done");
        assertEq(reg.activeTimbEntries(), 0, "all forfeited");
        assertGe(timbs.balanceOf(SINK), 3 * TIMBS_FLOOR, "all escrow to sink");

        // Idempotent once done — no double-processing.
        assertTrue(reg.onRoundSettled(5, 1), "done stays done");
        assertEq(reg.activeTimbEntries(), 0, "no double-processing");
    }

    // ─── Generation reset ─────────────────────────────────────────────────────

    function test_GenerationReset_ClearsMeters() public {
        _timbsEntry(address(0xA1), S1);
        _ethEntry(address(0xB1), S2);
        assertGt(reg.activeTimbEntries(), 0);
        assertGt(reg.totalEthEscrow(), 0);

        reg.onGameStarted();

        assertEq(reg.activeTimbEntries(), 0, "timb meter cleared");
        assertEq(reg.totalEthEscrow(), 0, "eth meter cleared");
        assertEq(reg.timbsPriceRefCount(), 0, "ref cleared");
        assertEq(reg.fixedTimbsCost(), 0, "timb price cleared");
        assertEq(reg.fixedEthCost(), 0, "eth price cleared");
        assertEq(reg.pricedForRound(), 0, "priced-round cleared");
    }

    // ─── View consistency ─────────────────────────────────────────────────────

    // nextRoundPrices() must equal what the next submit actually charges.
    function test_NextRoundPrices_MatchesCharge() public {
        _timbsEntry(address(0xA1), S1);
        _timbsEntry(address(0xA2), S1);
        _timbsEntry(address(0xA3), S1); // active 3
        reg.setCurrentRound(1);

        (, uint256 quotedTimbs) = reg.nextRoundPrices();

        address w = address(0xA9);
        _fundTimbs(w);
        uint256 before = timbs.balanceOf(w);
        vm.prank(w);
        reg.submitEntry(S1, false, 0);
        uint256 charged = before - timbs.balanceOf(w);

        assertEq(charged, quotedTimbs, "quote matches the charge");
        assertEq(reg.fixedTimbsCost(), quotedTimbs, "fixed == quote");
    }
}
