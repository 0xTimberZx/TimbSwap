// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../contracts/TimbTreasury.sol";

contract TreasuryTIMBS is ERC20 {
    constructor() ERC20("TIMBS", "TIMBS") { _mint(msg.sender, 1e24); }
    function burn(uint256 a) external { _burn(msg.sender, a); }
}

contract RefusingRecipient {
    receive() external payable { revert("no ETH"); }
}

/// A WETH-pair look-alike: only token0/token1 are answered.
contract FakeWethPair {
    address public token0;
    address public token1;
    constructor(address a, address b) { token0 = a; token1 = b; }
}

/**
 * Branch coverage for TimbTreasury. In the beta the live paths are fee intake
 * and the operator ETH window (the faucet is the operator); buybacks, staking
 * and liquidity calls are never made, but their guards are in audit scope.
 * Each ETH path is checked by balance. Tests only; no contract change.
 *
 * The test contract is the owner.
 */
contract TimbTreasuryMoneyPathsTest is Test {
    TreasuryTIMBS timbs;
    TimbTreasury  t;

    address constant OP      = address(0x0E0);
    address constant ESCROW  = address(0xE5C);
    address constant ROUTER  = address(0x1234);
    address constant WETH    = address(0xEEEE);
    address constant PLAYER  = address(0xA11CE);
    address constant FEE_SRC = address(0xFEE5);

    function setUp() public {
        timbs = new TreasuryTIMBS();
        t = new TimbTreasury(address(timbs), address(0), ESCROW, address(0), WETH);
        t.setOperator(OP);
        t.setOperatorEthCap(0.1 ether, 1 days);
        vm.deal(address(t), 1 ether);
        vm.deal(FEE_SRC, 10 ether);
    }

    // ─── Operator window (the faucet's path in the beta) ────────────────────

    function test_Operator_CappedPerWindowAndRolls() public {
        vm.startPrank(OP);
        t.withdrawOperational(PLAYER, 0.06 ether);
        t.withdrawOperational(PLAYER, 0.04 ether);
        vm.expectRevert(abi.encodeWithSelector(TimbTreasury.OperatorCapExceeded.selector, 1, 0));
        t.withdrawOperational(PLAYER, 1);
        vm.stopPrank();
        assertEq(PLAYER.balance, 0.1 ether, "exactly one cap per window");

        vm.warp(block.timestamp + 1 days);
        vm.prank(OP);
        t.withdrawOperational(PLAYER, 0.1 ether);
        assertEq(PLAYER.balance, 0.2 ether, "fresh window, fresh cap");
        assertEq(address(t).balance, 0.8 ether);
    }

    function test_Operator_FailedSendDoesNotUseTheCap() public {
        address refusing = address(new RefusingRecipient());
        vm.prank(OP);
        vm.expectRevert(TimbTreasury.TransferFailed.selector);
        t.withdrawOperational(refusing, 0.1 ether);
        assertEq(t.operatorSpentInWindow(), 0, "reverted spend is not counted");

        vm.prank(OP);
        t.withdrawOperational(PLAYER, 0.1 ether);
        assertEq(PLAYER.balance, 0.1 ether, "full cap still available");
    }

    function test_Operator_GuardsAndOwnerUnbounded() public {
        vm.startPrank(OP);
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        t.withdrawOperational(address(0), 1);
        vm.expectRevert(TimbTreasury.ZeroAmount.selector);
        t.withdrawOperational(PLAYER, 0);
        vm.expectRevert(abi.encodeWithSelector(TimbTreasury.InsufficientETH.selector, 2 ether, 1 ether));
        t.withdrawOperational(PLAYER, 2 ether);
        vm.stopPrank();

        vm.prank(PLAYER);
        vm.expectRevert(TimbTreasury.NotAuthorised.selector);
        t.withdrawOperational(PLAYER, 1);

        t.withdrawOperational(PLAYER, 0.5 ether); // owner: above the operator cap
        assertEq(PLAYER.balance, 0.5 ether);
        assertEq(t.operatorSpentInWindow(), 0, "owner spend not counted against the operator");
    }

    function test_Operator_CapZeroDisablesAndClearedOperatorIsLockedOut() public {
        t.setOperatorEthCap(0, 1 days);
        vm.prank(OP);
        vm.expectRevert(abi.encodeWithSelector(TimbTreasury.OperatorCapExceeded.selector, 1, 0));
        t.withdrawOperational(PLAYER, 1);

        t.setOperatorEthCap(0.1 ether, 1 days);
        t.setOperator(address(0));
        vm.prank(OP);
        vm.expectRevert(TimbTreasury.NotAuthorised.selector);
        t.withdrawOperational(PLAYER, 1);

        vm.expectRevert(TimbTreasury.ZeroAmount.selector);
        t.setOperatorEthCap(1, 0);
    }

    // ─── Fee intake ─────────────────────────────────────────────────────────

    function test_ReceiveFees_OnlyAuthorisedAndNonZero() public {
        vm.prank(FEE_SRC);
        vm.expectRevert(TimbTreasury.NotAuthorised.selector);
        t.receiveFees{value: 1 ether}();

        t.setFeeSender(FEE_SRC, true);
        vm.prank(FEE_SRC);
        vm.expectRevert(TimbTreasury.ZeroAmount.selector);
        t.receiveFees{value: 0}();

        vm.prank(FEE_SRC);
        t.receiveFees{value: 1 ether}();
        assertEq(t.totalFeesReceived(), 1 ether);

        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        t.setFeeSender(address(0), true);
    }

    /// Plain ETH: only authorised senders other than the router count as fees.
    function test_Receive_CountsOnlyAuthorisedNonRouterEth() public {
        vm.deal(ESCROW, 1 ether);
        vm.prank(ESCROW);                                   // authorised at deploy
        (bool ok,) = address(t).call{value: 0.3 ether}("");
        assertTrue(ok);
        assertEq(t.totalFeesReceived(), 0.3 ether, "escrow's cut counts");

        vm.prank(FEE_SRC);                                  // not authorised
        (ok,) = address(t).call{value: 0.2 ether}("");
        assertTrue(ok);
        assertEq(t.totalFeesReceived(), 0.3 ether, "a plain deposit is not revenue");

        t.setRouter(ROUTER);
        t.setFeeSender(ROUTER, true);
        vm.deal(ROUTER, 1 ether);
        vm.prank(ROUTER);                                   // TS-032
        (ok,) = address(t).call{value: 0.1 ether}("");
        assertTrue(ok);
        assertEq(t.totalFeesReceived(), 0.3 ether, "router refunds are not revenue");

        vm.recordLogs();
        vm.prank(FEE_SRC);
        (ok,) = address(t).call{value: 0}("");
        assertTrue(ok);
        assertEq(vm.getRecordedLogs().length, 0, "zero-value receive is a no-op");
    }

    // ─── Escrow repoint moves fee-sender rights ─────────────────────────────

    function test_SetPrizeEscrow_MovesFeeSenderRights() public {
        address newEscrow = address(0xE5D);
        t.setPrizeEscrow(newEscrow);
        assertFalse(t.authorisedFeeSenders(ESCROW), "old escrow de-authorised");
        assertTrue(t.authorisedFeeSenders(newEscrow));
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        t.setPrizeEscrow(address(0));
    }

    // ─── Off-in-beta paths: guards only ─────────────────────────────────────

    function test_DistributeToPot_Guards() public {
        vm.expectRevert(TimbTreasury.ZeroAmount.selector);
        t.distributeToPot(0);
        vm.expectRevert(abi.encodeWithSelector(TimbTreasury.InsufficientETH.selector, 2 ether, 1 ether));
        t.distributeToPot(2 ether);

        TimbTreasury noEscrow = new TimbTreasury(address(timbs), address(0), address(0), address(0), WETH);
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        noEscrow.distributeToPot(1);
    }

    function test_Buyback_Guards() public {
        vm.expectRevert(TimbTreasury.ZeroAmount.selector);
        t.executeBuyback(0, 1);
        vm.expectRevert(abi.encodeWithSelector(TimbTreasury.InsufficientETH.selector, 2 ether, 1 ether));
        t.executeBuyback(2 ether, 1);
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        t.executeBuyback(0.1 ether, 1);                     // no pair set
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        t.updateTwap();

        t.setTimbsEthPair(address(0xBA1));
        vm.expectRevert(TimbTreasury.ZeroAmount.selector);
        t.executeBuyback(0.1 ether, 0);                     // M7: no zero floor
        t.setBuybackMaxEth(0.05 ether);
        vm.expectRevert(abi.encodeWithSelector(TimbTreasury.BuybackTooLarge.selector, 0.1 ether, 0.05 ether));
        t.executeBuyback(0.1 ether, 1);

        vm.expectRevert(abi.encodeWithSelector(TimbTreasury.InvalidRatio.selector, 10_001));
        t.setBuybackMaxDeviationBps(10_001);
        assertEq(address(t).balance, 1 ether, "nothing spent");
    }

    function test_SplitLpFees_NeedsEscrowWethAndRouter() public {
        FakeWethPair pair = new FakeWethPair(WETH, address(timbs));
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);  // router not set
        t.splitLpFees(address(pair));

        TimbTreasury noWeth = new TimbTreasury(address(timbs), address(0), ESCROW, address(0), address(0));
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        noWeth.splitLpFees(address(pair));
    }

    function test_StakingAndLiquidity_Guards() public {
        vm.expectRevert(TimbTreasury.ZeroAmount.selector);
        t.distributeToStaking(0, 1);
        vm.expectRevert(TimbTreasury.ZeroAmount.selector);
        t.distributeToStaking(1, 0);
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        t.distributeToStaking(1, 1);                         // no staking set
        t.setTimbStaking(address(0x57A));
        vm.expectRevert(TimbTreasury.ZeroAmount.selector);
        t.distributeToStaking(1, 1);                         // holds no TIMBS

        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        t.provideLiquidity(address(timbs), WETH, 1, 1, 0, 0); // no router
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        t.provideLiquidityETH(address(timbs), 1, 1, 0, 0);
        t.setRouter(ROUTER);
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        t.provideLiquidity(address(0), WETH, 1, 1, 0, 0);
        vm.expectRevert(TimbTreasury.ZeroAmount.selector);
        t.provideLiquidity(address(timbs), WETH, 0, 1, 0, 0);
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        t.provideLiquidityETH(address(0), 1, 1, 0, 0);
        vm.expectRevert(TimbTreasury.ZeroAmount.selector);
        t.provideLiquidityETH(address(timbs), 0, 1, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(TimbTreasury.InsufficientETH.selector, 2 ether, 1 ether));
        t.provideLiquidityETH(address(timbs), 1, 2 ether, 0, 0);
    }

    // ─── Token exits ────────────────────────────────────────────────────────

    function test_WithdrawTokenAndUnwrap_Guards() public {
        timbs.transfer(address(t), 5e18);
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        t.withdrawToken(address(0), PLAYER, 1);
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        t.withdrawToken(address(timbs), address(0), 1);
        vm.expectRevert(TimbTreasury.ZeroAmount.selector);
        t.withdrawToken(address(timbs), PLAYER, 0);
        vm.prank(OP);
        vm.expectRevert();                                   // owner only
        t.withdrawToken(address(timbs), PLAYER, 1);
        t.withdrawToken(address(timbs), PLAYER, 5e18);
        assertEq(timbs.balanceOf(PLAYER), 5e18);

        vm.prank(OP);
        vm.expectRevert(TimbTreasury.ZeroAmount.selector);   // operator may unwrap
        t.unwrapWeth(0);
        TimbTreasury noWeth = new TimbTreasury(address(timbs), address(0), ESCROW, address(0), address(0));
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        noWeth.unwrapWeth(1);
    }

    // ─── Config guards ──────────────────────────────────────────────────────

    function test_Config_RejectsZeroValues() public {
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        new TimbTreasury(address(0), address(0), ESCROW, address(0), WETH);
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        t.setTimbStaking(address(0));
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        t.setTimbsEthPair(address(0));
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        t.setRouter(address(0));
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        t.setWeth(address(0));
        vm.expectRevert(TimbTreasury.ZeroAmount.selector);
        t.setStakingDistributionPeriod(0);
    }
}
