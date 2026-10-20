// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TimbSwapFactory} from "../contracts/TimbSwapFactory.sol";
import {TimbSwapPair} from "../contracts/TimbSwapPair.sol";

contract FacTok is ERC20 {
    constructor(string memory s) ERC20(s, s) {}
}

/**
 * @title TimbSwapFactory — pair creation guards, pause, config setters, views
 */
contract TimbSwapFactoryTest is Test {
    TimbSwapFactory factory;
    FacTok a;
    FacTok b;

    address constant FEE_TO   = address(0xFEE);
    address constant STRANGER = address(0x5747);

    function setUp() public {
        factory = new TimbSwapFactory(FEE_TO);
        a = new FacTok("A");
        b = new FacTok("B");
    }

    function test_ConstructorRejectsZeroFeeTo() public {
        vm.expectRevert(TimbSwapFactory.ZeroAddress.selector);
        new TimbSwapFactory(address(0));
    }

    function test_CreatePairSortsAndIndexes() public {
        address pair = factory.createPair(address(b), address(a));
        (address t0, address t1) = address(a) < address(b) ? (address(a), address(b)) : (address(b), address(a));
        assertEq(TimbSwapPair(pair).token0(), t0);
        assertEq(TimbSwapPair(pair).token1(), t1);
        assertEq(factory.getPair(address(a), address(b)), pair);
        assertEq(factory.getPair(address(b), address(a)), pair);
        assertEq(factory.getPairAddress(address(b), address(a)), pair);
        assertEq(factory.allPairsLength(), 1);
        assertEq(factory.allPairs(0), pair);
    }

    /// CREATE2 with the sorted pair as salt: the address is predictable off-chain.
    function test_PairAddressIsDeterministic() public {
        (address t0, address t1) = address(a) < address(b) ? (address(a), address(b)) : (address(b), address(a));
        bytes32 salt = keccak256(abi.encodePacked(t0, t1));
        bytes32 initHash = keccak256(abi.encodePacked(type(TimbSwapPair).creationCode, abi.encode(t0, t1)));
        address predicted = vm.computeCreate2Address(salt, initHash, address(factory));
        assertEq(factory.createPair(address(a), address(b)), predicted);
    }

    function test_CreatePairGuards() public {
        vm.expectRevert(TimbSwapFactory.IdenticalAddresses.selector);
        factory.createPair(address(a), address(a));
        vm.expectRevert(TimbSwapFactory.ZeroAddress.selector);
        factory.createPair(address(0), address(a));
        vm.expectRevert(TimbSwapFactory.ZeroAddress.selector);
        factory.createPair(address(a), address(0));

        address pair = factory.createPair(address(a), address(b));
        vm.expectRevert(abi.encodeWithSelector(TimbSwapFactory.PairExists.selector, pair));
        factory.createPair(address(b), address(a));
    }

    function test_PauseBlocksCreationOnly() public {
        address pair = factory.createPair(address(a), address(b));
        factory.pause();
        assertTrue(factory.paused());
        FacTok c = new FacTok("C");
        vm.expectRevert(TimbSwapFactory.PairCreationPaused.selector);
        factory.createPair(address(a), address(c));
        // Existing pairs stay registered while paused.
        assertEq(factory.getPair(address(a), address(b)), pair);
        factory.unpause();
        assertFalse(factory.paused());
        factory.createPair(address(a), address(c));
        assertEq(factory.allPairsLength(), 2);
    }

    /// Permissionless creation: anyone may open a pair (as in Uniswap V2).
    function test_AnyoneMayCreatePair() public {
        vm.prank(STRANGER);
        factory.createPair(address(a), address(b));
        assertEq(factory.allPairsLength(), 1);
    }

    function test_Setters() public {
        factory.setFeeTo(address(0xFEE2));
        assertEq(factory.feeTo(), address(0xFEE2));
        factory.setRouter(address(0xE0));
        assertEq(factory.router(), address(0xE0));
        factory.setTimbsToken(address(0x71));
        assertEq(factory.timbsToken(), address(0x71));
        factory.setEmissionsWhitelist(address(0xA1), true);
        assertTrue(factory.isPairEmissionsEligible(address(0xA1)));
        factory.setEmissionsWhitelist(address(0xA1), false);
        assertFalse(factory.isPairEmissionsEligible(address(0xA1)));
    }

    function test_SettersRejectZero() public {
        vm.expectRevert(TimbSwapFactory.ZeroAddress.selector);
        factory.setFeeTo(address(0));
        vm.expectRevert(TimbSwapFactory.ZeroAddress.selector);
        factory.setRouter(address(0));
        vm.expectRevert(TimbSwapFactory.ZeroAddress.selector);
        factory.setTimbsToken(address(0));
        vm.expectRevert(TimbSwapFactory.ZeroAddress.selector);
        factory.setEmissionsWhitelist(address(0), true);
    }

    function test_PartnerPool() public {
        factory.setPartnerPool(address(0xA1), address(0xD1), true);
        (bool active, address dest) = factory.getPartnerConfig(address(0xA1));
        assertTrue(active);
        assertEq(dest, address(0xD1));

        // Deactivating clears the destination whatever is passed.
        factory.setPartnerPool(address(0xA1), address(0xD2), false);
        (active, dest) = factory.getPartnerConfig(address(0xA1));
        assertFalse(active);
        assertEq(dest, address(0));

        vm.expectRevert(TimbSwapFactory.ZeroAddress.selector);
        factory.setPartnerPool(address(0), address(0xD1), true);
        vm.expectRevert(TimbSwapFactory.ZeroAddress.selector);
        factory.setPartnerPool(address(0xA1), address(0), true);
        factory.setPartnerPool(address(0xA1), address(0), false); // inactive needs no destination
    }

    function test_FeeConfig() public view {
        (uint256 total, uint256 lp, uint256 protocol, uint256 denom) = factory.getFeeConfig();
        assertEq(total, 30);
        assertEq(lp, 25);
        assertEq(protocol, 5);
        assertEq(denom, 10_000);
        assertEq(lp + protocol, total);
    }

    function test_AdminIsOwnerOnly() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, STRANGER);
        vm.startPrank(STRANGER);
        vm.expectRevert(err); factory.setFeeTo(STRANGER);
        vm.expectRevert(err); factory.setRouter(STRANGER);
        vm.expectRevert(err); factory.setTimbsToken(STRANGER);
        vm.expectRevert(err); factory.setEmissionsWhitelist(STRANGER, true);
        vm.expectRevert(err); factory.setPartnerPool(STRANGER, STRANGER, true);
        vm.expectRevert(err); factory.pause();
        vm.expectRevert(err); factory.unpause();
        vm.stopPrank();
    }
}
