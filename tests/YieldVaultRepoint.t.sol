// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/TimbYieldVault.sol";
import "../contracts/GameRegistry.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract RepointTIMBS is ERC20 {
    constructor() ERC20("TIMBS", "TIMBS") {}
}

/// @dev Counts newEpoch() calls.
contract CountingVault {
    uint256 public epochs;
    function register(uint256, address, uint256) external {}
    function remove(uint256) external {}
    function newEpoch() external { epochs += 1; }
}

/// @dev A vault whose newEpoch() always reverts.
contract BrokenVault {
    function register(uint256, address, uint256) external {}
    function remove(uint256) external {}
    function newEpoch() external pure { revert("broken"); }
}

/**
 * TS-056: GameRegistry.setYieldVault retires the outgoing vault's ticket
 * weight, as the vault-side repoint (TS-014) and every generation bump
 * (TS-046) already do. Without it the orphaned vault kept accruing on dead
 * weight until the earmark covered its whole reserve.
 *
 * Run: forge test --match-contract YieldVaultRepointTest -vvv
 */
contract YieldVaultRepointTest is Test {
    GameRegistry reg;
    TimbYieldVault vaultA;
    TimbYieldVault vaultB;

    function setUp() public {
        reg = new GameRegistry(address(new RepointTIMBS()), address(this), address(0xB1DE), 2e18, 1e18);
        vaultA = new TimbYieldVault();
        vaultB = new TimbYieldVault();
        vaultA.setGameRegistry(address(reg));
        vaultB.setGameRegistry(address(reg));
        vaultA.setTimbPrize(address(this));
        vaultA.setYieldAPRBps(10_000);
        vaultA.fund{value: 5 ether}();
        reg.setYieldVault(address(vaultA));
        // Ticket weight as the registry registers it on activation.
        vm.prank(address(reg));
        vaultA.register(1, address(0), 1 ether);
    }

    receive() external payable {}

    function test_TS056_RepointRetiresOldWeight() public {
        vm.warp(block.timestamp + 30 days);
        uint256 earnedBefore = vaultA.previewAccrued();
        assertGt(earnedBefore, 0, "live ticket earned while live");

        reg.setYieldVault(address(vaultB));
        assertEq(reg.yieldVault(), address(vaultB));
        assertEq(vaultA.totalWeight(), 0, "old vault's weight retired");
        assertEq(vaultA.epoch(), 1, "old vault moved to a new epoch");
        assertEq(vaultA.accruedForPot(), earnedBefore, "accrual up to the repoint kept");

        // Nothing accrues on dead weight afterwards, so the reserve stays free.
        vm.warp(block.timestamp + 11 * 365 days);
        assertEq(vaultA.previewAccrued(), earnedBefore, "no accrual after the repoint");
        uint256 free = vaultA.reserve();
        assertEq(free, 5 ether - earnedBefore);
        vaultA.emergencyWithdraw(address(this), free);
        assertEq(address(vaultA).balance, earnedBefore, "only the earned yield remains");
    }

    function test_TS056_RepointToZeroRetiresToo() public {
        reg.setYieldVault(address(0));
        assertEq(vaultA.totalWeight(), 0, "disabling yield retires the weight");
    }

    function test_TS056_SameVaultIsNoOp() public {
        CountingVault cv = new CountingVault();
        GameRegistry r = new GameRegistry(address(new RepointTIMBS()), address(this), address(0xB1DE), 2e18, 1e18);
        r.setYieldVault(address(cv));      // from none: nothing to retire
        assertEq(cv.epochs(), 0);
        r.setYieldVault(address(cv));      // same vault: no epoch
        assertEq(cv.epochs(), 0);
        r.setYieldVault(address(0xBEEF));  // a real repoint retires
        assertEq(cv.epochs(), 1);
    }

    function test_TS056_BrokenOldVaultDoesNotBlockRepoint() public {
        BrokenVault bv = new BrokenVault();
        GameRegistry r = new GameRegistry(address(new RepointTIMBS()), address(this), address(0xB1DE), 2e18, 1e18);
        r.setYieldVault(address(bv));
        r.setYieldVault(address(vaultB));
        assertEq(r.yieldVault(), address(vaultB), "repoint goes through");
    }

    function test_TS056_OwnerOnly() public {
        vm.prank(address(0x5747));
        vm.expectRevert();
        reg.setYieldVault(address(vaultB));
    }
}
