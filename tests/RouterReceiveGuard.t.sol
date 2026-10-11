// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TimbSwapFactory} from "../contracts/TimbSwapFactory.sol";
import {TimbSwapRouter} from "../contracts/TimbSwapRouter.sol";

contract RGToken is ERC20 {
    constructor() ERC20("T", "T") { _mint(msg.sender, 1e30); }
}

/// @dev WETH9-shaped: withdraw pays out with `transfer`, i.e. the 2300-gas
///      stipend the router's receive() must fit inside.
contract RGWETH is ERC20 {
    constructor() ERC20("WETH", "WETH") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 a) external { _burn(msg.sender, a); payable(msg.sender).transfer(a); }
    receive() external payable {}
}

/**
 * TS-048 — the router accepts ETH only from WETH.
 *
 * receive() was wide open, so ETH sent straight to the router (a fat-fingered
 * transfer) was accepted and had no exit. The reference V2 router only takes
 * ETH from WETH; ours now does the same, so a direct send reverts instead of
 * locking the sender's ETH, and no owner sweep is needed.
 *
 * Run: forge test --match-contract RouterReceiveGuardTest -vvv
 */
contract RouterReceiveGuardTest is Test {
    RGToken token;
    RGWETH  weth;
    TimbSwapFactory factory;
    TimbSwapRouter  router;
    address user = address(0xCAFE);

    function setUp() public {
        token   = new RGToken();
        weth    = new RGWETH();
        factory = new TimbSwapFactory(address(0x7EA5));
        router  = new TimbSwapRouter(address(factory), address(0x7EA5), address(0), address(0), address(weth));
        factory.setRouter(address(router));
        token.approve(address(router), type(uint256).max);
        router.addLiquidityETH{value: 100 ether}(address(token), 100 ether, 0, 0, address(this), block.timestamp);
        vm.deal(user, 10 ether);
    }

    function test_TS048_DirectSendReverts() public {
        vm.prank(user);
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertFalse(ok, "direct ETH to the router must revert");
        assertEq(address(router).balance, 0, "nothing stuck");
        assertEq(user.balance, 10 ether, "sender keeps the ETH");
    }

    function test_TS048_UnwrapPathsStillWork() public {
        // Tokens -> ETH: WETH.withdraw pays the router via transfer (2300 gas).
        token.transfer(user, 1 ether);
        vm.startPrank(user);
        token.approve(address(router), type(uint256).max);
        uint256 before = user.balance;
        router.swapExactTokensForETH(1 ether, 0, address(token), user, block.timestamp, false);
        vm.stopPrank();
        assertGt(user.balance, before, "ETH delivered through the unwrap path");

        // LP -> token + ETH: same unwrap, same stipend.
        address pair = factory.getPair(address(token), address(weth));
        uint256 liq  = ERC20(pair).balanceOf(address(this));
        ERC20(pair).approve(address(router), liq);
        uint256 mine = address(this).balance;
        router.removeLiquidityETH(address(token), liq, 0, 0, address(this), block.timestamp);
        assertGt(address(this).balance, mine, "ETH delivered on removeLiquidityETH");
        assertEq(address(router).balance, 0, "router holds nothing between txs");
    }

    function test_TS048_ExcessEthRefundStillWorks() public {
        vm.prank(user);
        router.swapExactETHForTokens{value: 2 ether}(1 ether, 0, address(token), user, block.timestamp, false);
        assertEq(user.balance, 9 ether, "1 ETH spent, 1 ETH refunded");
        assertEq(address(router).balance, 0);
    }

    receive() external payable {}
}
