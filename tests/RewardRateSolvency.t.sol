// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/TimbFarm.sol";
import "../contracts/TimbStaking.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract RSToken is ERC20 {
    constructor(string memory n) ERC20(n, n) {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// TS-037: setRewardRate's solvency assert must count rewards already
/// accrued but unclaimed. Fund 1000 over 30d, accrue 15d unclaimed (500 owed),
/// then a hike to 1000/15d passed the old check (1000 <= 1000) while the true
/// obligation was 1500, and claims reverted at period end.
contract RewardRateSolvencyTest is Test {
    RSToken timbs;
    RSToken lp;
    TimbFarm farm;
    TimbStaking staking;
    address alice = address(0xA11CE);
    uint256 constant FUND = 1_000 ether;
    uint256 constant DUR  = 30 days;

    function setUp() public {
        timbs = new RSToken("TIMBS");
        lp    = new RSToken("LP");
        farm    = new TimbFarm(address(timbs), 0);
        staking = new TimbStaking(address(timbs), 0);
        farm.setLpToken(address(lp));
        timbs.mint(address(this), 10_000 ether);
        timbs.approve(address(farm), type(uint256).max);
        timbs.approve(address(staking), type(uint256).max);
        lp.mint(alice, 10 ether);
        timbs.mint(alice, 10 ether);
        vm.startPrank(alice);
        lp.approve(address(farm), type(uint256).max);
        timbs.approve(address(staking), type(uint256).max);
        farm.stake(10 ether);
        staking.stake(10 ether);
        vm.stopPrank();
        farm.notifyRewardAmount(FUND, DUR);
        staking.notifyRewardAmount(FUND, DUR);
        vm.warp(block.timestamp + 15 days); // ~500 accrued, unclaimed, on each
    }

    function test_farm_hikeOverAccruedLiabilityReverts() public {
        uint256 hike = FUND / 15 days; // old check: 1000 <= 1000 passes
        vm.expectRevert();
        farm.setRewardRate(hike);
    }

    function test_staking_hikeOverAccruedLiabilityReverts() public {
        uint256 hike = FUND / 15 days;
        vm.expectRevert();
        staking.setRewardRate(hike);
    }

    function test_farm_solventHikePassesAndClaimsPay() public {
        // Re-spend only the unemitted half at the same rate: 500 + 500 <= 1000.
        uint256 same = farm.rewardRatePerSecond();
        farm.setRewardRate(same);
        vm.warp(block.timestamp + 15 days);
        vm.prank(alice); farm.claimRewards();
        assertApproxEqAbs(timbs.balanceOf(alice), FUND, 1e9);
    }

    function test_staking_solventHikePassesAndClaimsPay() public {
        uint256 same = staking.rewardRatePerSecond();
        staking.setRewardRate(same);
        vm.warp(block.timestamp + 15 days);
        vm.prank(alice); staking.claimRewards();
        assertApproxEqAbs(timbs.balanceOf(alice), FUND, 1e9);
    }

    function test_farm_hikeWithTopUpPasses() public {
        // Fund the extra promise first, then the same hike is solvent.
        timbs.transfer(address(farm), 500 ether);
        farm.setRewardRate(FUND / 15 days);
        vm.warp(block.timestamp + 15 days);
        vm.prank(alice); farm.claimRewards();
        assertApproxEqAbs(timbs.balanceOf(alice), 1_500 ether, 1e9);
    }
}
