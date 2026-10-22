// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/TimbBoostFarm.sol";
import "../contracts/BoostRewarder.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract RewarderMockToken is ERC20 {
    constructor(string memory n) ERC20(n, n) {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// TS-058: a rewarder removed from the farm kept streaming its whole reserve
/// to the shares frozen at removal, re-arming a full window on every claim,
/// and the owner could neither stop it nor recover the reserve. retire()
/// ends emission, keeps accrued rewards claimable and frees the unowed rest.
contract BoostRewarderRetireTest is Test {
    TimbBoostFarm farm;
    BoostRewarder rewarder;
    RewarderMockToken timbs;
    RewarderMockToken lp;
    RewarderMockToken weth;
    address alice = address(0xA11CE);
    address stranger = address(0xBAD);
    uint256 constant STAKE  = 100 ether;
    uint256 constant FUND   = 100 ether;
    uint256 constant WINDOW = 7 days;

    function setUp() public {
        timbs = new RewarderMockToken("TIMBS");
        lp    = new RewarderMockToken("LP");
        weth  = new RewarderMockToken("WETH");
        farm  = new TimbBoostFarm(address(timbs), WINDOW, address(0));
        farm.addPool(address(lp), 1);
        rewarder = new BoostRewarder(address(farm), address(weth), WINDOW);
        farm.addPoolHook(0, address(rewarder));

        weth.mint(address(this), FUND);
        weth.approve(address(rewarder), FUND);
        rewarder.notifyRewardAmount(FUND);

        lp.mint(alice, STAKE);
        vm.startPrank(alice);
        lp.approve(address(farm), type(uint256).max);
        farm.deposit(0, STAKE);
        vm.stopPrank();
    }

    /// The documented replacement, now: retire, remove, exit. Only the day
    /// earned while staked is paid; waiting a full window adds nothing.
    function test_TS058_RetireThenRemoveStopsPhantomPayout() public {
        vm.warp(block.timestamp + 1 days);
        rewarder.retire();
        farm.removePoolHook(0, address(rewarder));

        vm.prank(alice);
        farm.withdraw(0, STAKE);
        assertEq(rewarder.shares(0, alice), STAKE, "shares frozen at removal");

        uint256 earned = rewarder.pendingReward(0, alice);
        assertGt(earned, 0, "one day earned while staked");

        vm.warp(block.timestamp + 1 days);
        assertEq(rewarder.pendingReward(0, alice), earned, "no accrual after retire");
        vm.prank(alice);
        rewarder.claim(0);
        assertEq(weth.balanceOf(alice), earned, "only the pre-retire accrual is paid");
        assertEq(rewarder.rewardRatePerSecond(), 0, "claim did not re-arm the rate");
        assertLe(rewarder.periodFinish(), block.timestamp, "claim did not re-arm the period");

        vm.warp(block.timestamp + WINDOW);
        vm.prank(alice);
        vm.expectRevert(BoostRewarder.NoPendingRewards.selector);
        rewarder.claim(0);
        assertLt(earned, FUND / 5, "most of the reserve was never paid out");
    }

    /// The owner recovers everything not yet owed; what is owed stays
    /// claimable in full afterwards.
    function test_TS058_RetiredReserveRecoverableOwedStaysPayable() public {
        vm.warp(block.timestamp + 1 days);
        rewarder.retire();
        uint256 owed = rewarder.totalOwed();
        assertGt(owed, 0);

        uint256 recoverable = FUND - owed;
        vm.expectRevert(abi.encodeWithSelector(BoostRewarder.InsufficientRewardBalance.selector, recoverable + 1, recoverable));
        rewarder.recoverERC20(address(weth), recoverable + 1);
        rewarder.recoverERC20(address(weth), recoverable);
        assertEq(weth.balanceOf(address(this)), recoverable, "unowed reserve recovered");
        assertEq(rewarder.rewardReserve(), owed, "reserve tracks what is still owed");

        uint256 earned = rewarder.pendingReward(0, alice);
        vm.prank(alice);
        rewarder.claim(0);
        assertEq(weth.balanceOf(alice), earned, "accrued reward still paid in full");
        assertLe(weth.balanceOf(address(rewarder)), 1e6, "only rounding dust left");
    }

    /// Without retire the reserve stays locked to the owner, as before.
    function test_TS058_UnretiredReserveNotRecoverable() public {
        vm.expectRevert(abi.encodeWithSelector(BoostRewarder.InsufficientRewardBalance.selector, 1, 0));
        rewarder.recoverERC20(address(weth), 1);
    }

    /// A retired rewarder takes no new funding or window change, retires
    /// once, and only the owner can retire it.
    function test_TS058_RetiredIsFinalAndOwnerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        rewarder.retire();

        rewarder.retire();
        assertTrue(rewarder.retired());
        vm.expectRevert(BoostRewarder.RewarderRetired.selector);
        rewarder.retire();

        weth.mint(address(this), 1 ether);
        weth.approve(address(rewarder), 1 ether);
        vm.expectRevert(BoostRewarder.RewarderRetired.selector);
        rewarder.notifyRewardAmount(1 ether);
        vm.expectRevert(BoostRewarder.RewarderRetired.selector);
        rewarder.setEmissionWindow(1 days);
    }

    /// Control, unchanged behaviour: hook attached, exit syncs shares to 0
    /// and nothing more accrues.
    function test_TS058_Control_AttachedExitSyncsToZero() public {
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        farm.withdraw(0, STAKE);
        assertEq(rewarder.shares(0, alice), 0);
        uint256 earned = rewarder.pendingReward(0, alice);
        vm.prank(alice);
        rewarder.claim(0);
        vm.warp(block.timestamp + WINDOW);
        vm.prank(alice);
        vm.expectRevert(BoostRewarder.NoPendingRewards.selector);
        rewarder.claim(0);
        assertEq(weth.balanceOf(alice), earned);
    }
}
