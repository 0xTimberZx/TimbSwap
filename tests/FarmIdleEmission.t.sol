// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/TimbFarm.sol";
import "../contracts/TimbStaking.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract IEToken is ERC20 {
    constructor(string memory n) ERC20(n, n) {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// TS-064: TIMBS streamed while nobody is staked accrues to no one, but it
/// was never taken off rewardReserve, so recoverERC20 could not reach it and
/// no later notify re-streamed it. Fund 1000 over 30d, leave the pool empty
/// for 15d, then one staker takes the second half: the idle 500 must be
/// recoverable. setRewardRate now recommits the reserve to the new promise,
/// so a cut releases its difference and a hike re-reserves released TIMBS.
contract FarmIdleEmissionTest is Test {
    IEToken timbs;
    IEToken lp;
    TimbFarm farm;
    TimbStaking staking;
    address alice = address(0xA11CE);
    uint256 constant FUND = 1_000 ether;
    uint256 constant DUR  = 30 days;
    uint256 constant DUST = 1e9;
    uint256 start; // absolute warps: via-ir caches block.timestamp across vm.warp

    function setUp() public {
        timbs = new IEToken("TIMBS");
        lp    = new IEToken("LP");
        farm    = new TimbFarm(address(timbs), 0);
        staking = new TimbStaking(address(timbs), 0);
        farm.setLpToken(address(lp));
        timbs.mint(address(this), 10_000 ether);
        timbs.approve(address(farm), type(uint256).max);
        timbs.approve(address(staking), type(uint256).max);
        lp.mint(alice, 10 ether);
        timbs.mint(alice, 10 ether);
        start = block.timestamp;
        vm.startPrank(alice);
        lp.approve(address(farm), type(uint256).max);
        timbs.approve(address(staking), type(uint256).max);
        vm.stopPrank();
    }

    function _idleThenStake() internal {
        farm.notifyRewardAmount(FUND, DUR);
        staking.notifyRewardAmount(FUND, DUR);
        vm.warp(start + 15 days); // nobody staked: ~500 idle on each
        vm.startPrank(alice);
        farm.stake(10 ether);
        staking.stake(10 ether);
        vm.stopPrank();
    }

    // ─── The reported case: idle emission is recoverable ────────────────────

    function test_farm_idleEmissionRecoverable() public {
        _idleThenStake();
        vm.warp(start + 30 days);
        vm.prank(alice); farm.exit(); // LP back; her 10 TIMBS sit in staking
        assertApproxEqAbs(timbs.balanceOf(alice), FUND / 2, DUST);

        assertLe(farm.rewardReserve(), DUST, "idle stretch left committed");
        uint256 before = timbs.balanceOf(address(this));
        farm.recoverERC20(address(timbs), FUND / 2 - DUST);
        assertEq(timbs.balanceOf(address(this)), before + FUND / 2 - DUST);
    }

    function test_staking_idleEmissionRecoverable() public {
        _idleThenStake();
        vm.warp(start + 30 days);
        vm.prank(alice); staking.exit();
        assertApproxEqAbs(timbs.balanceOf(alice), 10 ether + FUND / 2, DUST);

        assertLe(staking.rewardReserve(), DUST, "idle stretch left committed");
        uint256 before = timbs.balanceOf(address(this));
        staking.recoverERC20(address(timbs), FUND / 2 - DUST);
        assertEq(timbs.balanceOf(address(this)), before + FUND / 2 - DUST);
    }

    /// The release must never touch what a staker is owed: recovering the
    /// idle half mid-period still leaves the second half fully claimable.
    function test_farm_recoverIdleMidPeriodKeepsStakerWhole() public {
        _idleThenStake();
        vm.warp(start + 20 days);
        farm.recoverERC20(address(timbs), FUND / 2 - DUST);
        vm.warp(start + 30 days);
        vm.prank(alice); farm.claimRewards();
        assertApproxEqAbs(timbs.balanceOf(alice), FUND / 2, DUST);
    }

    function test_staking_recoverIdleMidPeriodKeepsStakerWhole() public {
        _idleThenStake();
        vm.warp(start + 20 days);
        staking.recoverERC20(address(timbs), FUND / 2 - DUST);
        vm.warp(start + 30 days);
        vm.prank(alice); staking.claimRewards();
        assertApproxEqAbs(timbs.balanceOf(alice), FUND / 2, DUST);
    }

    // ─── setRewardRate recommits the reserve ────────────────────────────────

    /// A hike that re-emits the released idle TIMBS is reserved again, so the
    /// owner cannot recover TIMBS that is now owed to the stream.
    function test_farm_hikeAfterIdleReReserves() public {
        _idleThenStake();
        farm.setRewardRate(FUND / 15 days); // spend the whole balance over 15d
        assertApproxEqAbs(farm.rewardReserve(), FUND, DUST);
        vm.expectRevert();
        farm.recoverERC20(address(timbs), DUST + 1);
        vm.warp(start + 30 days);
        vm.prank(alice); farm.claimRewards();
        assertApproxEqAbs(timbs.balanceOf(alice), FUND, DUST);
    }

    function test_staking_hikeAfterIdleReReserves() public {
        _idleThenStake();
        staking.setRewardRate(FUND / 15 days);
        assertApproxEqAbs(staking.rewardReserve(), FUND, DUST);
        vm.expectRevert();
        staking.recoverERC20(address(timbs), DUST + 1);
        vm.warp(start + 30 days);
        vm.prank(alice); staking.claimRewards();
        assertApproxEqAbs(timbs.balanceOf(alice), FUND, DUST);
    }

    /// A rate cut releases what the old rate would have streamed and the new
    /// one will not; stakers still receive everything accrued plus the cut rate.
    function test_farm_cutReleasesDifference() public {
        vm.prank(alice); farm.stake(10 ether);
        farm.notifyRewardAmount(FUND, DUR);
        vm.warp(start + 15 days);              // ~500 accrued
        farm.setRewardRate(farm.rewardRatePerSecond() / 2); // ~250 still to stream
        assertApproxEqAbs(farm.rewardReserve(), 750 ether, DUST);
        farm.recoverERC20(address(timbs), 250 ether - DUST);
        vm.warp(start + 30 days);
        uint256 before = timbs.balanceOf(alice);
        vm.prank(alice); farm.claimRewards();
        assertApproxEqAbs(timbs.balanceOf(alice) - before, 750 ether, DUST);
    }

    function test_staking_cutReleasesDifference() public {
        vm.prank(alice); staking.stake(10 ether);
        staking.notifyRewardAmount(FUND, DUR);
        vm.warp(start + 15 days);
        staking.setRewardRate(staking.rewardRatePerSecond() / 2);
        assertApproxEqAbs(staking.rewardReserve(), 750 ether, DUST);
        staking.recoverERC20(address(timbs), 250 ether - DUST);
        vm.warp(start + 30 days);
        vm.prank(alice); staking.claimRewards();
        assertApproxEqAbs(timbs.balanceOf(alice), 750 ether, DUST);
    }

    /// A pool that is never empty releases nothing.
    function test_farm_continuousStakeReleasesNothing() public {
        vm.prank(alice); farm.stake(10 ether);
        farm.notifyRewardAmount(FUND, DUR);
        vm.warp(start + 10 days);
        uint256 before = timbs.balanceOf(alice);
        vm.prank(alice); farm.claimRewards();
        uint256 paid = timbs.balanceOf(alice) - before;
        assertEq(farm.rewardReserve(), FUND - paid);
    }
}
