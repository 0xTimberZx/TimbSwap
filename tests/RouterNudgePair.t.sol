// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TimbSwapFactory} from "../contracts/TimbSwapFactory.sol";
import {TimbSwapRouter} from "../contracts/TimbSwapRouter.sol";

contract NPToken is ERC20 {
    constructor(string memory n) ERC20(n, n) { _mint(msg.sender, 1e30); }
}

contract NPPrize {
    uint256 public nudged;
    function nudgeScroll() external { nudged++; }
    function isSettlementWindow() external pure returns (bool) { return false; }
    function currentRound() external pure returns (uint256) { return 1; }
    function currentSegment() external pure returns (uint256) { return 1; }
}

contract NPRegistry {
    function isEligible(address) external pure returns (bool) { return true; }
}

/**
 * @title Swap nudges only through designated pairs (TS-052)
 * @notice The TS-009 floor priced a nudge-earning swap, but pairs are
 *         permissionless: a WETH/JUNK pool the swapper owns outright refunds
 *         the LP share, so floor-sized swaps through it steered every
 *         segment's class for the protocol share plus gas. A swap now earns
 *         nudges only when its first hop is a protocol-designated pair.
 */
contract RouterNudgePairTest is Test {
    TimbSwapRouter router;
    TimbSwapFactory factory;
    NPPrize prize;
    NPToken weth;   // stands in for WETH (eligible, floor seeded)
    NPToken usdc;   // the designated pool's other side
    NPToken junk;   // the attacker's own token
    address realPair;
    address junkPair;
    address rando = address(0xBAD);

    function setUp() public {
        weth  = new NPToken("WETH");
        usdc  = new NPToken("USDC");
        junk  = new NPToken("JUNK");
        prize = new NPPrize();
        factory = new TimbSwapFactory(address(this));
        router = new TimbSwapRouter(address(factory), address(0x7EA5), address(new NPRegistry()), address(prize), address(weth));
        factory.setRouter(address(router));
        weth.approve(address(router), type(uint256).max);
        usdc.approve(address(router), type(uint256).max);
        junk.approve(address(router), type(uint256).max);
        router.addLiquidity(address(weth), address(usdc), 1000 ether, 1000 ether, 0, 0, address(this), block.timestamp);
        router.addLiquidity(address(weth), address(junk), 1000 ether, 1000 ether, 0, 0, address(this), block.timestamp);
        router.addLiquidity(address(junk), address(usdc), 1000 ether, 1000 ether, 0, 0, address(this), block.timestamp);
        realPair = factory.getPairAddress(address(weth), address(usdc));
        junkPair = factory.getPairAddress(address(weth), address(junk));
        router.setNudgePair(realPair, true);
    }

    function _swap(address tokenIn, address tokenOut, uint256 amt) internal {
        router.swapExactTokensForTokens(amt, 0, tokenIn, tokenOut, address(this), block.timestamp, true);
    }

    function _path(address[] memory path, uint256 amt) internal {
        router.swapExactTokensForTokensPath(amt, 0, path, address(this), block.timestamp, true);
    }

    function test_TS052_SelfOwnedPoolEarnsNoNudges() public {
        uint256 floor = router.DEFAULT_WETH_NUDGE_FLOOR();
        for (uint256 i = 0; i < 100; i++) _swap(address(weth), address(junk), floor);
        assertEq(prize.nudged(), 0, "a pool the swapper owns must not move the meter");
    }

    function test_TS052_DesignatedPairEarnsFullWeight() public {
        _swap(address(weth), address(usdc), router.DEFAULT_WETH_NUDGE_FLOOR());
        assertEq(prize.nudged(), router.swapNudgeWeight());
    }

    function test_TS052_MultiHopKeyedOnFirstHop() public {
        uint256 floor = router.DEFAULT_WETH_NUDGE_FLOOR();
        address[] memory viaJunk = new address[](3);
        viaJunk[0] = address(weth); viaJunk[1] = address(junk); viaJunk[2] = address(usdc);
        _path(viaJunk, floor);
        assertEq(prize.nudged(), 0, "first hop through the attacker's pool earns nothing");

        address[] memory viaReal = new address[](3);
        viaReal[0] = address(weth); viaReal[1] = address(usdc); viaReal[2] = address(junk);
        _path(viaReal, floor);
        assertEq(prize.nudged(), router.swapNudgeWeight(), "first hop through the designated pair earns");
    }

    function test_TS052_RemovingPairStopsNudges() public {
        router.setNudgePair(realPair, false);
        _swap(address(weth), address(usdc), router.DEFAULT_WETH_NUDGE_FLOOR());
        assertEq(prize.nudged(), 0);
    }

    function test_TS052_ListStartsEmpty() public {
        assertFalse(router.nudgePairs(junkPair));
        assertFalse(router.nudgePairs(factory.getPairAddress(address(junk), address(usdc))));
    }

    function test_TS052_SetNudgePair_OnlyOwner() public {
        vm.prank(rando);
        vm.expectRevert();
        router.setNudgePair(junkPair, true);
        vm.expectRevert(TimbSwapRouter.ZeroAddress.selector);
        router.setNudgePair(address(0), true);
    }
}
