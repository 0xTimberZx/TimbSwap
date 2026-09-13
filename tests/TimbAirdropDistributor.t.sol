// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../contracts/TimbAirdropDistributor.sol";

contract MockTIMBS is ERC20 {
    constructor() ERC20("TIMBS", "TIMBS") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/**
 * @notice Coverage for TimbAirdropDistributor: the happy-path batch, the
 *         impossible double-send (claimed mapping), per-round independence, both
 *         caps, dispatcher gating, pause, and recover.
 */
contract TimbAirdropDistributorTest is Test {
    MockTIMBS timbs;
    TimbAirdropDistributor d;

    address dispatcher = address(0xD15);
    address guardian   = address(0x6A6);
    address alice      = address(0xA11CE);
    address bob        = address(0xB0B);
    address rando      = address(0xF00D);

    uint256 constant AMOUNT     = 1e18;
    uint256 constant TOTAL_CAP  = 10e18;
    uint256 constant ROUND_CAP  = 5e18;
    uint256 constant FLOAT      = 100e18;

    function setUp() public {
        timbs = new MockTIMBS();
        d = new TimbAirdropDistributor(address(timbs), AMOUNT, TOTAL_CAP, ROUND_CAP);
        d.setDispatcher(dispatcher);
        d.setGuardian(guardian);
        timbs.mint(address(d), FLOAT); // pre-fund the float
    }

    function _batch(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1); arr[0] = a;
    }
    function _batch(address a, address b) internal pure returns (address[] memory arr) {
        arr = new address[](2); arr[0] = a; arr[1] = b;
    }

    // ─── Happy path ───────────────────────────────────────────────────────────

    function test_Distribute_HappyPath() public {
        vm.prank(dispatcher);
        d.distribute(_batch(alice, bob), 1);
        assertEq(timbs.balanceOf(alice), AMOUNT, "alice paid");
        assertEq(timbs.balanceOf(bob), AMOUNT, "bob paid");
        assertTrue(d.isClaimed(1, alice));
        assertTrue(d.isClaimed(1, bob));
        assertEq(d.totalDistributed(), 2 * AMOUNT);
        assertEq(d.roundDistributed(1), 2 * AMOUNT);
    }

    function test_OwnerCanAlsoDistribute() public {
        d.distribute(_batch(alice), 1); // this contract is owner
        assertTrue(d.isClaimed(1, alice));
    }

    // ─── Double-send is impossible ───────────────────────────────────────────────

    function test_DoubleSend_AcrossCalls_Reverts() public {
        vm.startPrank(dispatcher);
        d.distribute(_batch(alice), 1);
        vm.expectRevert(abi.encodeWithSelector(TimbAirdropDistributor.AlreadyClaimed.selector, uint256(1), alice));
        d.distribute(_batch(alice), 1);
        vm.stopPrank();
        assertEq(timbs.balanceOf(alice), AMOUNT, "paid exactly once");
    }

    function test_DoubleSend_WithinBatch_Reverts() public {
        vm.prank(dispatcher);
        vm.expectRevert(abi.encodeWithSelector(TimbAirdropDistributor.AlreadyClaimed.selector, uint256(1), alice));
        d.distribute(_batch(alice, alice), 1);
    }

    function test_DifferentRound_AllowsAgain() public {
        vm.startPrank(dispatcher);
        d.distribute(_batch(alice), 1);
        d.distribute(_batch(alice), 2);
        vm.stopPrank();
        assertEq(timbs.balanceOf(alice), 2 * AMOUNT);
        assertTrue(d.isClaimed(2, alice));
    }

    // ─── Caps ────────────────────────────────────────────────────────────────────

    function test_PerRoundCap_Reverts() public {
        // ROUND_CAP = 5e18 → 6 recipients (6e18) breaches it.
        address[] memory six = new address[](6);
        for (uint256 i = 0; i < 6; i++) six[i] = address(uint160(0x1000 + i));
        vm.prank(dispatcher);
        vm.expectRevert(abi.encodeWithSelector(TimbAirdropDistributor.RoundCapExceeded.selector, 6 * AMOUNT, ROUND_CAP));
        d.distribute(six, 1);
    }

    function test_TotalCap_Reverts() public {
        // Fill 5e18 in round 1 and 5e18 in round 2 = 10e18 (= totalCap), then a
        // 3rd round of any size must breach totalCap (remaining 0).
        vm.startPrank(dispatcher);
        address[] memory five1 = new address[](5);
        address[] memory five2 = new address[](5);
        for (uint256 i = 0; i < 5; i++) { five1[i] = address(uint160(0x2000 + i)); five2[i] = address(uint160(0x3000 + i)); }
        d.distribute(five1, 1);
        d.distribute(five2, 2);
        assertEq(d.totalDistributed(), TOTAL_CAP);
        vm.expectRevert(abi.encodeWithSelector(TimbAirdropDistributor.TotalCapExceeded.selector, AMOUNT, uint256(0)));
        d.distribute(_batch(alice), 3);
        vm.stopPrank();
    }

    // ─── Access control + pause ────────────────────────────────────────────────────

    function test_OnlyDispatcher() public {
        vm.prank(rando);
        vm.expectRevert(TimbAirdropDistributor.NotDispatcher.selector);
        d.distribute(_batch(alice), 1);
    }

    function test_Pause_BlocksDistribute() public {
        vm.prank(guardian);
        d.setPaused(true);
        vm.prank(dispatcher);
        vm.expectRevert(TimbAirdropDistributor.Paused.selector);
        d.distribute(_batch(alice), 1);
        // Unpause and it flows again.
        vm.prank(guardian);
        d.setPaused(false);
        vm.prank(dispatcher);
        d.distribute(_batch(alice), 1);
        assertTrue(d.isClaimed(1, alice));
    }

    function test_Recover_ReturnsFloat() public {
        uint256 before = timbs.balanceOf(address(this));
        d.recover(address(this), 40e18);
        assertEq(timbs.balanceOf(address(this)), before + 40e18);
    }

    function test_EmptyBatch_Reverts() public {
        vm.prank(dispatcher);
        vm.expectRevert(TimbAirdropDistributor.EmptyBatch.selector);
        d.distribute(new address[](0), 1);
    }
}
