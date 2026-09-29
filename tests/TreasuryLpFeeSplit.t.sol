// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TimbSwapFactory} from "../contracts/TimbSwapFactory.sol";
import {TimbSwapRouter} from "../contracts/TimbSwapRouter.sol";
import {TimbTreasury} from "../contracts/TimbTreasury.sol";
import {PrizeEscrow} from "../contracts/PrizeEscrow.sol";
import {GameRegistry} from "../contracts/GameRegistry.sol";
import {TimbPrize} from "../contracts/TimbPrize.sol";
import {MockTIMBS} from "./PrizeWindows.t.sol";
import {RehearsalWETH} from "./DeployBetaRehearsal.t.sol";

contract SplitToken is ERC20 {
    constructor() ERC20("TKN", "TKN") { _mint(msg.sender, 1e30); }
}

/**
 * @title Pool protocol fee: half to the pot, automatically
 * @notice Router fee starts at 0 (all-in 0.30%). The pools' 0.05% protocol
 *         share is minted to the treasury as LP; splitLpFees redeems it and
 *         sends the WETH side (half the value) to the pot, keeping the other
 *         token. Treasury-owned liquidity is never redeemed.
 */
contract TreasuryLpFeeSplitTest is Test {
    RehearsalWETH weth;
    SplitToken tkn;
    TimbSwapFactory factory;
    TimbSwapRouter router;
    TimbTreasury treasury;
    PrizeEscrow escrow;
    TimbPrize prize;
    address pair;
    address trader = address(0x7AD3);

    function setUp() public {
        weth = new RehearsalWETH();
        tkn  = new SplitToken();
        MockTIMBS timbs = new MockTIMBS();
        escrow = new PrizeEscrow();
        GameRegistry registry = new GameRegistry(address(timbs), address(0xBEEF), address(0), 2e18, 1e18);
        prize = new TimbPrize(address(escrow), address(registry), address(this));
        escrow.setTimbPrize(address(prize));

        treasury = new TimbTreasury(address(timbs), address(0x5742), address(escrow), address(0x9A1B), address(weth));
        factory  = new TimbSwapFactory(address(treasury));          // feeTo = treasury
        router   = new TimbSwapRouter(address(factory), address(treasury), address(0), address(0), address(weth));
        factory.setRouter(address(router));
        treasury.setRouter(address(router));

        vm.deal(address(this), 10_000 ether);
        weth.deposit{value: 5_000 ether}();
        weth.approve(address(router), type(uint256).max);
        tkn.approve(address(router), type(uint256).max);
        router.addLiquidity(address(weth), address(tkn), 1_000 ether, 1_000 ether, 0, 0, address(this), block.timestamp);
        pair = factory.getPair(address(weth), address(tkn));

        weth.transfer(trader, 1_000 ether);
        tkn.transfer(trader, 1_000 ether);
        vm.startPrank(trader);
        weth.approve(address(router), type(uint256).max);
        tkn.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _trade(uint256 rounds) internal {
        vm.startPrank(trader);
        for (uint256 i = 0; i < rounds; i++) {
            router.swapExactTokensForTokens(50 ether, 0, address(weth), address(tkn), trader, block.timestamp, false);
            router.swapExactTokensForTokens(50 ether, 0, address(tkn), address(weth), trader, block.timestamp, false);
        }
        vm.stopPrank();
    }

    /// @dev A mint/burn realises the lazy protocol fee as LP to feeTo.
    function _realiseFee() internal {
        router.addLiquidity(address(weth), address(tkn), 1 ether, 1 ether, 0, 0, address(this), block.timestamp);
    }

    function test_RouterFeeStartsAtZero_AllIn030() public {
        assertEq(router.protocolFeeBps(), 0);
        assertEq(router.PROTOCOL_FEE_BPS(), 0);
        uint256 before = weth.balanceOf(trader);
        vm.prank(trader);
        router.swapExactTokensForTokens(10 ether, 0, address(weth), address(tkn), trader, block.timestamp, false);
        assertEq(before - weth.balanceOf(trader), 10 ether, "no router fee on top");
    }

    function test_RouterFee_SettableUpToCap() public {
        router.setProtocolFeeBps(5);
        assertEq(router.PROTOCOL_FEE_BPS(), 5);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.ProtocolFeeTooHigh.selector, uint256(6), uint256(5)));
        router.setProtocolFeeBps(6);
        vm.prank(address(0xBAD));
        vm.expectRevert();
        router.setProtocolFeeBps(1);
    }

    function test_SplitSendsWethSideToPot_KeepsOtherToken() public {
        _trade(20);
        _realiseFee();
        uint256 feeLp = ERC20(pair).balanceOf(address(treasury));
        assertGt(feeLp, 0, "pool minted the protocol share to the treasury");

        uint256 potBefore = prize.currentAccumulatedRewards();
        vm.prank(address(0xCA11));                       // permissionless
        treasury.splitLpFees(pair);

        uint256 toPot = prize.currentAccumulatedRewards() - potBefore;
        assertGt(toPot, 0, "pot credited");
        assertEq(address(escrow).balance, prize.currentAccumulatedRewards(), "every wei counted in the pot");
        assertEq(treasury.totalLpFeesToPot(), toPot);
        assertGt(tkn.balanceOf(address(treasury)), 0, "treasury keeps the other side");
        // Pool sides are equal in value (price ~1:1 here), so the halves match.
        assertApproxEqRel(tkn.balanceOf(address(treasury)), toPot, 0.05e18);
        assertEq(ERC20(pair).balanceOf(address(treasury)), 0, "fee LP fully redeemed");
    }

    function test_TreasuryOwnedLiquidityIsNotSplit() public {
        weth.transfer(address(treasury), 10 ether);
        tkn.transfer(address(treasury), 10 ether);
        treasury.provideLiquidity(address(weth), address(tkn), 10 ether, 10 ether, 0, 0);
        uint256 pol = treasury.polLp(pair);
        assertGt(pol, 0);
        vm.expectRevert(abi.encodeWithSelector(TimbTreasury.NoFeeLp.selector, pair));
        treasury.splitLpFees(pair);

        _trade(20);
        _realiseFee();
        treasury.splitLpFees(pair);
        assertEq(ERC20(pair).balanceOf(address(treasury)), pol, "protocol-owned LP untouched");
    }

    function test_NonWethPairReverts() public {
        SplitToken other = new SplitToken();
        other.approve(address(router), type(uint256).max);
        router.addLiquidity(address(tkn), address(other), 10 ether, 10 ether, 0, 0, address(this), block.timestamp);
        address p2 = factory.getPair(address(tkn), address(other));
        vm.expectRevert(abi.encodeWithSelector(TimbTreasury.NotWethPair.selector, p2));
        treasury.splitLpFees(p2);
    }

    receive() external payable {}

    // ─── TS-010: exact-out amountInMax bounds the total debit ───────────────

    function test_TS010_ExactOut_MaxCoversFee() public {
        router.setProtocolFeeBps(5);
        address[] memory path = new address[](2);
        path[0] = address(weth); path[1] = address(tkn);
        uint256 need = router.getAmountsInPath(10 ether, path)[0];
        uint256 total = need + (need * 5) / 10_000;

        // A limit that covers the input but not the fee now reverts up front.
        vm.prank(trader);
        vm.expectRevert(TimbSwapRouter.ExcessiveInputAmount.selector);
        router.swapTokensForExactTokens(10 ether, need, address(weth), address(tkn), trader, block.timestamp, false);
        vm.prank(trader);
        vm.expectRevert(TimbSwapRouter.ExcessiveInputAmount.selector);
        router.swapTokensForExactTokensPath(10 ether, need, path, trader, block.timestamp, false);

        // Approving exactly the total works, and never debits more than it.
        address careful = address(0xCA4E);
        weth.transfer(careful, total);
        vm.startPrank(careful);
        weth.approve(address(router), total);
        router.swapTokensForExactTokens(10 ether, total, address(weth), address(tkn), careful, block.timestamp, false);
        vm.stopPrank();
        assertEq(weth.balanceOf(careful), 0, "debit equals amountInMax");
        assertEq(tkn.balanceOf(careful), 10 ether);
    }
}
