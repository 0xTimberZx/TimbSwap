// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/TimbBoostFarm.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract DWToken is ERC20 {
    constructor(string memory n) ERC20(n, n) {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// TS-030: a top-up after periodFinish must not charge the dead window at
/// the new rate (the gap TS-002's roll-forward left open).
contract BoostFarmDeadWindowTest is Test {
    TimbBoostFarm farm;
    DWToken timbs;
    DWToken lp;
    address alice = address(0xA11CE);
    uint256 constant WINDOW = 1000;

    function setUp() public {
        timbs = new DWToken("TIMBS");
        lp    = new DWToken("LP");
        farm  = new TimbBoostFarm(address(timbs), WINDOW, address(0));
        farm.addPool(address(lp), 100);
        lp.mint(alice, 10 ether);
        vm.prank(alice); lp.approve(address(farm), type(uint256).max);
        timbs.mint(address(this), 1_000_000 ether);
        timbs.approve(address(farm), type(uint256).max);
        vm.prank(alice); farm.deposit(0, 10 ether);
    }

    function test_deadWindowDoesNotAccrueAtNewRate() public {
        farm.notifyRewardAmount(1_000 ether);               // rate r1
        uint256 finish = farm.periodFinish();
        vm.warp(finish + 3 days);                           // keeper offline
        uint256 owedAtFinish = farm.pendingReward(0, alice);
        assertApproxEqAbs(owedAtFinish, 1_000 ether, 1e6, "first window fully paid");

        farm.notifyRewardAmount(100_000 ether);             // 10x rate top-up
        uint256 rate2 = farm.rewardRatePerSecond();
        // Nothing may have been credited for the 3 dead days.
        assertApproxEqAbs(farm.pendingReward(0, alice), owedAtFinish, 1e6, "dead window not charged");

        vm.warp(block.timestamp + 100);
        assertApproxEqAbs(farm.pendingReward(0, alice) - owedAtFinish, rate2 * 100, 1e6, "new window accrues normally");
    }

    function test_firstFundingDoesNotBackdate() public {
        // Clock is 0 at deploy; funding much later must not accrue from 0.
        vm.warp(1_000_000);
        farm.notifyRewardAmount(1_000 ether);
        assertEq(farm.pendingReward(0, alice), 0, "no backdated accrual");
        vm.warp(block.timestamp + 10);
        assertApproxEqAbs(farm.pendingReward(0, alice), farm.rewardRatePerSecond() * 10, 1e6);
    }
}
