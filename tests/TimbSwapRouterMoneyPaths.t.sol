// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TimbSwapFactory} from "../contracts/TimbSwapFactory.sol";
import {TimbSwapRouter} from "../contracts/TimbSwapRouter.sol";

contract MPToken is ERC20 {
    constructor(string memory s) ERC20(s, s) { _mint(msg.sender, 1e30); }
}

/// aeWETH-shaped stand-in (as in RouterWethRecipient.t.sol).
contract MPWETH is ERC20 {
    constructor() ERC20("WETH", "WETH") {}
    function deposit() public payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 a) external { _burn(msg.sender, a); payable(msg.sender).transfer(a); }
    receive() external payable { deposit(); }
}

/// Prize stand-in for the router's nudge paths: counts nudges, can report the
/// settlement window, and can be told to revert its views or its nudges.
contract ScriptedPrize {
    uint256 public positionCounter;
    uint256 public currentRound = 1;
    uint256 public currentSegment = 1;
    bool public window;
    bool public windowReverts;
    uint256 public nudgesBeforeRevert = type(uint256).max;

    function setWindow(bool w) external { window = w; }
    function setWindowReverts(bool r) external { windowReverts = r; }
    function setNudgesBeforeRevert(uint256 n) external { nudgesBeforeRevert = n; }
    function isSettlementWindow() external view returns (bool) {
        require(!windowReverts, "window view down");
        return window;
    }
    function nudgeScroll() external {
        require(positionCounter < nudgesBeforeRevert, "segment closed");
        positionCounter++;
    }
}

contract ScriptedEligible {
    bool public eligible = true;
    bool public reverts;
    function set(bool e, bool r) external { eligible = e; reverts = r; }
    function isEligible(address) external view returns (bool) {
        require(!reverts, "registry down");
        return eligible;
    }
}

/// A wallet that refuses ETH: used for failed refunds and failed ETH payouts.
contract RefusingTrader {
    TimbSwapRouter r;
    constructor(TimbSwapRouter _r) { r = _r; }
    function buyWithExcess(address tokenOut, uint256 amountIn) external payable {
        r.swapExactETHForTokens{value: msg.value}(amountIn, 0, tokenOut, address(this), block.timestamp, false);
    }
    receive() external payable { revert("no ETH"); }
}

/**
 * Branch coverage for TimbSwapRouter: slippage and deadline guards on every
 * swap shape, multi-hop path validation, the native-ETH legs (fee on top,
 * excess refund, failed refund, failed payout), the swap-nudge conditions
 * (each early exit, and a nudge that reverts mid-batch), the free-nudge entry
 * guards, and liquidity minimums. Outputs are checked by balance.
 * Tests only; no contract change.
 *
 * Unreachable by construction, so not covered: every `weth == address(0)`
 * check (WethNotSet). `weth` is immutable and the constructor rejects zero.
 */
contract TimbSwapRouterMoneyPathsTest is Test {
    MPToken a;
    MPToken b;
    MPWETH  weth;
    TimbSwapFactory factory;
    TimbSwapRouter  router;
    ScriptedPrize    prize;
    ScriptedEligible eligible;

    address constant TREASURY = address(0x7EA5);
    address constant USER     = address(0xA11CE);
    uint256 dl;

    function setUp() public {
        a = new MPToken("A");
        b = new MPToken("B");
        weth = new MPWETH();
        factory = new TimbSwapFactory(TREASURY);
        router = new TimbSwapRouter(address(factory), TREASURY, address(0), address(0), address(weth));
        factory.setRouter(address(router));
        dl = block.timestamp;

        a.approve(address(router), type(uint256).max);
        b.approve(address(router), type(uint256).max);
        router.addLiquidity(address(a), address(b), 100 ether, 100 ether, 0, 0, address(this), dl);
        router.addLiquidityETH{value: 100 ether}(address(a), 100 ether, 0, 0, address(this), dl);
        router.addLiquidityETH{value: 100 ether}(address(b), 100 ether, 0, 0, address(this), dl);

        prize = new ScriptedPrize();
        eligible = new ScriptedEligible();
        vm.deal(USER, 100 ether);
    }

    function _path(address x, address y) internal pure returns (address[] memory p) {
        p = new address[](2); p[0] = x; p[1] = y;
    }

    function _path3(address x, address y, address z) internal pure returns (address[] memory p) {
        p = new address[](3); p[0] = x; p[1] = y; p[2] = z;
    }

    function _wirePrize() internal {
        router.setTimbPrize(address(prize));
        router.setEligibleRegistry(address(eligible));
        router.setNudgePair(factory.getPair(address(weth), address(a)), true);
    }

    function _ethSwapNudge() internal {
        vm.prank(USER);
        router.swapExactETHForTokens{value: 0.01 ether}(0.01 ether, 0, address(a), USER, block.timestamp, true);
    }

    // ─── Deadline, pause, constructor ───────────────────────────────────────

    function test_DeadlineAndPause() public {
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.Expired.selector, dl - 1));
        router.swapExactTokensForTokens(1 ether, 0, address(a), address(b), USER, dl - 1, false);
        router.pause();
        vm.expectRevert(TimbSwapRouter.RouterPaused.selector);
        router.swapExactTokensForTokens(1 ether, 0, address(a), address(b), USER, dl, false);
    }

    function test_Constructor_RejectsZeroAddresses() public {
        vm.expectRevert(TimbSwapRouter.ZeroAddress.selector);
        new TimbSwapRouter(address(0), TREASURY, address(0), address(0), address(weth));
        vm.expectRevert(TimbSwapRouter.ZeroAddress.selector);
        new TimbSwapRouter(address(factory), address(0), address(0), address(0), address(weth));
        vm.expectRevert(TimbSwapRouter.ZeroAddress.selector);
        new TimbSwapRouter(address(factory), TREASURY, address(0), address(0), address(0));
        vm.expectRevert(TimbSwapRouter.ZeroAddress.selector);
        router.setTreasury(address(0));
    }

    // ─── Single-hop swaps ───────────────────────────────────────────────────

    function test_ExactIn_SlippageZeroAndMissingPair() public {
        uint256 out = router.getAmountOut(1 ether, 100 ether, 100 ether);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InsufficientOutputAmount.selector, out, out + 1));
        router.swapExactTokensForTokens(1 ether, out + 1, address(a), address(b), USER, dl, false);
        vm.expectRevert(TimbSwapRouter.ZeroAmount.selector);
        router.swapExactTokensForTokens(0, 0, address(a), address(b), USER, dl, false);

        MPToken c = new MPToken("C");
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.PairNotFound.selector, address(a), address(c)));
        router.swapExactTokensForTokens(1 ether, 0, address(a), address(c), USER, dl, false);

        router.swapExactTokensForTokens(1 ether, out, address(a), address(b), USER, dl, false);
        assertEq(b.balanceOf(USER), out, "exactly the quoted output");
    }

    function test_ExactOut_ZeroAndQuoteMath() public {
        vm.expectRevert(TimbSwapRouter.ZeroAmount.selector);
        router.swapTokensForExactTokens(0, 1 ether, address(a), address(b), USER, dl, false);
        vm.expectRevert(TimbSwapRouter.ZeroAmount.selector);
        router.getAmountIn(0, 1, 1);
        vm.expectRevert(TimbSwapRouter.ZeroAmount.selector);
        router.getAmountOut(1, 0, 1);
        vm.expectRevert(TimbSwapRouter.ZeroAmount.selector);
        router.quote(0, 1, 1);

        (uint256 r0, uint256 r1) = router.getReserves(address(a), address(new MPToken("D")));
        assertEq(r0 + r1, 0, "missing pair reads as empty");
    }

    // ─── Multi-hop paths ────────────────────────────────────────────────────

    function test_Path_RejectsMalformedPaths() public {
        address[] memory one = new address[](1);
        one[0] = address(a);
        address[] memory five = new address[](5);
        five[0] = address(a); five[1] = address(b); five[2] = address(a); five[3] = address(b); five[4] = address(a);

        vm.expectRevert(TimbSwapRouter.InvalidPath.selector);
        router.getAmountsOutPath(1 ether, one);
        vm.expectRevert(TimbSwapRouter.InvalidPath.selector);
        router.getAmountsOutPath(1 ether, five);
        vm.expectRevert(TimbSwapRouter.InvalidPath.selector);
        router.getAmountsOutPath(1 ether, _path(address(a), address(a)));
        vm.expectRevert(TimbSwapRouter.InvalidPath.selector);
        router.getAmountsOutPath(1 ether, _path(address(0), address(a)));

        vm.expectRevert(TimbSwapRouter.InvalidPath.selector);
        router.getAmountsInPath(1 ether, one);
        vm.expectRevert(TimbSwapRouter.InvalidPath.selector);
        router.getAmountsInPath(1 ether, five);
        vm.expectRevert(TimbSwapRouter.InvalidPath.selector);
        router.getAmountsInPath(1 ether, _path(address(b), address(b)));
        vm.expectRevert(TimbSwapRouter.InvalidPath.selector);
        router.getAmountsInPath(1 ether, _path(address(a), address(0)));
    }

    function test_Path_SlippageAndZero() public {
        address[] memory p = _path3(address(a), address(weth), address(b));
        uint256[] memory q = router.getAmountsOutPath(1 ether, p);
        uint256 out = q[2];
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InsufficientOutputAmount.selector, out, out + 1));
        router.swapExactTokensForTokensPath(1 ether, out + 1, p, USER, dl, false);
        vm.expectRevert(TimbSwapRouter.ZeroAmount.selector);
        router.swapExactTokensForTokensPath(0, 0, p, USER, dl, false);
        vm.expectRevert(TimbSwapRouter.ZeroAmount.selector);
        router.swapTokensForExactTokensPath(0, 1 ether, p, USER, dl, false);

        router.swapExactTokensForTokensPath(1 ether, out, p, USER, dl, false);
        assertEq(b.balanceOf(USER), out, "two hops, exactly the quote");
        assertEq(weth.balanceOf(address(router)) + address(router).balance, 0, "router keeps nothing");
    }

    // ─── Native ETH legs ────────────────────────────────────────────────────

    function test_EthIn_FeeOnTopAndExcessRefunded() public {
        router.setProtocolFeeBps(5);
        uint256 amountIn = 1 ether;
        uint256 fee = amountIn * 5 / 10_000;

        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InsufficientETHSent.selector, amountIn, amountIn + fee));
        router.swapExactETHForTokens{value: amountIn}(amountIn, 0, address(a), USER, dl, false);

        vm.prank(USER);
        vm.expectRevert(TimbSwapRouter.ZeroAmount.selector);
        router.swapExactETHForTokens{value: 1}(0, 0, address(a), USER, dl, false);

        uint256 out = router.getAmountOut(amountIn, 100 ether, 100 ether);
        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InsufficientOutputAmount.selector, out, out + 1));
        router.swapExactETHForTokens{value: 2 ether}(amountIn, out + 1, address(a), USER, dl, false);

        uint256 before = USER.balance;
        vm.prank(USER);
        router.swapExactETHForTokens{value: 2 ether}(amountIn, out, address(a), USER, dl, false);
        assertEq(USER.balance, before - amountIn - fee, "excess refunded, fee charged once");
        assertEq(weth.balanceOf(TREASURY), fee, "fee paid as WETH");
        assertEq(a.balanceOf(USER), out);
        assertEq(address(router).balance, 0);
    }

    function test_EthIn_NoFeeWhenBpsZero() public {
        uint256 before = USER.balance;
        vm.prank(USER);
        router.swapExactETHForTokens{value: 1 ether}(1 ether, 0, address(a), USER, dl, false);
        assertEq(USER.balance, before - 1 ether);
        assertEq(weth.balanceOf(TREASURY), 0, "no fee leg");
    }

    function test_EthIn_FailedRefundRevertsTheSwap() public {
        RefusingTrader t = new RefusingTrader(router);
        vm.deal(address(t), 0);
        vm.expectRevert(TimbSwapRouter.RefundFailed.selector);
        t.buyWithExcess{value: 2 ether}(address(a), 1 ether);
        assertEq(a.balanceOf(address(t)), 0, "nothing bought");
    }

    function test_EthOut_SlippageZeroAndFailedPayout() public {
        vm.expectRevert(TimbSwapRouter.ZeroAmount.selector);
        router.swapExactTokensForETH(0, 0, address(a), USER, dl, false);
        uint256 out = router.getAmountOut(1 ether, 100 ether, 100 ether);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InsufficientOutputAmount.selector, out, out + 1));
        router.swapExactTokensForETH(1 ether, out + 1, address(a), USER, dl, false);

        address refusing = address(new RefusingTrader(router));
        vm.expectRevert(TimbSwapRouter.ETHTransferFailed.selector);
        router.swapExactTokensForETH(1 ether, 0, address(a), refusing, dl, false);

        uint256 before = USER.balance;
        router.swapExactTokensForETH(1 ether, out, address(a), USER, dl, false);
        assertEq(USER.balance, before + out, "paid in native ETH");
    }

    // ─── Swap nudges: every early exit ──────────────────────────────────────

    function test_SwapNudge_CountsWhenEverythingLinesUp() public {
        _wirePrize();
        _ethSwapNudge();
        assertEq(prize.positionCounter(), 3, "swapNudgeWeight nudges");
    }

    function test_SwapNudge_SkippedWhenPrizeOrRegistryUnset() public {
        _wirePrize();
        router.setTimbPrize(address(0));
        _ethSwapNudge();
        router.setTimbPrize(address(prize));
        router.setEligibleRegistry(address(0));
        _ethSwapNudge();
        assertEq(prize.positionCounter(), 0);
    }

    function test_SwapNudge_SkippedWhenIneligibleOrRegistryReverts() public {
        _wirePrize();
        eligible.set(false, false);
        _ethSwapNudge();
        eligible.set(true, true);
        _ethSwapNudge();
        assertEq(prize.positionCounter(), 0, "swap still goes through, no nudge");
        assertGt(a.balanceOf(USER), 0);
    }

    function test_SwapNudge_SkippedInWindowOrWhenWindowViewReverts() public {
        _wirePrize();
        prize.setWindow(true);
        _ethSwapNudge();
        prize.setWindow(false);
        prize.setWindowReverts(true);
        _ethSwapNudge();
        assertEq(prize.positionCounter(), 0);
    }

    /// A nudge that reverts mid-batch ends the batch; the swap still settles.
    function test_SwapNudge_StopsCleanlyWhenANudgeReverts() public {
        _wirePrize();
        prize.setNudgesBeforeRevert(1);
        uint256 before = a.balanceOf(USER);
        _ethSwapNudge();
        assertEq(prize.positionCounter(), 1, "one landed, then stopped");
        assertGt(a.balanceOf(USER), before, "swap completed");
    }

    // ─── Free nudge entry and config guards ─────────────────────────────────

    function test_AdvanceScroll_Guards() public {
        vm.expectRevert(TimbSwapRouter.PrizeNotSet.selector);
        router.advanceScroll(1);
        assertEq(router.freeNudgesRemaining(USER), 0, "no prize, no allowance");

        router.setTimbPrize(address(prize));
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidNudgeCount.selector, 0, 20));
        router.advanceScroll(0);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidNudgeCount.selector, 21, 20));
        router.advanceScroll(21);
    }

    function test_NudgeConfig_Guards() public {
        vm.expectRevert(TimbSwapRouter.ZeroAddress.selector);
        router.setMinNudgeAmountIn(address(0), 1);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidNudgeCount.selector, 0, 10));
        router.setSwapNudgeWeight(0);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InvalidNudgeCount.selector, 11, 10));
        router.setSwapNudgeWeight(11);
    }

    // ─── Liquidity minimums ─────────────────────────────────────────────────

    function test_AddLiquidity_MinimumsOnASeededPair() public {
        // Pool is 1:1. Asking 10 A with 5 B available: optimal A is 5, below a 6 minimum.
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InsufficientAAmount.selector, 5 ether, 6 ether));
        router.addLiquidity(address(a), address(b), 10 ether, 5 ether, 6 ether, 0, USER, dl);
        // Asking 5 A with 10 B available: optimal B is 5, below a 6 minimum.
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InsufficientBAmount.selector, 5 ether, 6 ether));
        router.addLiquidity(address(a), address(b), 5 ether, 10 ether, 0, 6 ether, USER, dl);

        vm.expectRevert(TimbSwapRouter.ZeroAmount.selector);
        router.addLiquidityETH{value: 0}(address(a), 1 ether, 0, 0, USER, dl);
    }

    function test_RemoveLiquidity_MinimumsAndFailedEthPayout() public {
        address abPair = factory.getPair(address(a), address(b));
        address awPair = factory.getPair(address(a), address(weth));
        ERC20(abPair).approve(address(router), type(uint256).max);
        ERC20(awPair).approve(address(router), type(uint256).max);

        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InsufficientAAmount.selector, 1 ether, 2 ether));
        router.removeLiquidity(address(a), address(b), 1 ether, 2 ether, 0, USER, dl);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InsufficientBAmount.selector, 1 ether, 2 ether));
        router.removeLiquidity(address(a), address(b), 1 ether, 0, 2 ether, USER, dl);

        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InsufficientAAmount.selector, 1 ether, 2 ether));
        router.removeLiquidityETH(address(a), 1 ether, 2 ether, 0, USER, dl);
        vm.expectRevert(abi.encodeWithSelector(TimbSwapRouter.InsufficientBAmount.selector, 1 ether, 2 ether));
        router.removeLiquidityETH(address(a), 1 ether, 0, 2 ether, USER, dl);

        address refusing = address(new RefusingTrader(router));
        vm.expectRevert(TimbSwapRouter.RefundFailed.selector);
        router.removeLiquidityETH(address(a), 1 ether, 0, 0, refusing, dl);

        uint256 before = USER.balance;
        router.removeLiquidityETH(address(a), 1 ether, 1 ether, 1 ether, USER, dl);
        assertEq(USER.balance, before + 1 ether, "ETH side paid natively");
        assertEq(a.balanceOf(USER), 1 ether);
    }

    receive() external payable {}
}
