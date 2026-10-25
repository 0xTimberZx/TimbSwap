// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TimbSwapFactory} from "../contracts/TimbSwapFactory.sol";
import {TimbSwapRouter} from "../contracts/TimbSwapRouter.sol";

contract RWToken is ERC20 {
    constructor() ERC20("A", "A") { _mint(msg.sender, 1e30); }
}

/// @dev aeWETH-shaped (Arbitrum One's canonical WETH): plain ETH sent to it is
///      deposited for the SENDER, and withdraw pays out with `transfer`.
contract RWWETH is ERC20 {
    constructor() ERC20("WETH", "WETH") {}
    function deposit() public payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 a) external { _burn(msg.sender, a); payable(msg.sender).transfer(a); }
    receive() external payable { deposit(); }
}

/**
 * TS-068 — the router rejects WETH as a recipient.
 *
 * TS-062 rejected the router itself but not WETH. On an ETH-out call
 * (swapExactTokensForETH, removeLiquidityETH) with `to = WETH`, the router
 * unwrapped the output and sent the ETH to WETH, whose receive() deposits for
 * the sender, i.e. the router, which has no token exit. Every entry point now
 * reverts InvalidTo(weth).
 *
 * Run: forge test --match-contract RouterWethRecipientTest -vvv
 */
contract RouterWethRecipientTest is Test {
    RWToken a;
    RWWETH  weth;
    TimbSwapFactory factory;
    TimbSwapRouter  router;
    address r;
    address w;
    uint256 dl;

    function setUp() public {
        a       = new RWToken();
        weth    = new RWWETH();
        factory = new TimbSwapFactory(address(0x7EA5));
        router  = new TimbSwapRouter(address(factory), address(0x7EA5), address(0), address(0), address(weth));
        factory.setRouter(address(router));
        r  = address(router);
        w  = address(weth);
        dl = block.timestamp;
        a.approve(r, type(uint256).max);
        router.addLiquidityETH{value: 100 ether}(address(a), 100 ether, 0, 0, address(this), dl);
    }

    function _expectInvalidWeth() internal {
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidTo.selector, w));
    }

    function test_TS068_EthOutToWethReverts() public {
        _expectInvalidWeth(); router.swapExactTokensForETH(1 ether, 0, address(a), w, dl, false);

        address pair = factory.getPair(address(a), w);
        ERC20(pair).approve(r, type(uint256).max);
        _expectInvalidWeth(); router.removeLiquidityETH(address(a), 1 ether, 0, 0, w, dl);

        assertEq(weth.balanceOf(r) + r.balance, 0, "router holds no ETH or WETH");
    }

    function test_TS068_TokenOutToWethReverts() public {
        _expectInvalidWeth(); router.swapExactETHForTokens{value: 1 ether}(1 ether, 0, address(a), w, dl, false);
        _expectInvalidWeth(); router.swapExactTokensForTokens(1 ether, 0, address(a), w, w, dl, false);
    }

    /// Control: the same ETH-out calls to an ordinary recipient still pay out.
    function test_TS068_EthOutToUserStillWorks() public {
        address user = address(0xBEEF);
        uint256 before = user.balance;
        router.swapExactTokensForETH(1 ether, 0, address(a), user, dl, false);
        assertGt(user.balance, before, "user got ETH");
        assertEq(weth.balanceOf(r) + r.balance, 0, "router holds nothing");
    }

    receive() external payable {}
}
