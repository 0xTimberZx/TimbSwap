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

    function test_TS023_DistributeToStakingIsCounted() public {
        timbs.transfer(address(treasury), 500e18);
        treasury.distributeToStaking(500e18, 7 days);
        assertEq(treasury.totalTimbsDistributed(), 500e18);
        assertEq(timbs.balanceOf(address(staking)), 500e18);
    }
}
