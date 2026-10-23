// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TimbSwapFactory} from "../contracts/TimbSwapFactory.sol";
import {TimbSwapRouter} from "../contracts/TimbSwapRouter.sol";

contract RRToken is ERC20 {
    constructor(string memory n) ERC20(n, n) { _mint(msg.sender, 1e30); }
}

/// @dev WETH9-shaped: withdraw pays out with `transfer`.
contract RRWETH is ERC20 {
    constructor() ERC20("WETH", "WETH") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 a) external { _burn(msg.sender, a); payable(msg.sender).transfer(a); }
    receive() external payable {}
}

/**
 * TS-062 — the router rejects itself as a recipient.
 *
 * Every swap and liquidity entry point passed `to` through unchecked. The
 * pair only rejects its own tokens and itself, so `to = router` succeeded
 * and the output (or the LP tokens, or the withdrawn liquidity) landed in a
 * contract with no token exit. TS-048 closed the ETH side only. Each entry
 * point now reverts InvalidTo(router) instead.
 *
 * Run: forge test --match-contract RouterRecipientGuardTest -vvv
 */
contract RouterRecipientGuardTest is Test {
    RRToken a;
    RRToken b;
    RRWETH  weth;
    TimbSwapFactory factory;
    TimbSwapRouter  router;
    address r;
    uint256 dl;

    function setUp() public {
        a       = new RRToken("A");
        b       = new RRToken("B");
        weth    = new RRWETH();
        factory = new TimbSwapFactory(address(0x7EA5));
        router  = new TimbSwapRouter(address(factory), address(0x7EA5), address(0), address(0), address(weth));
        factory.setRouter(address(router));
        r  = address(router);
        dl = block.timestamp;
        a.approve(r, type(uint256).max);
        b.approve(r, type(uint256).max);
        router.addLiquidity(address(a), address(b), 100 ether, 100 ether, 0, 0, address(this), dl);
        router.addLiquidityETH{value: 100 ether}(address(a), 100 ether, 0, 0, address(this), dl);
    }

    function _path() internal view returns (address[] memory p) {
        p = new address[](2);
        p[0] = address(a);
        p[1] = address(b);
    }

    function _expectInvalidTo() internal {
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidTo.selector, r));
    }

    function test_TS062_TokenSwapsToRouterRevert() public {
        _expectInvalidTo(); router.swapExactTokensForTokens(1 ether, 0, address(a), address(b), r, dl, false);
        _expectInvalidTo(); router.swapTokensForExactTokens(1 ether, 2 ether, address(a), address(b), r, dl, false);
        _expectInvalidTo(); router.swapExactTokensForTokensPath(1 ether, 0, _path(), r, dl, false);
        _expectInvalidTo(); router.swapTokensForExactTokensPath(1 ether, 2 ether, _path(), r, dl, false);
        _expectInvalidTo(); router.swapExactTokensForTokens(1 ether, 0, address(a), address(weth), r, dl, false);
        _expectInvalidTo(); router.swapExactETHForTokens{value: 1 ether}(1 ether, 0, address(a), r, dl, false);
        _expectInvalidTo(); router.swapExactTokensForETH(1 ether, 0, address(a), r, dl, false);
        assertEq(a.balanceOf(r) + b.balanceOf(r) + weth.balanceOf(r) + r.balance, 0, "router holds nothing");
    }

    function test_TS062_LiquidityToRouterReverts() public {
        address abPair  = factory.getPair(address(a), address(b));
        address awPair  = factory.getPair(address(a), address(weth));
        ERC20(abPair).approve(r, type(uint256).max);
        ERC20(awPair).approve(r, type(uint256).max);
        _expectInvalidTo(); router.addLiquidity(address(a), address(b), 1 ether, 1 ether, 0, 0, r, dl);
        _expectInvalidTo(); router.addLiquidityETH{value: 1 ether}(address(a), 1 ether, 0, 0, r, dl);
        _expectInvalidTo(); router.removeLiquidity(address(a), address(b), 1 ether, 0, 0, r, dl);
        _expectInvalidTo(); router.removeLiquidityETH(address(a), 1 ether, 0, 0, r, dl);
        assertEq(ERC20(abPair).balanceOf(r) + ERC20(awPair).balanceOf(r), 0, "no LP stranded");
    }

    /// Control: a normal recipient still works on every path, including the
    /// ETH-out paths that route through the router internally.
    function test_TS062_NormalRecipientUnchanged() public {
        address u = address(0xCAFE);
        router.swapExactTokensForTokens(1 ether, 0, address(a), address(b), u, dl, false);
        router.swapTokensForExactTokens(0.5 ether, 2 ether, address(a), address(b), u, dl, false);
        router.swapExactTokensForTokensPath(1 ether, 0, _path(), u, dl, false);
        router.swapTokensForExactTokensPath(0.5 ether, 2 ether, _path(), u, dl, false);
        router.swapExactETHForTokens{value: 1 ether}(1 ether, 0, address(a), u, dl, false);
        router.swapExactTokensForETH(1 ether, 0, address(a), u, dl, false);
        assertGt(b.balanceOf(u), 0);
        assertGt(a.balanceOf(u), 0);
        assertGt(u.balance, 0);

        address awPair = factory.getPair(address(a), address(weth));
        ERC20(awPair).approve(r, type(uint256).max);
        uint256 eth = u.balance;
        router.removeLiquidityETH(address(a), 1 ether, 0, 0, u, dl);
        assertGt(u.balance, eth, "removeLiquidityETH still unwraps to the user");
        assertEq(a.balanceOf(r) + b.balanceOf(r) + weth.balanceOf(r) + r.balance, 0, "router holds nothing between txs");
    }

    function test_TS062_ZeroAddressStillRejected() public {
        vm.expectRevert(TimbSwapRouter.ZeroAddress.selector);
        router.swapExactTokensForTokens(1 ether, 0, address(a), address(b), address(0), dl, false);
    }

    receive() external payable {}
}
