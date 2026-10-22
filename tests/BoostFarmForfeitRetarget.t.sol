// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/TimbBoostFarm.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ForfeitMockToken is ERC20 {
    constructor(string memory n) ERC20(n, n) {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// TS-060: emergencyWithdraw released the forfeited pending from totalOwed
/// but never retargeted, so a farm at the 99% solvency stop kept a zero rate
/// on a freed reserve until an unrelated claim or top-up.
contract BoostFarmForfeitRetargetTest is Test {
    TimbBoostFarm farm;
    ForfeitMockToken timbs;
    ForfeitMockToken lp;
    address mainStaker = address(0xA11CE);
    address dustStaker = address(0xD057);
    address freshUser  = address(0xF4E5);
    uint256 constant WINDOW = 100;
    uint256 constant FUND   = 100 ether;

    function setUp() public {
        timbs = new ForfeitMockToken("TIMBS");
        lp    = new ForfeitMockToken("LP");
        farm  = new TimbBoostFarm(address(timbs), WINDOW, address(0));
        farm.addPool(address(lp), 1);
        _stake(mainStaker, 99 ether);
        _stake(dustStaker, 1 ether);
        lp.mint(freshUser, 10 ether);
        vm.prank(freshUser); lp.approve(address(farm), type(uint256).max);
        timbs.mint(address(this), FUND);
        timbs.approve(address(farm), FUND);
        farm.notifyRewardAmount(FUND);
    }

    function _stake(address who, uint256 amt) internal {
        lp.mint(who, amt);
        vm.startPrank(who);
        lp.approve(address(farm), type(uint256).max);
        farm.deposit(0, amt);
        vm.stopPrank();
    }

    /// Drive the farm onto the solvency stop: a full window accrues the
    /// whole reserve, then the dust claim retargets with owed >= 99%.
    function _toSolvencyStop() internal {
        vm.warp(block.timestamp + WINDOW);
        vm.prank(dustStaker);
        farm.claimRewards(0);
        assertEq(farm.rewardRatePerSecond(), 0, "solvency stop");
    }

    function test_TS060_ForfeitureRestartsEmission() public {
        _toSolvencyStop();

        vm.prank(mainStaker);
        farm.emergencyWithdraw(0);
        assertEq(lp.balanceOf(mainStaker), 99 ether, "principal back");
        assertGt(farm.rewardRatePerSecond(), 0, "freed reserve re-emits at once");
        assertEq(farm.periodFinish(), block.timestamp + WINDOW, "fresh window");

        vm.prank(freshUser);
        farm.deposit(0, 10 ether);
        vm.warp(block.timestamp + WINDOW);
        assertGt(farm.pendingReward(0, freshUser), 0, "fresh deposit earns");
    }

    /// Nothing forfeited (no pending yet): the rate and window are untouched.
    function test_TS060_NoForfeitNoRetarget() public {
        vm.prank(freshUser);
        farm.deposit(0, 10 ether);
        uint256 rate = farm.rewardRatePerSecond();
        uint256 finish = farm.periodFinish();

        vm.prank(freshUser);
        farm.emergencyWithdraw(0);
        assertEq(farm.rewardRatePerSecond(), rate, "rate unchanged");
        assertEq(farm.periodFinish(), finish, "window unchanged");
    }

    /// Accrual before the forfeiture is rolled at the old rate: the dust
    /// staker's pending is not rewritten by the retarget.
    function test_TS060_PriorAccrualPreserved() public {
        vm.warp(block.timestamp + WINDOW / 2);
        uint256 dustBefore = farm.pendingReward(0, dustStaker);
        vm.prank(mainStaker);
        farm.emergencyWithdraw(0);
        assertEq(farm.pendingReward(0, dustStaker), dustBefore, "dust pending kept");
    }
}
