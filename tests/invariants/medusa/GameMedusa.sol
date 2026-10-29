// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import {GameInvariants, GameHandler} from "../GameInvariants.t.sol";

/**
 * Medusa harness for the game invariants. It builds the forge suite, forwards
 * every handler action, and exposes each `invariant_*` check as a property, so
 * a second, coverage-guided engine drives the same handler and checks.
 *
 * Run: medusa fuzz --config tests/invariants/medusa/medusa.game.json
 */
contract GameMedusa {
    GameInvariants inv;
    GameHandler h;

    constructor() {
        inv = new GameInvariants();
        inv.setUp();
        h = inv.h();
    }

    function submit(uint256 a, uint256 s, uint256 e) external { h.submit(a, s, e); }
    function submitWinner(uint256 a) external { h.submitWinner(a); }
    function replace(uint256 a, uint256 s) external { h.replace(a, s); }
    function cancel(uint256 a) external { h.cancel(a); }
    function refund(uint256 a) external { h.refund(a); }
    function claimWin(uint256 x) external { h.claimWin(x); }
    function recycle(uint256 back) external { h.recycle(back); }
    function addToPot(uint256 a, uint256 amount) external { h.addToPot(a, amount); }
    function fundPot(uint256 amount) external { h.fundPot(amount); }
    function withdrawCut() external { h.withdrawCut(); }
    function settle(uint256 n) external { h.settle(n); }

    function property_RegistryHoldsAllEthPrincipal() external view returns (bool) {
        try inv.invariant_RegistryHoldsAllEthPrincipal() { return true; } catch { return false; }
    }
    function property_EscrowBacksPrizeBooks() external view returns (bool) {
        try inv.invariant_EscrowBacksPrizeBooks() { return true; } catch { return false; }
    }
    function property_TerminalTicketsHoldNothing() external view returns (bool) {
        try inv.invariant_TerminalTicketsHoldNothing() { return true; } catch { return false; }
    }
    function property_ActiveSlotIsOwnLiveTicket() external view returns (bool) {
        try inv.invariant_ActiveSlotIsOwnLiveTicket() { return true; } catch { return false; }
    }
    function property_EthConserved() external view returns (bool) {
        try inv.invariant_EthConserved() { return true; } catch { return false; }
    }
}
