// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/TimbBoostFarm.sol";
import "../contracts/BoostRewarder.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract AttachSyncToken is ERC20 {
    constructor(string memory n) ERC20(n, n) {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// TS-074: a rewarder attached to a pool that already has stakers starts
/// every one of them at 0 shares, and only their own next farm action used
/// to sync them. Once funded, a 1-wei depositor was all of totalShares and
/// collected the whole stream. sync() lets anyone sync existing stakers to
/// their farm balance while the rewarder is attached and not retired; the
/// documented setup is attach, sync, then fund.
contract BoostRewarderAttachSyncTest is Test {
    TimbBoostFarm farm;
    BoostRewarder rewarder;
    AttachSyncToken timbs;
    AttachSyncToken lp;
    AttachSyncToken weth;

    address alice    = address(0xA11CE);
    address attacker = address(0xBAD);
    uint256 constant WINDOW = 7 days;
    uint256 constant FUND   = 7_000 ether;
    uint256 constant STAKE  = 1_000 ether;

    function setUp() public {
        timbs = new AttachSyncToken("TIMBS");
        lp    = new AttachSyncToken("LP");
        weth  = new AttachSyncToken("WETH");
        farm  = new TimbBoostFarm(address(timbs), WINDOW, address(0));
        farm.addPool(address(lp), 1);

        // Alice is staked before any rewarder exists.
        lp.mint(alice, STAKE);
        vm.startPrank(alice);
        lp.approve(address(farm), type(uint256).max);
        farm.deposit(0, STAKE);
        vm.stopPrank();

        lp.mint(attacker, 1);
        vm.prank(attacker);
        lp.approve(address(farm), type(uint256).max);

        rewarder = new BoostRewarder(address(farm), address(weth), WINDOW);
        weth.mint(address(this), FUND);
        weth.approve(address(rewarder), FUND);
    }

    function _users(address u) internal pure returns (address[] memory a) {
        a = new address[](1);
        a[0] = u;
    }

    /// The reported case, reproduced: attach, fund, 1-wei deposit, and the
    /// unsynced staker earns nothing while the dust takes the stream.
    function test_TS074_UnsyncedStakerLosesStreamToDust() public {
        farm.addPoolHook(0, address(rewarder));
        rewarder.notifyRewardAmount(FUND);
        vm.prank(attacker);
        farm.deposit(0, 1);

        vm.warp(block.timestamp + WINDOW);
        assertEq(rewarder.pendingReward(0, alice), 0, "alice unsynced");
        assertGt(rewarder.pendingReward(0, attacker), FUND * 99 / 100, "dust takes the stream");
    }

    /// The fix: attach, sync, fund. The dust gets its pro-rata share only.
    function test_TS074_SyncBeforeFundingSplitsProRata() public {
        farm.addPoolHook(0, address(rewarder));
        rewarder.sync(0, _users(alice));
        assertEq(rewarder.shares(0, alice), STAKE, "synced to the farm balance");
        assertEq(rewarder.totalShares(), STAKE);
        rewarder.notifyRewardAmount(FUND);
        vm.prank(attacker);
        farm.deposit(0, 1);

        vm.warp(block.timestamp + WINDOW);
        assertGt(rewarder.pendingReward(0, alice), FUND * 98 / 100, "alice earns the stream");
        // 1 wei of 1000e18 staked: FUND * 1 / STAKE = 7 wei, pro rata.
        assertLe(rewarder.pendingReward(0, attacker), FUND / STAKE, "dust earns dust");
    }

    /// Syncing mid-stream credits only from the sync on; nothing earlier is
    /// clawed back from whoever held shares, and the staker's farm action
    /// afterwards is a no-op for shares.
    function test_TS074_LateSyncStartsAccrualFromNow() public {
        farm.addPoolHook(0, address(rewarder));
        rewarder.notifyRewardAmount(FUND);
        vm.prank(attacker);
        farm.deposit(0, 1);
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 1 days);

        vm.prank(address(0xC0FFEE)); // anyone may sync
        rewarder.sync(0, _users(alice));
        uint256 attackerAtSync = rewarder.pendingReward(0, attacker);
        assertEq(rewarder.pendingReward(0, alice), 0, "no retroactive credit");

        vm.warp(t0 + 2 days);
        assertGt(rewarder.pendingReward(0, alice), 0, "accrues after sync");
        assertLe(rewarder.pendingReward(0, attacker) - attackerAtSync, FUND / STAKE, "dust share after sync");
    }

    /// A stranger can only set a user's shares to that user's own farm
    /// balance: syncing a non-staker or re-syncing changes nothing.
    function test_TS074_SyncCannotInflateShares() public {
        farm.addPoolHook(0, address(rewarder));
        rewarder.sync(0, _users(attacker));
        assertEq(rewarder.shares(0, attacker), 0, "no farm balance, no shares");
        rewarder.sync(0, _users(alice));
        rewarder.sync(0, _users(alice));
        assertEq(rewarder.shares(0, alice), STAKE);
        assertEq(rewarder.totalShares(), STAKE, "re-sync is idempotent");
    }

    /// Never attached, or removed: sync refuses (TS-058, frozen shares stay frozen).
    function test_TS074_SyncRefusedWhenNotAttached() public {
        vm.expectRevert(abi.encodeWithSelector(BoostRewarder.NotAttached.selector, 0));
        rewarder.sync(0, _users(alice));

        farm.addPoolHook(0, address(rewarder));
        farm.removePoolHook(0, address(rewarder));
        vm.expectRevert(abi.encodeWithSelector(BoostRewarder.NotAttached.selector, 0));
        rewarder.sync(0, _users(alice));
    }

    function test_TS074_SyncRefusedWhenRetired() public {
        farm.addPoolHook(0, address(rewarder));
        rewarder.retire();
        vm.expectRevert(BoostRewarder.RewarderRetired.selector);
        rewarder.sync(0, _users(alice));
    }

    /// Attached to another pool only: syncing pool 0 is refused.
    function test_TS074_SyncRefusedForAnotherPool() public {
        AttachSyncToken lp2 = new AttachSyncToken("LP2");
        farm.addPool(address(lp2), 1);
        farm.addPoolHook(1, address(rewarder));
        vm.expectRevert(abi.encodeWithSelector(BoostRewarder.NotAttached.selector, 0));
        rewarder.sync(0, _users(alice));
    }
}
