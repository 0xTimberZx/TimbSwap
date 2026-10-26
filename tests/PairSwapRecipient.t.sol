// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TimbSwapFactory} from "../contracts/TimbSwapFactory.sol";
import {TimbSwapPair} from "../contracts/TimbSwapPair.sol";
import {TimbSwapRouter} from "../contracts/TimbSwapRouter.sol";

contract PSToken is ERC20 {
    constructor(string memory s) ERC20(s, s) { _mint(msg.sender, 1e30); }
}

contract PSWETH is ERC20 {
    constructor() ERC20("WETH", "WETH") {}
    function deposit() public payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 a) external { _burn(msg.sender, a); payable(msg.sender).transfer(a); }
    receive() external payable { deposit(); }
}

/**
 * TS-072 — a swap cannot pay its output into a pair on its own route.
 *
 * TimbSwapPair.swap() rejected only its two tokens, while mint() and burn()
 * also reject the pair itself. Output sent back into the pair is counted as
 * input there, so the swap cleared K and the caller's real input was absorbed
 * into the reserves, a donation to the LPs. The router's recipient check
 * (TS-062/TS-068) did not cover pairs either. The pair now rejects itself in
 * swap(); the router rejects any pair on the route before it calls one, which
 * also covers deployed pairs that predate the pair's own check.
 *
 * Run: forge test --match-contract PairSwapRecipientTest -vvv
 */
contract PairSwapRecipientTest is Test {
    PSToken a;
    PSToken b;
    PSToken c;
    PSWETH  weth;
    TimbSwapFactory factory;
    TimbSwapRouter  router;
    address ab;
    address bc;
    address aw;
    uint256 dl;

    function setUp() public {
        a = new PSToken("A");
        b = new PSToken("B");
        c = new PSToken("C");
        weth    = new PSWETH();
        factory = new TimbSwapFactory(address(0x7EA5));
        router  = new TimbSwapRouter(address(factory), address(0x7EA5), address(0), address(0), address(weth));
        factory.setRouter(address(router));
        dl = block.timestamp;
        a.approve(address(router), type(uint256).max);
        b.approve(address(router), type(uint256).max);
        c.approve(address(router), type(uint256).max);
        router.addLiquidity(address(a), address(b), 100 ether, 100 ether, 0, 0, address(this), dl);
        router.addLiquidity(address(b), address(c), 100 ether, 100 ether, 0, 0, address(this), dl);
        router.addLiquidityETH{value: 100 ether}(address(a), 100 ether, 0, 0, address(this), dl);
        ab = factory.getPair(address(a), address(b));
        bc = factory.getPair(address(b), address(c));
        aw = factory.getPair(address(a), address(weth));
    }

    function _path(address x, address y, address z) internal pure returns (address[] memory p) {
        p = new address[](3);
        (p[0], p[1], p[2]) = (x, y, z);
    }

    function _out(address pair, address tokenOut, uint256 amt) internal view returns (uint256 a0, uint256 a1) {
        return TimbSwapPair(pair).token0() == tokenOut ? (amt, uint256(0)) : (uint256(0), amt);
    }

    // ─── The pair ───────────────────────────────────────────────────────────

    function test_TS072_PairSwapToItselfReverts() public {
        a.transfer(ab, 1 ether);
        (uint256 o0, uint256 o1) = _out(ab, address(b), 0.9 ether);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapPair.InvalidTo.selector, ab));
        TimbSwapPair(ab).swap(o0, o1, ab);

        // Control: the same swap to the caller pays out.
        uint256 before = b.balanceOf(address(this));
        TimbSwapPair(ab).swap(o0, o1, address(this));
        assertEq(b.balanceOf(address(this)), before + 0.9 ether);
    }

    // ─── The router: rejected before any pair is called ─────────────────────

    function test_TS072_RouterSingleHopToPairReverts() public {
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidTo.selector, ab));
        router.swapExactTokensForTokens(1 ether, 0, address(a), address(b), ab, dl, false);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidTo.selector, aw));
        router.swapExactETHForTokens{value: 1 ether}(1 ether, 0, address(a), aw, dl, false);
    }

    /// The router refuses on its own, so a deployed pair without the pair-side
    /// check is covered too: the pair's swap() is never reached.
    function test_TS072_RouterNeverCallsThePair() public {
        vm.expectCall(ab, abi.encodeWithSelector(TimbSwapPair.swap.selector), 0);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidTo.selector, ab));
        router.swapExactTokensForTokens(1 ether, 0, address(a), address(b), ab, dl, false);
    }

    /// `to` = an earlier pair on the route: the last pair (b/c) would accept
    /// it, since it is not that pair itself.
    function test_TS072_RouterEarlierPairOnRouteReverts() public {
        uint256 abA = a.balanceOf(ab);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidTo.selector, ab));
        router.swapExactTokensForTokensPath(1 ether, 0, _path(address(a), address(b), address(c)), ab, dl, false);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidTo.selector, ab));
        router.swapTokensForExactTokensPath(0.5 ether, 2 ether, _path(address(a), address(b), address(c)), ab, dl, false);
        assertEq(a.balanceOf(ab), abA, "nothing donated");
    }

    function test_TS072_RouterLastPairOnRouteReverts() public {
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidTo.selector, bc));
        router.swapExactTokensForTokensPath(1 ether, 0, _path(address(a), address(b), address(c)), bc, dl, false);
    }

    /// Control: a two-hop swap to the caller still works; the intermediate
    /// hop pays the next pair as before.
    function test_TS072_RouterNormalRouteStillWorks() public {
        uint256 before = c.balanceOf(address(this));
        router.swapExactTokensForTokensPath(1 ether, 0, _path(address(a), address(b), address(c)), address(this), dl, false);
        assertGt(c.balanceOf(address(this)), before);
    }
}
