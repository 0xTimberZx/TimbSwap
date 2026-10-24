// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../contracts/TimbGovernance.sol";

contract StrayMockTIMBS is ERC20 {
    constructor(string memory n) ERC20(n, n) {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// TS-065: TIMBS sent to TimbGovernance by plain transfer, instead of
/// depositVotingPower, was credited to no one, and withdrawVotingPower pays
/// only credited balances, so it was locked for good. The owner can now
/// return it, bounded by totalVotingPower so deposited power is untouchable.
contract GovernanceStrayTimbsTest is Test {
    StrayMockTIMBS timbs;
    StrayMockTIMBS other;
    TimbGovernance gov;
    address alice = address(0xA11CE);
    address bob   = address(0xB0B);
    uint256 constant STRAY = 500e18;

    function setUp() public {
        timbs = new StrayMockTIMBS("TIMBS");
        other = new StrayMockTIMBS("OTHER");
        gov   = new TimbGovernance(address(timbs), 1_000e18, 400, 3 days, 1 days);
        timbs.mint(alice, 1_000_000e18);
        timbs.mint(bob, 1_000_000e18);
        vm.warp(1_000_000);
    }

    function _deposit(address who, uint256 amount) internal {
        vm.startPrank(who);
        timbs.approve(address(gov), amount);
        gov.depositVotingPower(amount);
        vm.stopPrank();
    }

    // ─── The reported case ──────────────────────────────────────────────────

    function test_strayTransferReturnable() public {
        vm.prank(alice); timbs.transfer(address(gov), STRAY);
        assertEq(gov.totalVotingPower(), 0);

        uint256 before = timbs.balanceOf(alice);
        gov.recoverERC20(address(timbs), alice, STRAY);
        assertEq(timbs.balanceOf(alice), before + STRAY);
        assertEq(timbs.balanceOf(address(gov)), 0);
    }

    /// Reporter's PoC 3: a full deposit/withdraw cycle leaves the stray behind.
    function test_strayRecoverableAfterFullLegitCycle() public {
        vm.prank(alice); timbs.transfer(address(gov), STRAY);
        _deposit(alice, 1_000e18);
        vm.prank(alice); gov.withdrawVotingPower(1_000e18);
        assertEq(timbs.balanceOf(address(gov)), STRAY);
        gov.recoverERC20(address(timbs), alice, STRAY);
        assertEq(timbs.balanceOf(address(gov)), 0);
    }

    // ─── Deposited power is untouchable ─────────────────────────────────────

    function test_cannotRecoverDepositedPower() public {
        _deposit(alice, 1_000e18);
        _deposit(bob, 2_000e18);
        vm.prank(alice); timbs.transfer(address(gov), STRAY);

        vm.expectRevert(abi.encodeWithSelector(
            TimbGovernance.ExceedsRecoverable.selector, STRAY + 1, STRAY));
        gov.recoverERC20(address(timbs), alice, STRAY + 1);

        gov.recoverERC20(address(timbs), alice, STRAY);
        assertEq(timbs.balanceOf(address(gov)), gov.totalVotingPower());

        // Every depositor can still leave in full.
        vm.prank(alice); gov.withdrawVotingPower(1_000e18);
        vm.prank(bob);   gov.withdrawVotingPower(2_000e18);
        assertEq(timbs.balanceOf(address(gov)), 0);
    }

    function test_noStrayNothingRecoverable() public {
        _deposit(alice, 1_000e18);
        vm.expectRevert(abi.encodeWithSelector(
            TimbGovernance.ExceedsRecoverable.selector, 1, 0));
        gov.recoverERC20(address(timbs), alice, 1);
    }

    // ─── Other tokens, access, inputs ───────────────────────────────────────

    function test_otherTokenFullyRecoverable() public {
        _deposit(alice, 1_000e18);
        other.mint(address(gov), 7e18);
        gov.recoverERC20(address(other), bob, 7e18);
        assertEq(other.balanceOf(bob), 7e18);
        assertEq(timbs.balanceOf(address(gov)), 1_000e18);
    }

    function test_onlyOwner() public {
        vm.prank(alice); timbs.transfer(address(gov), STRAY);
        vm.prank(alice);
        vm.expectRevert();
        gov.recoverERC20(address(timbs), alice, STRAY);
    }

    function test_rejectsZeroRecipientAndAmount() public {
        vm.prank(alice); timbs.transfer(address(gov), STRAY);
        vm.expectRevert(TimbGovernance.ZeroAddress.selector);
        gov.recoverERC20(address(timbs), address(0), STRAY);
        vm.expectRevert(TimbGovernance.ZeroAmount.selector);
        gov.recoverERC20(address(timbs), alice, 0);
    }
}
