// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TimbStaking} from "../contracts/TimbStaking.sol";
import {TimbFarm} from "../contracts/TimbFarm.sol";

contract ReserveToken is ERC20 {
    constructor(string memory s) ERC20(s, s) { _mint(msg.sender, 1e30); }
}

/**
 * @title TS-011: emergencyWithdraw releases the forfeited reward from rewardReserve
 * @notice Before the fix the forfeited TIMBS stayed "committed" forever and
 *         recoverERC20 could never reclaim it.
 */
contract EmergencyWithdrawReserveTest is Test {
    ReserveToken timbs;
    address alice = address(0xA11CE);

    function setUp() public {
        timbs = new ReserveToken("TIMBS");
        timbs.transfer(alice, 1_000 ether);
    }

    function test_TS011_Staking_ForfeitReleasesReserve() public {
        TimbStaking staking = new TimbStaking(address(timbs), 0);
        timbs.approve(address(staking), type(uint256).max);
        vm.startPrank(alice);
        timbs.approve(address(staking), type(uint256).max);
        staking.stake(100 ether);
        vm.stopPrank();

        staking.notifyRewardAmount(100 ether, 100);
        vm.warp(block.timestamp + 100);
        uint256 earned = staking.earned(alice);
        assertGt(earned, 0);

        uint256 reserveBefore = staking.rewardReserve();
        vm.prank(alice);
        staking.emergencyWithdraw();
        assertEq(staking.rewardReserve(), reserveBefore - earned, "forfeit released");

        // The forfeited TIMBS is now recoverable by the owner.
        uint256 before = timbs.balanceOf(address(this));
        staking.recoverERC20(address(timbs), earned);
        assertEq(timbs.balanceOf(address(this)) - before, earned);
    }

    function test_TS011_Farm_ForfeitReleasesReserve() public {
        ReserveToken lp = new ReserveToken("LP");
        lp.transfer(alice, 1_000 ether);
        TimbFarm farm = new TimbFarm(address(timbs), 0);
        farm.setLpToken(address(lp));
        timbs.approve(address(farm), type(uint256).max);
        vm.startPrank(alice);
        lp.approve(address(farm), type(uint256).max);
        farm.stake(100 ether);
        vm.stopPrank();

        farm.notifyRewardAmount(100 ether, 100);
        vm.warp(block.timestamp + 100);
        uint256 earned = farm.earned(alice);
        assertGt(earned, 0);

        uint256 reserveBefore = farm.rewardReserve();
        vm.prank(alice);
        farm.emergencyWithdraw();
        assertEq(farm.rewardReserve(), reserveBefore - earned, "forfeit released");

        uint256 before = timbs.balanceOf(address(this));
        farm.recoverERC20(address(timbs), earned);
        assertEq(timbs.balanceOf(address(this)) - before, earned);
    }
}
