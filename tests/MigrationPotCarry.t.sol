// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {PrizeEscrow} from "../contracts/PrizeEscrow.sol";
import {TimbPrize} from "../contracts/TimbPrize.sol";
import {PotCarry} from "../scripts/PotCarry.sol";

/// Owns the escrow and both prizes, as the migration broadcaster does, and runs
/// the scripts' own `_carryPot`.
contract CarryHarness is PotCarry {
    PrizeEscrow public escrow;
    TimbPrize   public oldPrize;
    TimbPrize   public newPrize;

    constructor() {
        escrow   = new PrizeEscrow();
        oldPrize = new TimbPrize(address(escrow), address(0xBEEF), address(0xCAFE));
        escrow.setTimbPrize(address(oldPrize));
        newPrize = new TimbPrize(address(escrow), address(0xBEEF), address(0xCAFE));
    }

    /// The scripts' migration steps: retire the outgoing prize, repoint the escrow.
    function migrate() external {
        oldPrize.retire();
        escrow.setTimbPrize(address(newPrize));
    }

    function carry() external returns (uint256) {
        return _carryPot(address(oldPrize), address(escrow), newPrize, address(this));
    }

    receive() external payable {}
}

/**
 * TS-067 — a migration carries the outgoing live pot into the new prize.
 *
 * Retiring the old prize and repointing the escrow left the live pot's ETH in
 * PrizeEscrow while the new prize started at currentAccumulatedRewards = 0, so
 * it was owed to no one. DeployGen3Migration and DeployPrizeVRFMigration now
 * call PotCarry._carryPot after the repoint.
 *
 * Run: forge test --match-contract MigrationPotCarryTest -vvv
 */
contract MigrationPotCarryTest is Test {
    CarryHarness h;
    uint256 constant POT   = 1 ether;
    uint256 constant OWED  = 0.3 ether; // settled winnings still to be claimed

    function setUp() public {
        h = new CarryHarness();
        h.oldPrize().addToPot{value: POT}();
        // Winnings already allocated to the outgoing game's winners sit in the
        // escrow outside currentAccumulatedRewards.
        vm.deal(address(h.escrow()), POT + OWED);
    }

    /// The reported state, before the carry: the pot is in the escrow and the
    /// new game does not count it.
    function test_TS067_RepointAloneOrphansThePot() public {
        h.migrate();
        assertEq(h.newPrize().currentAccumulatedRewards(), 0);
        assertEq(address(h.escrow()).balance, POT + OWED);
    }

    function test_TS067_CarryMovesThePotAndKeepsOwedWinnings() public {
        h.migrate();
        assertEq(h.carry(), POT);
        assertEq(h.newPrize().currentAccumulatedRewards(), POT, "new game counts the carried pot");
        assertEq(address(h.escrow()).balance, POT + OWED, "escrow still holds the owed winnings");
        assertEq(address(h).balance, 0, "nothing left with the broadcaster");
    }

    function test_TS067_CarryBeforeRepointReverts() public {
        vm.expectRevert(bytes("TS-067: repoint the escrow first"));
        h.carry();
    }

    function test_TS067_EmptyPotCarriesNothing() public {
        CarryHarness empty = new CarryHarness();
        empty.migrate();
        assertEq(empty.carry(), 0);
        assertEq(empty.newPrize().currentAccumulatedRewards(), 0);
    }
}
