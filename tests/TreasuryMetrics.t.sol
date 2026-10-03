// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TimbTreasury} from "../contracts/TimbTreasury.sol";

contract MetricsTIMBS is ERC20 {
    constructor() ERC20("TIMBS", "TIMBS") { _mint(msg.sender, 1_000_000e18); }
}

/// @dev Pull-based like the real TimbStaking.notifyRewardAmount.
contract PullStaking {
    IERC20 immutable t;
    constructor(IERC20 _t) { t = _t; }
    function notifyRewardAmount(uint256 amount, uint256) external {
        t.transferFrom(msg.sender, address(this), amount);
    }
}

/**
 * TS-023 — treasury fee and distribution metrics.
 *   • receiveFees and plain ETH only count as fee revenue from authorised senders.
 *   • distributeToStaking increments totalTimbsDistributed.
 */
contract TreasuryMetricsTest is Test {
    MetricsTIMBS timbs;
    PullStaking staking;
    TimbTreasury treasury;
    address rando = address(0xBAD);

    function setUp() public {
        timbs = new MetricsTIMBS();
        staking = new PullStaking(timbs);
        treasury = new TimbTreasury(address(timbs), address(staking), address(0xE5C), address(0x9A1B), address(0x7E7));
        vm.deal(rando, 1 ether);
    }

    function test_TS023_UnauthorisedReceiveFeesReverts() public {
        vm.prank(rando);
        vm.expectRevert(TimbTreasury.NotAuthorised.selector);
        treasury.receiveFees{value: 1}();
    }

    function test_TS023_PlainEthFromStrangerIsNotFeeRevenue() public {
        uint256 before = treasury.totalFeesReceived();
        vm.prank(rando);
        (bool ok,) = address(treasury).call{value: 1}("");
        assertTrue(ok);
        assertEq(treasury.totalFeesReceived(), before, "stranger ETH not counted as fees");
    }

    // TS-032: plain ETH from an AUTHORISED sender (e.g. the router refunding
    // excess ETH after provideLiquidityETH) is a deposit, not fee revenue.
    function test_TS032_PlainEthFromAuthorisedSenderIsNotFeeRevenue() public {
        address router = address(0x5007E5);
        treasury.setRouter(router);
        treasury.setFeeSender(router, true);
        vm.deal(router, 1 ether);
        uint256 before = treasury.totalFeesReceived();
        vm.prank(router);
        (bool ok,) = address(treasury).call{value: 0.6 ether}("");
        assertTrue(ok);
        assertEq(treasury.totalFeesReceived(), before, "router refund not booked as fees");
        // The explicit entrypoint still counts, and so does another authorised
        // sender's plain ETH (the escrow's protocol cut path).
        vm.prank(router);
        treasury.receiveFees{value: 0.1 ether}();
        assertEq(treasury.totalFeesReceived(), before + 0.1 ether, "receiveFees still credits");
        address escrowLike = address(0xE5C);
        treasury.setFeeSender(escrowLike, true);
        vm.deal(escrowLike, 1 ether);
        vm.prank(escrowLike);
        (ok,) = address(treasury).call{value: 0.2 ether}("");
        assertTrue(ok);
        assertEq(treasury.totalFeesReceived(), before + 0.3 ether, "non-router authorised plain ETH still counts");
    }

    function test_TS023_DistributeToStakingIsCounted() public {
        timbs.transfer(address(treasury), 500e18);
        treasury.distributeToStaking(500e18, 7 days);
        assertEq(treasury.totalTimbsDistributed(), 500e18);
        assertEq(timbs.balanceOf(address(staking)), 500e18);
    }
}
