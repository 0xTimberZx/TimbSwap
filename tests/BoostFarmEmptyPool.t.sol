// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/TimbBoostFarm.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract FarmMockToken is ERC20 {
    constructor(string memory n) ERC20(n, n) {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// TS-026: an emptied (unpaused) pool must not keep its weight in totalWeight.
contract BoostFarmEmptyPoolTest is Test {
    TimbBoostFarm farm;
    FarmMockToken timbs;
    FarmMockToken lpA;
    FarmMockToken lpB;
    address alice = address(0xA11CE);
    address bob   = address(0xB0B);
    uint256 constant WINDOW = 1000;
    uint256 constant FUND   = 1_000_000 ether;

    function setUp() public {
        timbs = new FarmMockToken("TIMBS");
        lpA   = new FarmMockToken("LP-A");
        lpB   = new FarmMockToken("LP-B");
        farm  = new TimbBoostFarm(address(timbs), WINDOW, address(0));
        farm.addPool(address(lpA), 50);
        farm.addPool(address(lpB), 50);
        lpA.mint(alice, 100 ether);
        lpB.mint(bob, 100 ether);
        vm.prank(alice); lpA.approve(address(farm), type(uint256).max);
        vm.prank(bob);   lpB.approve(address(farm), type(uint256).max);
        timbs.mint(address(this), FUND);
        timbs.approve(address(farm), FUND);
    }

    /// Fund, then step one second so every pool clock is past the funding
    /// block before a window is measured.
    function _fund() internal {
        farm.notifyRewardAmount(FUND);
        vm.warp(block.timestamp + 1);
    }

    function test_newPoolsCarryNoWeightUntilStaked() public {
        assertEq(farm.totalWeight(), 0);
        vm.prank(alice); farm.deposit(0, 10 ether);
        assertEq(farm.totalWeight(), 50);
    }

    /// Mr Fz test A: funded pool next to an empty pool receives the FULL rate.
    function test_emptyPoolDoesNotDiluteFundedPool() public {
        vm.prank(alice); farm.deposit(0, 10 ether);
        _fund();
        uint256 rate = farm.rewardRatePerSecond();
        uint256 p0 = farm.pendingReward(0, alice);
        vm.warp(block.timestamp + 100);
        uint256 pending = farm.pendingReward(0, alice) - p0;
        assertApproxEqAbs(pending, rate * 100, 1e6, "funded pool must get the whole emission");
    }

    /// Last staker leaves -> weight released; returns on re-deposit.
    function test_weightReleasedOnEmptyAndRestoredOnDeposit() public {
        vm.prank(alice); farm.deposit(0, 10 ether);
        vm.prank(bob);   farm.deposit(1, 10 ether);
        assertEq(farm.totalWeight(), 100);
        _fund();
        uint256 rate = farm.rewardRatePerSecond();

        vm.warp(block.timestamp + 100);
        vm.prank(bob); farm.withdraw(1, 10 ether);
        assertEq(farm.totalWeight(), 50, "weight released on empty");

        uint256 a0 = farm.pendingReward(0, alice);
        vm.warp(block.timestamp + 100);
        uint256 a1 = farm.pendingReward(0, alice);
        assertApproxEqAbs(a1 - a0, rate * 100, 1e6, "alice gets full rate while B is empty");

        vm.prank(bob); farm.deposit(1, 10 ether);
        assertEq(farm.totalWeight(), 100, "weight restored on deposit");
        uint256 a2 = farm.pendingReward(0, alice);
        uint256 b2 = farm.pendingReward(1, bob);
        vm.warp(block.timestamp + 100);
        assertApproxEqAbs(farm.pendingReward(0, alice) - a2, rate * 50, 1e6, "back to half");
        assertApproxEqAbs(farm.pendingReward(1, bob) - b2, rate * 50, 1e6, "bob accrues half from re-entry");
    }

    function test_emergencyWithdrawAndExitReleaseWeight() public {
        vm.prank(alice); farm.deposit(0, 10 ether);
        vm.prank(bob);   farm.deposit(1, 10 ether);
        _fund();
        vm.warp(block.timestamp + 10);
        vm.prank(bob); farm.emergencyWithdraw(1);
        assertEq(farm.totalWeight(), 50);
        vm.prank(alice); farm.exit(0);
        assertEq(farm.totalWeight(), 0);
    }

    function test_pauseUnpauseRespectsEmptyPools() public {
        vm.prank(alice); farm.deposit(0, 10 ether);
        // pool 1 is empty: pausing/unpausing it must not touch totalWeight
        farm.pausePool(1);
        assertEq(farm.totalWeight(), 50);
        farm.unpausePool(1);
        assertEq(farm.totalWeight(), 50);
        // pause a staked pool removes it, unpause restores
        farm.pausePool(0);
        assertEq(farm.totalWeight(), 0);
        farm.unpausePool(0);
        assertEq(farm.totalWeight(), 50);
        // a paused pool that empties and refills does not leak weight
        farm.pausePool(0);
        vm.prank(alice); farm.withdraw(0, 10 ether);
        assertEq(farm.totalWeight(), 0);
        farm.unpausePool(0);
        assertEq(farm.totalWeight(), 0);
        vm.prank(alice); farm.deposit(0, 10 ether);
        assertEq(farm.totalWeight(), 50);
    }

    function test_setPoolWeightOnEmptyPool() public {
        vm.prank(alice); farm.deposit(0, 10 ether);
        farm.setPoolWeight(1, 150);
        assertEq(farm.totalWeight(), 50, "empty pool reweight does not change the split");
        vm.prank(bob); farm.deposit(1, 1 ether);
        assertEq(farm.totalWeight(), 200);
        farm.setPoolWeight(1, 50);
        assertEq(farm.totalWeight(), 100);
    }

    /// Invariant from the report: sum of per-pool accrual == rate * elapsed
    /// over a window with a mix of funded and empty pools.
    function test_fullEmissionIsOwed() public {
        vm.prank(alice); farm.deposit(0, 10 ether);
        _fund();
        uint256 rate = farm.rewardRatePerSecond();
        uint256 p0 = farm.pendingReward(0, alice);
        vm.warp(block.timestamp + 500);
        vm.prank(alice); farm.claimRewards(0);
        assertApproxEqAbs(timbs.balanceOf(alice) - p0, rate * 500, 1e6, "whole emission reached the only staker");
    }
}
