// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {PrizeEscrow} from "../contracts/PrizeEscrow.sol";
import {TimbPrize} from "../contracts/TimbPrize.sol";
import {GameRegistry} from "../contracts/GameRegistry.sol";
import {VRFEntropy, IVRFCoordinatorV2Plus} from "../contracts/VRFEntropy.sol";
import {FreshEntropy} from "../scripts/FreshEntropy.sol";

contract FECoordinator is IVRFCoordinatorV2Plus {
    uint256 public nextId = 1;
    function requestRandomWords(RandomWordsRequest calldata) external returns (uint256) { return nextId++; }
}

/// Runs the migration scripts' own read-back.
contract FEChecker is FreshEntropy {
    function check(TimbPrize prize, VRFEntropy entropy) external view { _assertFreshEntropy(prize, entropy); }
}

/**
 * Migration scripts refuse a VRFEntropy module that has served another prize
 * (hardening from a declined bounty report, 2026-10-26).
 *
 * Run: forge test --match-contract MigrationFreshEntropyTest -vvv
 */
contract MigrationFreshEntropyTest is Test {
    FECoordinator coord;
    FEChecker     checker;
    PrizeEscrow   escrow;
    GameRegistry  reg;
    TimbPrize     oldPrize;
    TimbPrize     newPrize;

    function setUp() public {
        coord    = new FECoordinator();
        checker  = new FEChecker();
        escrow   = new PrizeEscrow();
        reg      = new GameRegistry(address(0x7173), address(0x51CC), address(0), 2e18, 1e18);
        oldPrize = new TimbPrize(address(escrow), address(reg), address(0xCAFE));
        newPrize = new TimbPrize(address(escrow), address(reg), address(0xCAFE));
    }

    function _module() internal returns (VRFEntropy) {
        return new VRFEntropy(address(coord), bytes32(uint256(0xAB)), 7, 3, 200_000, hex"01");
    }

    /// The scripts' pattern: a fresh module wired both ways.
    function test_FreshModulePasses() public {
        VRFEntropy e = _module();
        e.setBoard(address(newPrize));
        newPrize.setEntropy(address(e));
        checker.check(newPrize, e);
    }

    /// The old prize's module, already used for round 1, pointed at the new prize.
    function test_ReusedModuleRefused() public {
        VRFEntropy e = _module();
        e.setBoard(address(oldPrize));
        oldPrize.setEntropy(address(e));
        bytes32 first = oldPrize.saltFor(1, 1);
        vm.prank(address(oldPrize));
        e.requestFor(first);                      // the old game's first draw

        newPrize.setEntropy(address(e));
        assertTrue(e.isRequested(newPrize.saltFor(1, 1)), "the new prize would skip its first request");
        vm.expectRevert(bytes("ENTROPY: module must serve this prize (a reused module's board is its old prize)"));
        checker.check(newPrize, e);
    }

    function test_UnwiredPrizeRefused() public {
        VRFEntropy e = _module();
        e.setBoard(address(newPrize));
        newPrize.setEntropy(address(_module()));  // prize left on another module
        vm.expectRevert(bytes("ENTROPY: prize must draw from the new module"));
        checker.check(newPrize, e);
    }

    /// Board check passes, but the module already holds a round-1 draw.
    function test_UsedModuleRefused() public {
        VRFEntropy e = _module();
        e.setBoard(address(newPrize));
        newPrize.setEntropy(address(e));
        bytes32 first = newPrize.saltFor(1, 1);
        vm.prank(address(newPrize));
        e.requestFor(first);
        vm.expectRevert(bytes("ENTROPY: module has already drawn round 1 (reused module)"));
        checker.check(newPrize, e);
    }
}
