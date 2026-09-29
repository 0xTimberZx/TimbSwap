// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TimbSwapFactory} from "../contracts/TimbSwapFactory.sol";
import {TimbSwapRouter} from "../contracts/TimbSwapRouter.sol";

contract NFToken is ERC20 {
    constructor(string memory n) ERC20(n, n) { _mint(msg.sender, 1e30); }
}

contract NFPrize {
    uint256 public nudged;
    function nudgeScroll() external { nudged++; }
    function isSettlementWindow() external pure returns (bool) { return false; }
    function currentRound() external pure returns (uint256) { return 1; }
    function currentSegment() external pure returns (uint256) { return 1; }
}

contract NFRegistry {
    function isEligible(address) external pure returns (bool) { return true; }
}

/**
 * @title Swap nudges need a minimum input (TS-009)
 * @notice A 1-wei swap used to earn the full swapNudgeWeight, so the meter
 *         could be driven for gas alone. Now only swaps at or above the input
 *         token's floor earn nudges; tokens without a floor earn none.
 */
contract RouterNudgeFloorTest is Test {
    TimbSwapRouter router;
    NFPrize prize;
    NFToken weth;   // stands in for WETH (router's weth address)
    NFToken other;  // an eligible token with no floor configured
    NFToken out;

    function setUp() public {
        weth  = new NFToken("WETH");
        other = new NFToken("OTHER");
        out   = new NFToken("OUT");
        prize = new NFPrize();
        TimbSwapFactory factory = new TimbSwapFactory(address(this));
        router = new TimbSwapRouter(address(factory), address(0x7EA5), address(new NFRegistry()), address(prize), address(weth));
        factory.setRouter(address(router));
        weth.approve(address(router), type(uint256).max);
        other.approve(address(router), type(uint256).max);
        out.approve(address(router), type(uint256).max);
        router.addLiquidity(address(weth), address(out), 1000 ether, 1000 ether, 0, 0, address(this), block.timestamp);
        router.addLiquidity(address(other), address(out), 1000 ether, 1000 ether, 0, 0, address(this), block.timestamp);
    }

    function _swap(address tokenIn, uint256 amt) internal {
        router.swapExactTokensForTokens(amt, 0, tokenIn, address(out), address(this), block.timestamp, true);
    }

    function test_WethFloorSeededAtConstruction() public view {
        assertEq(router.minNudgeAmountIn(address(weth)), router.DEFAULT_WETH_NUDGE_FLOOR());
    }

    function test_DustSwapsEarnNoNudges() public {
        for (uint256 i = 0; i < 20; i++) _swap(address(weth), 1e6); // far below the floor
        assertEq(prize.nudged(), 0, "dust swaps must not move the meter");
    }

    function test_SwapAtFloorEarnsFullWeight() public {
        _swap(address(weth), router.DEFAULT_WETH_NUDGE_FLOOR());
        assertEq(prize.nudged(), router.swapNudgeWeight());
    }

    function test_TokenWithoutFloorEarnsNone() public {
        _swap(address(other), 10 ether);
        assertEq(prize.nudged(), 0, "unconfigured token earns no nudges");
    }

    function test_OwnerCanSetFloor() public {
        router.setMinNudgeAmountIn(address(other), 1 ether);
        _swap(address(other), 0.5 ether);
        assertEq(prize.nudged(), 0);
        _swap(address(other), 1 ether);
        assertEq(prize.nudged(), router.swapNudgeWeight());
    }

    function test_SetFloor_OnlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert();
        router.setMinNudgeAmountIn(address(other), 1);
    }
}
