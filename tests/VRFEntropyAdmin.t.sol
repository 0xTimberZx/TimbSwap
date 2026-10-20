// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../contracts/VRFEntropy.sol";

/// Coordinator that records the last request so the policy fields can be checked.
contract RecordingCoordinator is IVRFCoordinatorV2Plus {
    uint256 public nextId = 1;
    RandomWordsRequest public last;
    function requestRandomWords(RandomWordsRequest calldata req) external returns (uint256) {
        last = req;
        return nextId++;
    }
    function fulfil(VRFEntropy e, uint256 id, uint256[] memory words) external {
        e.rawFulfillRandomWords(id, words);
    }
}

/**
 * @title VRFEntropy — request/fulfil lifecycle, views, policy setters, gating
 */
contract VRFEntropyAdminTest is Test {
    RecordingCoordinator coord;
    VRFEntropy entropy;

    address constant BOARD    = address(0xB0A4D);
    address constant STRANGER = address(0x5747);
    bytes32 constant SALT     = keccak256("round1-seg1");

    function setUp() public {
        coord   = new RecordingCoordinator();
        entropy = new VRFEntropy(address(coord), bytes32(uint256(0xAB)), 7, 3, 200_000, hex"01");
        entropy.setBoard(BOARD);
    }

    function _one(uint256 w) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = w;
    }

    function test_ConstructorRejectsZeroCoordinator() public {
        vm.expectRevert(VRFEntropy.ZeroAddress.selector);
        new VRFEntropy(address(0), bytes32(0), 1, 3, 200_000, "");
    }

    function test_SetBoardOnceOnly() public {
        vm.expectRevert(VRFEntropy.BoardAlreadySet.selector);
        entropy.setBoard(address(0xB2));
        VRFEntropy fresh = new VRFEntropy(address(coord), bytes32(0), 1, 3, 200_000, "");
        vm.expectRevert(VRFEntropy.ZeroAddress.selector);
        fresh.setBoard(address(0));
    }

    function test_OnlyBoardRequests() public {
        vm.prank(STRANGER);
        vm.expectRevert(VRFEntropy.NotBoard.selector);
        entropy.requestFor(SALT);
    }

    function test_RequestUsesPolicyAndCannotRepeat() public {
        vm.prank(BOARD);
        uint256 id = entropy.requestFor(SALT);
        (bytes32 kh, uint256 sub, uint16 conf, uint32 gas, uint32 n, bytes memory extra) = coord.last();
        assertEq(kh, bytes32(uint256(0xAB)));
        assertEq(sub, 7);
        assertEq(conf, 3);
        assertEq(gas, 200_000);
        assertEq(n, 1);
        assertEq(extra, hex"01");
        assertEq(entropy.saltOf(id), SALT);
        assertTrue(entropy.isRequested(SALT));
        assertFalse(entropy.isReady(SALT));

        vm.prank(BOARD);
        vm.expectRevert(abi.encodeWithSelector(VRFEntropy.AlreadyRequested.selector, SALT));
        entropy.requestFor(SALT);
    }

    function test_FulfilThenEntropyIsSaltBound() public {
        vm.prank(BOARD);
        uint256 id = entropy.requestFor(SALT);
        vm.expectRevert(abi.encodeWithSelector(VRFEntropy.NotReady.selector, SALT));
        entropy.entropyFor(SALT);

        coord.fulfil(entropy, id, _one(42));
        assertTrue(entropy.isReady(SALT));
        assertEq(entropy.entropyFor(SALT), keccak256(abi.encodePacked(uint256(42), SALT)));

        // Final: no new request, no replacement.
        vm.prank(BOARD);
        vm.expectRevert(abi.encodeWithSelector(VRFEntropy.AlreadyFulfilled.selector, SALT));
        entropy.requestFor(SALT);
        vm.expectRevert(abi.encodeWithSelector(VRFEntropy.AlreadyFulfilled.selector, SALT));
        entropy.rerequest(SALT);
    }

    function test_FulfilGuards() public {
        vm.prank(STRANGER);
        vm.expectRevert(VRFEntropy.NotCoordinator.selector);
        entropy.rawFulfillRandomWords(1, _one(1));

        vm.expectRevert(VRFEntropy.NoWords.selector);
        coord.fulfil(entropy, 1, new uint256[](0));

        vm.expectRevert(abi.encodeWithSelector(VRFEntropy.UnknownRequest.selector, 99));
        coord.fulfil(entropy, 99, _one(1));
    }

    /// A replaced request that lands after the replacement is ignored: the first
    /// word to land is final.
    function test_LateReplacedWordIgnored() public {
        vm.prank(BOARD);
        uint256 first = entropy.requestFor(SALT);
        vm.warp(block.timestamp + entropy.REREQUEST_DELAY());
        uint256 second = entropy.rerequest(SALT);

        coord.fulfil(entropy, second, _one(7));
        coord.fulfil(entropy, first, _one(8)); // no revert, no overwrite
        assertEq(entropy.entropyFor(SALT), keccak256(abi.encodePacked(uint256(7), SALT)));
    }

    function test_RerequestGuardsAndReplaceable() public {
        vm.expectRevert(abi.encodeWithSelector(VRFEntropy.NothingPending.selector, SALT));
        entropy.rerequest(SALT);
        assertFalse(entropy.replaceable(SALT), "nothing requested");

        vm.prank(BOARD);
        entropy.requestFor(SALT);
        (, , uint64 at,) = entropy.draws(SALT);
        assertFalse(entropy.replaceable(SALT), "too soon");
        vm.expectRevert(abi.encodeWithSelector(VRFEntropy.TooSoonToReplace.selector, SALT, at));
        entropy.rerequest(SALT);

        vm.warp(block.timestamp + entropy.REREQUEST_DELAY());
        assertTrue(entropy.replaceable(SALT));
    }

    function test_OwnerBypassesPublicRerequestCap() public {
        vm.prank(BOARD);
        entropy.requestFor(SALT);
        for (uint256 i = 0; i < entropy.MAX_PUBLIC_REREQUESTS() + 2; i++) {
            vm.warp(block.timestamp + entropy.REREQUEST_DELAY());
            entropy.rerequest(SALT); // the owner (this) is uncapped
        }
        assertEq(entropy.rerequestCount(SALT), 5);
    }

    function test_PolicySettersApplyToNextRequest() public {
        entropy.setPolicy(bytes32(uint256(0xCD)), 9, 5, 300_000);
        entropy.setExtraArgs(hex"0203");
        assertEq(entropy.keyHash(), bytes32(uint256(0xCD)));
        assertEq(entropy.subId(), 9);
        assertEq(entropy.requestConfirmations(), 5);
        assertEq(entropy.callbackGasLimit(), 300_000);
        assertEq(entropy.extraArgs(), hex"0203");

        vm.prank(BOARD);
        entropy.requestFor(SALT);
        (bytes32 kh, uint256 sub, uint16 conf, uint32 gas,, bytes memory extra) = coord.last();
        assertEq(kh, bytes32(uint256(0xCD)));
        assertEq(sub, 9);
        assertEq(conf, 5);
        assertEq(gas, 300_000);
        assertEq(extra, hex"0203");
    }

    function test_AdminIsOwnerOnly() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, STRANGER);
        vm.startPrank(STRANGER);
        vm.expectRevert(err); entropy.setPolicy(bytes32(0), 1, 1, 1);
        vm.expectRevert(err); entropy.setExtraArgs("");
        vm.expectRevert(err); entropy.setBoard(STRANGER);
        vm.stopPrank();
    }
}
