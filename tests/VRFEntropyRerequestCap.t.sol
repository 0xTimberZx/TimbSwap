// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../contracts/VRFEntropy.sol";

// Coordinator that never fulfils: every request stays pending (a VRF outage).
contract StalledCoordinator is IVRFCoordinatorV2Plus {
    uint256 public requests;
    function requestRandomWords(RandomWordsRequest calldata) external returns (uint256) {
        return ++requests;
    }
}

/**
 * @title VRFEntropy — permissionless rerequest cap (TS-005)
 */
contract VRFEntropyRerequestCapTest is Test {
    StalledCoordinator coord;
    VRFEntropy entropy;

    address constant BOARD    = address(0xB0A4D);
    address constant STRANGER = address(0x5747);
    bytes32 constant SALT     = keccak256("round1-seg1");

    function setUp() public {
        coord   = new StalledCoordinator();
        entropy = new VRFEntropy(address(coord), bytes32(0), 1, 3, 200_000, "");
        entropy.setBoard(BOARD);
        vm.prank(BOARD);
        entropy.requestFor(SALT);
    }

    function _replace(address who) internal {
        vm.warp(block.timestamp + entropy.REREQUEST_DELAY());
        vm.prank(who);
        entropy.rerequest(SALT);
    }

    function test_AnyoneMayReplaceUpToCap() public {
        for (uint256 i = 0; i < entropy.MAX_PUBLIC_REREQUESTS(); i++) _replace(STRANGER);
        assertEq(entropy.rerequestCount(SALT), 3);
        assertEq(coord.requests(), 4, "1 original + 3 replacements");
    }

    function test_StrangerBlockedPastCap() public {
        for (uint256 i = 0; i < 3; i++) _replace(STRANGER);
        vm.warp(block.timestamp + entropy.REREQUEST_DELAY());
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(VRFEntropy.RerequestCapReached.selector, SALT, 3));
        entropy.rerequest(SALT);
    }

    function test_BoardPathAlsoCapped() public {
        // TimbPrize.rearmSegment is a permissionless proxy, so the board gets no
        // exemption.
        for (uint256 i = 0; i < 3; i++) _replace(BOARD);
        vm.warp(block.timestamp + entropy.REREQUEST_DELAY());
        vm.prank(BOARD);
        vm.expectRevert(abi.encodeWithSelector(VRFEntropy.RerequestCapReached.selector, SALT, 3));
        entropy.rerequest(SALT);
    }

    function test_OwnerCanReplacePastCap() public {
        for (uint256 i = 0; i < 3; i++) _replace(STRANGER);
        _replace(address(this)); // owner
        assertEq(entropy.rerequestCount(SALT), 4);
        assertEq(coord.requests(), 5);
    }

    function test_DelayStillApplies() public {
        vm.prank(STRANGER);
        vm.expectRevert();
        entropy.rerequest(SALT);
    }
}
