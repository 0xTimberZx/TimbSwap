// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import {PrizeWindowsTest} from "./PrizeWindows.t.sol";

/**
 * @title Settlement counts matching Pending tickets (TS-008)
 * @notice If the keeper has not activated a round's entrants, a matching
 *         ticket is still Pending at settlement. Activating only one's own
 *         ticket must not exclude the other matching winners.
 * @dev    Reuses the PrizeWindows fixture (deterministic VRF words, so a
 *         round's winning string is known in advance). Its inherited tests
 *         run here too.
 */
contract SettlementPendingWinnersTest is PrizeWindowsTest {
    address attacker = address(0xA77AC);

    /// @dev Settle one segment like settleOne(), but on a rollover run only
    ///      the expiry drain, NOT activation: a keeper that failed to activate.
    function _settleNoActivation() internal {
        uint256 before = prize.currentRound();
        uint256 seg    = prize.currentSegment();
        vm.warp(prize.segmentStartTime() + prize.INTERACTION_WINDOW() + 1);
        prize.settleSegment();
        (uint256 reqId, , , bool ready) = entropy.draws(prize.saltFor(before, seg));
        if (!ready) coord.fulfil(address(entropy), reqId, _wordFor(before, seg));
        prize.settleSegment();
        if (prize.currentRound() > before) registry.onRoundSettled(before, 0);
    }

    function test_SelectiveActivation_DoesNotExcludePendingWinner() public {
        uint256 T = findWinnableRound(prize.currentRound() + 2);
        runUntilRound(T - 1);
        bytes6 s = expectedString(T);

        vm.deal(attacker, 1 ether);
        vm.prank(player);   registry.submitEntry{value: ENTRY_ETH}(s, true, 0);
        vm.prank(attacker); registry.submitEntry{value: ENTRY_ETH}(s, true, 0);
        prize.fundPot{value: 1 ether}();

        // Roll into round T without the keeper activating anyone.
        while (prize.currentRound() < T) _settleNoActivation();

        // The attacker activates only their own ticket; the player's stays Pending.
        address[] memory only = new address[](1);
        only[0] = attacker;
        registry.activateRoundEntries(T, only);

        while (prize.currentRound() < T + 1) _settleNoActivation();

        (, , address[] memory w, ,) = prize.getRoundResult(T);
        assertEq(w.length, 2, "both matching tickets win");

        uint256 pBefore = player.balance;
        uint256 aBefore = attacker.balance;
        vm.prank(player);   prize.claimWinnings(T);
        vm.prank(attacker); prize.claimWinnings(T);
        uint256 pGot = player.balance - pBefore;
        uint256 aGot = attacker.balance - aBefore;
        assertGt(pGot, 0, "Pending winner is paid");
        assertEq(pGot, aGot, "equal shares, no windfall for selective activation");
    }

    function test_PendingTicket_NotYetPlaying_IsNotValid() public {
        // A ticket submitted now plays next round: not valid for the current one.
        uint256 R = prize.currentRound();
        vm.prank(player);
        registry.submitEntry{value: ENTRY_ETH}(bytes6("ABCDEF"), true, 0);
        (bool valid, ) = registry.verifyEntryValid(player, R);
        assertFalse(valid, "not live before its play round");
        (valid, ) = registry.verifyEntryValid(player, R + 1);
        assertTrue(valid, "Pending ticket is live once its play round arrives");
    }
}
