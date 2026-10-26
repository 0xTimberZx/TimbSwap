// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TimbSwapFactory} from "../contracts/TimbSwapFactory.sol";
import {TimbSwapPair} from "../contracts/TimbSwapPair.sol";
import {TimbSwapRouter} from "../contracts/TimbSwapRouter.sol";

contract RTToken is ERC20 {
    constructor(string memory s) ERC20(s, s) { _mint(msg.sender, 1e30); }
}

contract RTWETH is ERC20 {
    constructor() ERC20("WETH", "WETH") {}
    function deposit() public payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 a) external { _burn(msg.sender, a); payable(msg.sender).transfer(a); }
    receive() external payable { deposit(); }
}

/**
 * TS-073 — a multi-hop swap cannot pay its output into a token on its own route.
 *
 * A pair rejects only its own two tokens, and the TS-072 route loop compared
 * `to` with the route's pairs only. On a path [A, B, C] the last pair (B/C)
 * knows nothing of A, so `to = A` paid every C into the A token contract,
 * which has no exit, while the single-hop version of the same mistake
 * reverted at the pair. The router now rejects every token on the route.
 *
 * Run: forge test --match-contract RouteTokenRecipientTest -vvv
 */
contract RouteTokenRecipientTest is Test {
    RTToken a;
    RTToken b;
    RTToken c;
    RTToken d;
    RTWETH  weth;
    TimbSwapFactory factory;
    TimbSwapRouter  router;
    address ab;
    uint256 dl;

    function setUp() public {
        a = new RTToken("A");
        b = new RTToken("B");
        c = new RTToken("C");
        d = new RTToken("D");
        weth    = new RTWETH();
        factory = new TimbSwapFactory(address(0x7EA5));
        router  = new TimbSwapRouter(address(factory), address(0x7EA5), address(0), address(0), address(weth));
        factory.setRouter(address(router));
        dl = block.timestamp;
        a.approve(address(router), type(uint256).max);
        b.approve(address(router), type(uint256).max);
        c.approve(address(router), type(uint256).max);
        d.approve(address(router), type(uint256).max);
        router.addLiquidity(address(a), address(b), 100 ether, 100 ether, 0, 0, address(this), dl);
        router.addLiquidity(address(b), address(c), 100 ether, 100 ether, 0, 0, address(this), dl);
        router.addLiquidity(address(c), address(d), 100 ether, 100 ether, 0, 0, address(this), dl);
        ab = factory.getPair(address(a), address(b));
    }

    function _p3(address x, address y, address z) internal pure returns (address[] memory p) {
        p = new address[](3);
        (p[0], p[1], p[2]) = (x, y, z);
    }

    function _p4(address w, address x, address y, address z) internal pure returns (address[] memory p) {
        p = new address[](4);
        (p[0], p[1], p[2], p[3]) = (w, x, y, z);
    }

    /// Control: the single-hop version of the mistake always reverted, at the pair.
    function test_TS073_SingleHopToTokenInRevertsAtPair() public {
        vm.expectRevert(abi.encodeWithSelector(TimbSwapPair.InvalidTo.selector, address(a)));
        router.swapExactTokensForTokens(1 ether, 0, address(a), address(b), address(a), dl, false);
    }

    /// The reported case: `to` = the first token of a two-hop route.
    function test_TS073_ExactInToFirstRouteTokenReverts() public {
        uint256 strandedBefore = c.balanceOf(address(a));
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidTo.selector, address(a)));
        router.swapExactTokensForTokensPath(1 ether, 0, _p3(address(a), address(b), address(c)), address(a), dl, false);
        assertEq(c.balanceOf(address(a)), strandedBefore, "nothing paid into the token contract");
    }

    function test_TS073_ExactOutToFirstRouteTokenReverts() public {
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidTo.selector, address(a)));
        router.swapTokensForExactTokensPath(0.5 ether, 2 ether, _p3(address(a), address(b), address(c)), address(a), dl, false);
    }

    /// On a three-hop route the first two tokens are unknown to the last pair (C/D).
    function test_TS073_FourTokenRouteEarlierTokensRevert() public {
        address[] memory p = _p4(address(a), address(b), address(c), address(d));
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidTo.selector, address(a)));
        router.swapExactTokensForTokensPath(1 ether, 0, p, address(a), dl, false);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidTo.selector, address(b)));
        router.swapExactTokensForTokensPath(1 ether, 0, p, address(b), dl, false);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidTo.selector, address(b)));
        router.swapTokensForExactTokensPath(0.5 ether, 2 ether, p, address(b), dl, false);
    }

    /// The last pair's own tokens are rejected on every route: the router
    /// catches path[n-2], the pair catches path[n-1].
    function test_TS073_LastPairTokensStillRejected() public {
        address[] memory p = _p3(address(a), address(b), address(c));
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidTo.selector, address(b)));
        router.swapExactTokensForTokensPath(1 ether, 0, p, address(b), dl, false);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapPair.InvalidTo.selector, address(c)));
        router.swapExactTokensForTokensPath(1 ether, 0, p, address(c), dl, false);
    }

    /// Control: a token that is not on the route is not the router's to judge.
    function test_TS073_OffRouteAddressStillPays() public {
        address someone = address(0xBEEF);
        router.swapExactTokensForTokensPath(1 ether, 0, _p4(address(a), address(b), address(c), address(d)), someone, dl, false);
        assertGt(d.balanceOf(someone), 0);
    }
}
