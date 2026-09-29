// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TimbSwapFactory} from "../contracts/TimbSwapFactory.sol";
import {TimbSwapPair} from "../contracts/TimbSwapPair.sol";

contract SelfTok is ERC20 {
    constructor(string memory s) ERC20(s, s) { _mint(msg.sender, 1e30); }
}

/// @notice Hardening: the pair refuses to mint or burn LP to its own address,
///         so a depositor can't strand LP where anyone could burn it.
contract PairSelfRecipientTest is Test {
    TimbSwapPair pair;
    SelfTok a;
    SelfTok b;

    function setUp() public {
        a = new SelfTok("A");
        b = new SelfTok("B");
        TimbSwapFactory factory = new TimbSwapFactory(address(0xFEE));
        pair = TimbSwapPair(factory.createPair(address(a), address(b)));
        a.transfer(address(pair), 100 ether);
        b.transfer(address(pair), 100 ether);
    }

    function test_MintToPairReverts() public {
        vm.expectRevert(abi.encodeWithSelector(TimbSwapPair.InvalidTo.selector, address(pair)));
        pair.mint(address(pair));
        pair.mint(address(this)); // a normal recipient still works
        assertGt(pair.balanceOf(address(this)), 0);
    }

    function test_BurnToPairReverts() public {
        pair.mint(address(this));
        pair.transfer(address(pair), pair.balanceOf(address(this)));
        vm.expectRevert(abi.encodeWithSelector(TimbSwapPair.InvalidTo.selector, address(pair)));
        pair.burn(address(pair));
    }
}
