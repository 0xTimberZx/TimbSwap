// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";

import "../contracts/PrizeEscrow.sol";
import "../contracts/GameRegistry.sol";
import "../contracts/TimbPrize.sol";
import "../contracts/VRFEntropy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Minimal TIMBS stand-in — the registry only needs transferFrom/transfer.
contract MockTIMBS is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") { _mint(msg.sender, 1_000_000e18); }
}

/// @dev Mock Chainlink VRF v2.5 coordinator (H1). Records the request and hands
///      back an incrementing id; the test drives fulfilment explicitly so the
///      per-segment word — and thus the winning string — is deterministic.
contract MockPrizeVRF is IVRFCoordinatorV2Plus {
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

/**
 * @title PrizeWindowsTest
 * @notice §14 claim/refund windows + §13.2 settlement jitter.
 *
 * Coverage:
 *   - Jitter: locked char equals the keccak mirror; winning string is built
 *     from locked chars, not counter % 36.
 *   - Prize claim: 2 rounds flat from the match (R+1, R+2 pass; R+3 reverts).
 *   - Principal refund: 4 rounds after lastEligibleRound for non-winners
 *     (LER+4 passes; sweep forfeits to the sink after; refund then reverts).
 *   - §14 (v5): a ticket that wins its LAST eligible round has its forfeiture
 *     pushed to LER+6 — the 4-round refund countdown starts after the 2-round
 *     claim window, not overlapping it. Refundable at LER+5 (past the old
 *     window); forfeited at LER+6.
 *   - Missed prize: recycleUnclaimed is permissionless once the window is
 *     over, reverts inside it, and never touches the winner's principal window.
 *
 * Determinism note (H1/VRF): the winning character no longer derives from
 * blockhash — it derives from a Chainlink VRF word (`keccak(word, salt)`).
 * These tests drive a MockPrizeVRF coordinator and fulfil each segment with a
 * fixed, salt-derived word (`_wordFor`), so the expected winning string of any
 * future round is still precomputable — which is how the winner fixtures
 * pre-commit a matching ticket. No swaps run, so every segment stays in the
 * letter class (seed 0 → locked index `mix % 26` (0-25) → next round's seed),
 * hence the exact char is `ALPHABET[mix % 26]`, independent of the counter.
 *
 * Run: forge test --match-contract PrizeWindowsTest -vvv
 */
contract PrizeWindowsTest is Test {
    bytes constant ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    MockTIMBS    timbs;
    PrizeEscrow  escrow;
    GameRegistry registry;
    TimbPrize    prize;
    MockPrizeVRF coord;
    VRFEntropy   entropy;

    address sink   = address(0xBEEF);
    address player = address(0xA11CE);
    address rando  = address(0xF00D);

    // v5 dynamic pricing: ETH entries sit on the floor here (escrow never nears
    // the 1.1 ETH threshold in these windows tests).
    uint256 constant ENTRY_ETH = 0.001 ether; // ETH_ENTRY_FLOOR

    function setUp() public {
        timbs    = new MockTIMBS();
        escrow   = new PrizeEscrow();
        registry = new GameRegistry(address(timbs), sink, address(0));
        prize    = new TimbPrize(address(escrow), address(registry), address(this));

        // H1: wire a dedicated VRFEntropy for the prize game (mirrors the board).
        coord   = new MockPrizeVRF();
        entropy = new VRFEntropy(
            address(coord),
            bytes32(uint256(0xABC)), // key hash
            42,                      // subscription id
            3,                       // confirmations
            200_000,                 // callback gas
            hex"1234"                // extraArgs blob
        );
        entropy.setBoard(address(prize));   // only TimbPrize may request
        prize.setEntropy(address(entropy)); // must be set before startGame (EntropyNotSet)

        registry.setTimbPrize(address(prize));
        // Entry costs are dynamic in v5 — no setter.
        escrow.setTimbPrize(address(prize));

        prize.startGame();

        vm.deal(player, 1 ether);
        vm.deal(rando, 1 ether);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// @dev The VRF word this test fulfils (round, segment) with — a fixed
    ///      function of the salt, so a future round's outcome is precomputable.
    function _wordFor(uint256 round, uint256 segment) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked("PRIZE_VRF_WORD", round, segment)));
    }

    /// @dev Mirror of TimbPrize._lockCurrentSegment under VRF (H1). `entropyFor`
    ///      returns `keccak(word, salt)`; the live char stays in the letter class
    ///      throughout (see Determinism note), so the locked char is
    ///      ALPHABET[mix % 26]. The counter no longer feeds the mix — it only
    ///      selects the class, which is letter every round with no swaps.
    function expectedChar(uint256 round, uint256 segment) internal view returns (bytes1) {
        bytes32 salt = prize.saltFor(round, segment);
        uint256 mix  = uint256(keccak256(abi.encodePacked(_wordFor(round, segment), salt)));
        return ALPHABET[mix % 26];
    }

    function expectedString(uint256 round) internal view returns (bytes6) {
        bytes memory s = new bytes(6);
        for (uint256 i = 1; i <= 6; i++) s[i - 1] = expectedChar(round, i);
        return bytes6(s);
    }

    function hasRepeats(bytes6 s) internal pure returns (bool) {
        for (uint256 i = 0; i < 6; i++) {
            for (uint256 j = i + 1; j < 6; j++) {
                if (s[i] == s[j]) return true;
            }
        }
        return false;
    }

    /// @dev Settle exactly one segment (or roll the round on segment 6).
    ///      H1: settlement is now arm → VRF callback → lock. First settleSegment
    ///      arms (fires the request); we fulfil it via the mock coordinator with
    ///      the segment's fixed word; the second settleSegment locks + advances.
    function settleOne() internal {
        uint256 before = prize.currentRound();
        uint256 seg    = prize.currentSegment();
        vm.warp(prize.segmentStartTime() + prize.INTERACTION_WINDOW() + 1);

        prize.settleSegment();                        // arm
        bytes32 salt = prize.saltFor(before, seg);
        (uint256 reqId, , , bool ready) = entropy.draws(salt);
        if (!ready) coord.fulfil(address(entropy), reqId, _wordFor(before, seg));
        prize.settleSegment();                        // lock + advance / settle round

        uint256 nowR = prize.currentRound();
        if (nowR > before) {
            // H2: settleSegment advances the round O(1) and no longer runs
            // expiry/forfeiture/activation inline — reproduce what the keeper
            // (settler.js) does after each rollover.
            registry.onRoundSettled(before, 0);                                   // settled round: expiry + forfeiture (0 = do all)
            registry.activateRoundEntries(nowR, registry.getRoundEntrants(nowR)); // new round: activate its entrants
        }
    }

    /// @dev Run full rounds until currentRound == target.
    function runUntilRound(uint256 target) internal {
        while (prize.currentRound() < target) settleOne();
    }

    /// @dev First future round (≥ min) whose expected string has no repeats —
    ///      submitEntry enforces no-repeat tickets, so only such rounds are
    ///      winnable by a pre-committed exact match.
    function findWinnableRound(uint256 min) internal view returns (uint256) {
        for (uint256 r = min; r < min + 64; r++) {
            if (!hasRepeats(expectedString(r))) return r;
        }
        revert("no winnable round in range");
    }

    /// @dev Pre-commit a matching ticket for round T and run T to settlement.
    ///      Returns T. Player's ticket: playRound = lastEligibleRound = T.
    function makeWinner() internal returns (uint256 T) {
        T = findWinnableRound(prize.currentRound() + 2);
        runUntilRound(T - 1);                       // entry during T-1 plays T
        vm.startPrank(player);
        registry.submitEntry{value: ENTRY_ETH}(expectedString(T), true, 0);
        vm.stopPrank();
        prize.fundPot{value: 1 ether}();            // a claimable pot must exist
        runUntilRound(T + 1);                       // round T fully settled
        assertEq(prize.roundWinningString(T), expectedString(T), "fixture: string mismatch");
        (, , address[] memory w, ,) = prize.getRoundResult(T);
        assertEq(w.length, 1, "fixture: expected exactly one winner");
        assertEq(w[0], player, "fixture: wrong winner");
    }

    // ─── §13.2 Jitter ────────────────────────────────────────────────────────

    function test_LockedCharMatchesKeccakMirror() public {
        uint256 round = prize.currentRound();
        bytes1 expect = expectedChar(round, 1);
        settleOne();
        assertEq(prize.segmentLockedChar(1), expect, "locked char != keccak mirror");
        assertTrue(prize.segmentDigitLocked(1), "segment not locked");
    }

    function test_WinningStringBuiltFromLockedChars() public {
        uint256 round = prize.currentRound();
        bytes6 expect = expectedString(round);
        runUntilRound(round + 1);
        assertEq(prize.roundWinningString(round), expect, "winning string != locked chars");
    }

    // ─── §14 Prize claim: 2 rounds flat ─────────────────────────────────────

    function test_ClaimSucceedsWithinTwoRounds() public {
        uint256 T = makeWinner();                   // currentRound == T+1
        runUntilRound(T + 2);                       // last allowed round
        uint256 balBefore = player.balance;
        vm.startPrank(player);
        prize.claimWinnings(T);
        vm.stopPrank();
        assertGt(player.balance, balBefore, "no payout received");
    }

    function test_ClaimRevertsAfterTwoRounds() public {
        uint256 T = makeWinner();
        runUntilRound(T + 3);                       // window over
        vm.startPrank(player);
        vm.expectRevert();
        prize.claimWinnings(T);
        vm.stopPrank();
    }

    // ─── §14 Principal refund: 4 rounds ─────────────────────────────────────

    function test_RefundSucceedsAtWindowEdge() public {
        runUntilRound(2);
        uint256 id;
        vm.startPrank(player);
        registry.submitEntry{value: ENTRY_ETH}(bytes6("AB12CD"), true, 0); // plays round 3
        id = registry.activeTicketOf(player);
        vm.stopPrank();
        uint256 ler = 3;
        runUntilRound(ler + 4);                     // currentRound == LER+4: still refundable
        uint256 balBefore = player.balance;
        vm.startPrank(player);
        registry.claimRefund(id);
        vm.stopPrank();
        assertEq(player.balance, balBefore + ENTRY_ETH, "principal not refunded");
    }

    function test_ForfeitedAfterFourRounds() public {
        runUntilRound(2);
        uint256 id;
        vm.startPrank(player);
        registry.submitEntry{value: ENTRY_ETH}(bytes6("AB12CD"), true, 0); // plays round 3
        id = registry.activeTicketOf(player);
        vm.stopPrank();
        uint256 ler = 3;
        uint256 sinkBefore = sink.balance;
        runUntilRound(ler + 5);                     // settling LER+4 sweeps the lapse
        assertEq(sink.balance, sinkBefore + ENTRY_ETH, "escrow not forfeited to sink");
        vm.startPrank(player);
        vm.expectRevert();
        registry.claimRefund(id);
        vm.stopPrank();
    }

    // ─── §14 Missed prize ≠ lost principal ───────────────────────────────────

    function test_RecycleRevertsInsideWindow() public {
        uint256 T = makeWinner();                   // currentRound == T+1
        runUntilRound(T + 2);                       // still claimable
        vm.startPrank(rando);
        vm.expectRevert();
        prize.recycleUnclaimed(T);
        vm.stopPrank();
    }

    function test_MissedPrizeRecyclesPermissionlessly_PrincipalSurvives() public {
        uint256 T = makeWinner();
        runUntilRound(T + 3);                       // prize window over, never claimed
        uint256 potBefore = prize.currentAccumulatedRewards();
        vm.startPrank(rando);                       // anyone may sweep
        prize.recycleUnclaimed(T);
        vm.stopPrank();
        assertGe(prize.currentAccumulatedRewards(), potBefore, "pot did not absorb recycle");
        vm.startPrank(player);
        vm.expectRevert();
        prize.claimWinnings(T);                     // prize is gone for good
        vm.stopPrank();

        // …but the principal window is still open. This ticket won its last
        // eligible round (T == LER), so §14 pushes its forfeiture to LER+6.
        runUntilRound(T + 4);
        uint256 id = registry.activeTicketOf(player) != 0
            ? registry.activeTicketOf(player)
            : registry.ticketAt(registry.generation(), player, T);
        uint256 balBefore = player.balance;
        vm.startPrank(player);
        registry.claimRefund(id);
        vm.stopPrank();
        assertEq(player.balance, balBefore + ENTRY_ETH, "expired winner lost principal");
    }

    // ─── §14 (v5): winning the last eligible round pushes forfeiture to LER+6 ──

    function _ticketId(uint256 round) internal view returns (uint256) {
        uint256 id = registry.activeTicketOf(player);
        return id != 0 ? id : registry.ticketAt(registry.generation(), player, round);
    }

    function test_WinnerLastRound_ForfeitRoundIsLERPlus6() public {
        uint256 T = makeWinner();                    // ticket plays & wins round T; LER == T
        (GameRegistry.Ticket memory t,) = registry.getTicket(_ticketId(T));
        assertEq(t.forfeitRound, T + 6, "last-round winner should forfeit at LER+6");
    }

    function test_WinnerLastRound_RefundableInExtendedWindow() public {
        uint256 T = makeWinner();
        // T+5 is PAST the old flat LER+4 window — under v5 it must still refund
        // because the claim right (T+1..T+2) delayed the forfeiture countdown.
        runUntilRound(T + 5);
        // Resolve the id BEFORE the prank — _ticketId makes an external ticketAt
        // staticcall, which would otherwise consume the prank and leave claimRefund
        // running as the test contract (NotTicketOwner).
        uint256 id = _ticketId(T);
        uint256 balBefore = player.balance;
        vm.startPrank(player);
        registry.claimRefund(id);
        vm.stopPrank();
        assertEq(player.balance, balBefore + ENTRY_ETH, "extended refund window not honored");
    }

    function test_WinnerLastRound_ForfeitedAtLERPlus6() public {
        uint256 T = makeWinner();
        uint256 id = _ticketId(T);
        uint256 sinkBefore = sink.balance;
        runUntilRound(T + 7);                        // settling T+6 sweeps the lapse
        assertEq(sink.balance, sinkBefore + ENTRY_ETH, "escrow not forfeited at LER+6");
        vm.startPrank(player);
        vm.expectRevert();
        registry.claimRefund(id);                    // window truly closed now
        vm.stopPrank();
    }
}
