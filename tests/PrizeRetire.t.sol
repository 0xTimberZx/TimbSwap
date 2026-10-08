// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import {PrizeWindowsTest} from "./PrizeWindows.t.sol";
import {TimbPrize} from "../contracts/TimbPrize.sol";
import {MockTIMBS} from "./PrizeWindows.t.sol";

contract PrizeStrayToken is MockTIMBS { function mint(address to, uint256 a) external { _mint(to, a); } }

/// Fix-list 48/49: retired-prize fence and wiring-setter events.
contract PrizeRetireTest is PrizeWindowsTest {
    function test_retireBlocksSettlementPaths() public {
        prize.retire();
        assertTrue(prize.retired(), "flag set");
        vm.warp(prize.segmentStartTime() + prize.INTERACTION_WINDOW() + 1);
        vm.expectRevert(TimbPrize.PrizeIsRetired.selector);
        prize.settleSegment();
        vm.expectRevert(TimbPrize.PrizeIsRetired.selector);
        prize.rearmSegment();
        vm.expectRevert(TimbPrize.PrizeIsRetired.selector);
        prize.nudgeScroll();                         // this test contract is the router
    }

    function test_retireKeepsClaimPathsLive() public {
        prize.retire();
        // The fence is not on the claim paths: they fail only for their own reasons.
        vm.expectRevert(abi.encodeWithSelector(TimbPrize.RoundNotSettled.selector, uint256(1)));
        prize.claimWinnings(1);
        vm.expectRevert(abi.encodeWithSelector(TimbPrize.RoundNotSettled.selector, uint256(1)));
        prize.recycleUnclaimed(1);
        vm.expectRevert(TimbPrize.ZeroAmount.selector);
        prize.withdrawProtocolCut(address(0xCAFE));
    }

    function test_retiredPrizeCannotBeStarted() public {
        // A fresh prize, retired before start, must never go live: every
        // settlement path would then revert PrizeIsRetired and rounds stall.
        TimbPrize fresh = new TimbPrize(address(escrow), address(registry), address(this));
        fresh.setEntropy(address(entropy));
        fresh.retire();
        vm.expectRevert(TimbPrize.PrizeIsRetired.selector);
        fresh.startGame();
    }

    function test_retireOwnerOnlyAndIdempotent() public {
        vm.prank(rando);
        vm.expectRevert();
        prize.retire();
        prize.retire();
        prize.retire();                              // no revert, no second event
        assertTrue(prize.retired());
    }

    function test_wiringSettersEmit() public {
        vm.expectEmit(true, false, false, true); emit TimbPrize.RouterSet(address(0x11));
        prize.setRouter(address(0x11));
        vm.expectEmit(true, false, false, true); emit TimbPrize.EligibleRegistrySet(address(0x22));
        prize.setEligibleRegistry(address(0x22));
        vm.expectEmit(true, false, false, true); emit TimbPrize.GameRegistrySet(address(0x33));
        prize.setGameRegistry(address(0x33));
        vm.expectEmit(true, false, false, true); emit TimbPrize.PrizeEscrowSet(address(0x44));
        prize.setPrizeEscrow(address(0x44));
        vm.expectEmit(true, false, false, true); emit TimbPrize.YieldVaultSet(address(0x55));
        prize.setYieldVault(address(0x55));
    }

    // ─── Fix-list 61: stray ERC-20 exit ──────────────────────────────────────
    function test_recoverERC20_sweepsStrayToken() public {
        PrizeStrayToken tok = new PrizeStrayToken();
        tok.mint(address(prize), 1 ether);
        uint256 ethBefore = address(prize).balance;
        prize.recoverERC20(address(tok), address(0x5EEF), 1 ether);
        assertEq(tok.balanceOf(address(0x5EEF)), 1 ether, "swept");
        assertEq(address(prize).balance, ethBefore, "ETH untouched");
        vm.prank(rando);
        vm.expectRevert();
        prize.recoverERC20(address(tok), rando, 1);
    }
}
