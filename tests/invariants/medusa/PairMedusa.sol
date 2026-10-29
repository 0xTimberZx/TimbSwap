// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import {PairInvariants, PairHandler} from "../PairInvariants.t.sol";

/**
 * Medusa harness for the pair invariants: forwards every handler action and
 * exposes each `invariant_*` check as a property.
 *
 * Run: medusa fuzz --config tests/invariants/medusa/medusa.pair.json
 */
contract PairMedusa {
    PairInvariants inv;
    PairHandler h;

    constructor() {
        inv = new PairInvariants();
        inv.setUp();
        h = inv.h();
    }

    function addLiquidity(uint256 a, uint256 x, uint256 y) external { h.addLiquidity(a, x, y); }
    function removeLiquidity(uint256 a, uint256 frac) external { h.removeLiquidity(a, frac); }
    function roundTrip(uint256 a, uint256 x, uint256 y) external { h.roundTrip(a, x, y); }
    function swap(uint256 a, bool zeroIn, uint256 amountIn) external { h.swap(a, zeroIn, amountIn); }
    function overQuoteSwap(uint256 a, bool zeroIn, uint256 amountIn) external { h.overQuoteSwap(a, zeroIn, amountIn); }
    function donate(uint256 a, bool tokenA, uint256 amt) external { h.donate(a, tokenA, amt); }
    function sync() external { h.sync(); }
    function skim() external { h.skim(); }
    function transferLp(uint256 f, uint256 t, uint256 frac) external { h.transferLp(f, t, frac); }

    function property_ReservesBackedByBalances() external view returns (bool) {
        try inv.invariant_ReservesBackedByBalances() { return true; } catch { return false; }
    }
    function property_LpSupplyFullyAccounted() external view returns (bool) {
        try inv.invariant_LpSupplyFullyAccounted() { return true; } catch { return false; }
    }
    function property_MinimumLiquidityLocked() external view returns (bool) {
        try inv.invariant_MinimumLiquidityLocked() { return true; } catch { return false; }
    }
    function property_TokensConserved() external view returns (bool) {
        try inv.invariant_TokensConserved() { return true; } catch { return false; }
    }
    function property_SwapNeverLowersK() external view returns (bool) {
        try inv.invariant_SwapNeverLowersK() { return true; } catch { return false; }
    }
    function property_NoSwapBeatsTheFee() external view returns (bool) {
        try inv.invariant_NoSwapBeatsTheFee() { return true; } catch { return false; }
    }
    function property_NoRoundTripProfit() external view returns (bool) {
        try inv.invariant_NoRoundTripProfit() { return true; } catch { return false; }
    }
    function property_ShareValueNeverDrops() external view returns (bool) {
        try inv.invariant_ShareValueNeverDrops() { return true; } catch { return false; }
    }
}
