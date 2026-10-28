// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../contracts/GasFaucet.sol";
import {MockTIMBS, MockTreasury, MockRegistry, MockPrize, RejectingWallet} from "./GasFaucet.t.sol";

/**
 * Branch coverage for the GasFaucet guards the main suite leaves open: who may
 * pause, the TIMBS global cap when it is the only leg left, zero-address
 * guards on dispense, claimable and grantReset, and the owner's recovery
 * exits (a failed ETH sweep reverts). Balances are checked where value moves.
 * Tests only; no contract change.
 */
contract GasFaucetMoneyPathsTest is Test {
    MockTIMBS    timbs;
    MockTreasury treasury;
    MockRegistry registry;
    MockPrize    prize;
    GasFaucet    faucet;

    address constant DISPATCHER = address(0xD15);
    address constant GUARDIAN   = address(0x6A4D);
    address constant STRANGER   = address(0x5747);
    address constant ALICE      = address(0xA11CE);

    function setUp() public {
        timbs    = new MockTIMBS();
        treasury = new MockTreasury();
        registry = new MockRegistry();
        prize    = new MockPrize();
        faucet = new GasFaucet(
            address(treasury), address(timbs), address(registry), address(prize),
            0.001 ether, 0.001 ether, 1e18, 1 days
        );
        vm.deal(address(treasury), 10 ether);
        timbs.mint(address(faucet), 100e18);
        faucet.setEthCap(10 ether);
        faucet.setTimbsCap(100e18);
        faucet.setDispatcher(DISPATCHER);
        faucet.setGuardian(GUARDIAN);
        registry.grant(ALICE, IGameRegistry.TicketStatus.Active);
    }

    function test_Pause_OnlyGuardianOrOwner() public {
        vm.prank(STRANGER);
        vm.expectRevert(GasFaucet.NotPauser.selector);
        faucet.setEthPaused(true);
        vm.prank(STRANGER);
        vm.expectRevert(GasFaucet.NotPauser.selector);
        faucet.setTimbsPaused(true);

        vm.prank(GUARDIAN);
        faucet.setEthPaused(true);
        assertTrue(faucet.ethPaused());
        faucet.setEthPaused(false);                 // owner
        assertFalse(faucet.ethPaused());
    }

    /// With the ETH leg paused, a spent TIMBS budget is the reason the claim
    /// fails, and nothing moves.
    function test_TimbsGlobalCap_NamesTheReasonWhenItIsTheLastLeg() public {
        faucet.setEthPaused(true);
        faucet.setTimbsCap(0.5e18);
        vm.prank(DISPATCHER);
        vm.expectRevert(abi.encodeWithSelector(GasFaucet.TimbsCapExceeded.selector, 1e18, 0.5e18));
        faucet.dispense(ALICE);
        assertEq(timbs.balanceOf(ALICE), 0);
        assertEq(faucet.timbsDistributed(), 0);
    }

    function test_ZeroAddressGuards() public {
        vm.prank(DISPATCHER);
        vm.expectRevert(GasFaucet.ZeroAddress.selector);
        faucet.dispense(address(0));
        assertFalse(faucet.claimable(address(0)));
        vm.prank(DISPATCHER);
        vm.expectRevert(GasFaucet.ZeroAddress.selector);
        faucet.grantReset(1, address(0));

        vm.expectRevert(GasFaucet.ZeroAddress.selector);
        new GasFaucet(address(0), address(timbs), address(registry), address(prize), 1, 1, 1, 1);
        vm.expectRevert(GasFaucet.ZeroAddress.selector);
        new GasFaucet(address(treasury), address(0), address(registry), address(prize), 1, 1, 1, 1);
        vm.expectRevert(GasFaucet.ZeroAddress.selector);
        new GasFaucet(address(treasury), address(timbs), address(0), address(prize), 1, 1, 1, 1);
        vm.expectRevert(GasFaucet.ZeroAddress.selector);
        new GasFaucet(address(treasury), address(timbs), address(registry), address(0), 1, 1, 1, 1);
    }

    function test_Recovery_GuardsAndFailedSweep() public {
        vm.expectRevert(GasFaucet.ZeroAddress.selector);
        faucet.recoverTimbs(address(0), 1);
        vm.expectRevert(GasFaucet.ZeroAddress.selector);
        faucet.sweepEth(address(0), 1);
        vm.expectRevert(GasFaucet.ZeroAddress.selector);
        faucet.recoverERC20(address(0), ALICE, 1);
        vm.expectRevert(GasFaucet.ZeroAddress.selector);
        faucet.recoverERC20(address(timbs), address(0), 1);
        vm.expectRevert(GasFaucet.ZeroAmount.selector);
        faucet.recoverERC20(address(timbs), ALICE, 0);

        vm.deal(address(faucet), 0.01 ether);
        address refusing = address(new RejectingWallet());
        vm.expectRevert(GasFaucet.EthTransferFailed.selector);
        faucet.sweepEth(refusing, 0.01 ether);
        assertEq(address(faucet).balance, 0.01 ether, "nothing left on a failed sweep");

        faucet.sweepEth(ALICE, 0.01 ether);
        assertEq(ALICE.balance, 0.01 ether);
        faucet.recoverTimbs(ALICE, 100e18);
        assertEq(timbs.balanceOf(ALICE), 100e18, "budget returned");
    }
}
