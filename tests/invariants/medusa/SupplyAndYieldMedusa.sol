// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import {SupplyAndYieldInvariants, TimbsHandler, VaultHandler} from "../SupplyAndYieldInvariants.t.sol";

/**
 * Medusa harness for the TIMBS supply and yield-vault invariants: forwards
 * every action of both handlers and exposes each `invariant_*` check as a
 * property.
 *
 * Run: medusa fuzz --config tests/invariants/medusa/medusa.supply.json
 */
contract SupplyAndYieldMedusa {
    SupplyAndYieldInvariants inv;
    TimbsHandler th;
    VaultHandler vh;

    constructor() {
        inv = new SupplyAndYieldInvariants();
        inv.setUp();
        th = inv.th();
        vh = inv.vh();
    }

    function mint(uint256 who, uint256 to, uint256 amount) external { th.mint(who, to, amount); }
    function outsiderMint(uint256 s, uint256 amount) external { th.outsiderMint(s, amount); }
    function burn(uint256 s, uint256 frac) external { th.burn(s, frac); }
    function treasuryBurn(uint256 amount) external { th.treasuryBurn(amount); }
    function distribute(uint256 s, uint256 amount) external { th.distribute(s, amount); }
    function transfer(uint256 f, uint256 t, uint256 frac) external { th.transfer(f, t, frac); }
    function rotatePool(uint256 s, bool staking) external { th.rotatePool(s, staking); }
    function setCap(uint256 cap) external { th.setCap(cap); }
    function togglePause(bool on) external { th.togglePause(on); }

    function register(uint256 id, uint256 amount) external { vh.register(id, amount); }
    function remove(uint256 id) external { vh.remove(id); }
    function fund(uint256 amount) external { vh.fund(amount); }
    function warp(uint256 secs) external { vh.warp(secs); }
    function harvest() external { vh.harvest(); }
    function setApr(uint256 bps) external { vh.setApr(bps); }
    function newEpoch() external { vh.newEpoch(); }
    function emergencyWithdraw(uint256 amount) external { vh.emergencyWithdraw(amount); }
    function overWithdraw(uint256 extra) external { vh.overWithdraw(extra); }

    function property_SupplyNeverExceedsHardCap() external view returns (bool) {
        try inv.invariant_SupplyNeverExceedsHardCap() { return true; } catch { return false; }
    }
    function property_SupplyMatchesMintsAndBurns() external view returns (bool) {
        try inv.invariant_SupplyMatchesMintsAndBurns() { return true; } catch { return false; }
    }
    function property_OnlyMintersMint() external view returns (bool) {
        try inv.invariant_OnlyMintersMint() { return true; } catch { return false; }
    }
    function property_BalancesSumToSupply() external view returns (bool) {
        try inv.invariant_BalancesSumToSupply() { return true; } catch { return false; }
    }
    function property_AccruedBackedByBalance() external view returns (bool) {
        try inv.invariant_AccruedBackedByBalance() { return true; } catch { return false; }
    }
    function property_WeightBookMatches() external view returns (bool) {
        try inv.invariant_WeightBookMatches() { return true; } catch { return false; }
    }
    function property_PaidOutNeverExceedsFunded() external view returns (bool) {
        try inv.invariant_PaidOutNeverExceedsFunded() { return true; } catch { return false; }
    }
    function property_VaultEthConserved() external view returns (bool) {
        try inv.invariant_VaultEthConserved() { return true; } catch { return false; }
    }
}
