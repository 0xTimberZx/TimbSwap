// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../contracts/TIMBSToken.sol";

/**
 * @title TIMBSToken — transfer cap and whitelist, pause, minter rotation,
 *        config setters, views, owner gating
 */
contract TIMBSTokenTest is Test {
    TIMBSToken timbs;

    address constant TREASURY = address(0x7EA5);
    address constant ALICE    = address(0xA11CE);
    address constant BOB      = address(0xB0B);
    address constant STAKING  = address(0x57A1);
    address constant FARM     = address(0xFA12);

    uint256 constant GENESIS = 50_000_000e18;

    function setUp() public {
        timbs = new TIMBSToken(TREASURY, GENESIS, 1_000e18);
        vm.prank(TREASURY);
        timbs.transfer(ALICE, 1_000_000e18);
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    function test_ConstructorState() public view {
        assertEq(timbs.totalSupply(), GENESIS);
        assertEq(timbs.balanceOf(TREASURY), GENESIS - 1_000_000e18);
        assertEq(timbs.treasury(), TREASURY);
        assertEq(timbs.entryCostTIMBS(), 1_000e18);
        assertTrue(timbs.transferWhitelist(TREASURY));
        assertTrue(timbs.transferWhitelist(address(this)), "deployer whitelisted");
        assertEq(timbs.remainingEmissionsCapacity(), timbs.HARD_CAP() - GENESIS);
        assertEq(timbs.entryCostETH(), 0, "placeholder until a price feed exists");
    }

    function test_ConstructorGuards() public {
        vm.expectRevert(TIMBSToken.ZeroAddress.selector);
        new TIMBSToken(address(0), GENESIS, 0);
        vm.expectRevert(TIMBSToken.ZeroAmount.selector);
        new TIMBSToken(TREASURY, 0, 0);
        uint256 cap = 100_000_000e18;
        vm.expectRevert(abi.encodeWithSelector(TIMBSToken.ExceedsHardCap.selector, cap + 1, cap));
        new TIMBSToken(TREASURY, cap + 1, 0);
    }

    // ─── Transfer cap ────────────────────────────────────────────────────────

    function test_CapBlocksOversizedTransfer() public {
        timbs.setMaxTransferAmount(100e18);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(TIMBSToken.ExceedsMaxTransfer.selector, 101e18, 100e18));
        timbs.transfer(BOB, 101e18);
    }

    function test_CapAllowsTransferAtLimit() public {
        timbs.setMaxTransferAmount(100e18);
        vm.prank(ALICE);
        timbs.transfer(BOB, 100e18);
        assertEq(timbs.balanceOf(BOB), 100e18);
    }

    function test_CapZeroDisables() public {
        timbs.setMaxTransferAmount(0);
        vm.prank(ALICE);
        timbs.transfer(BOB, 500_000e18);
        assertEq(timbs.balanceOf(BOB), 500_000e18);
    }

    function test_CapAppliesToTransferFrom() public {
        timbs.setMaxTransferAmount(100e18);
        vm.prank(ALICE);
        timbs.approve(BOB, type(uint256).max);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(TIMBSToken.ExceedsMaxTransfer.selector, 200e18, 100e18));
        timbs.transferFrom(ALICE, BOB, 200e18);
    }

    function test_WhitelistedSenderOrRecipientBypassesCap() public {
        timbs.setMaxTransferAmount(100e18);
        // Whitelisted sender.
        vm.prank(TREASURY);
        timbs.transfer(BOB, 1_000e18);
        // Whitelisted recipient.
        vm.prank(ALICE);
        timbs.transfer(TREASURY, 1_000e18);
        // Newly whitelisted, then removed.
        timbs.setTransferWhitelist(ALICE, true);
        vm.prank(ALICE);
        timbs.transfer(BOB, 1_000e18);
        timbs.setTransferWhitelist(ALICE, false);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(TIMBSToken.ExceedsMaxTransfer.selector, 1_000e18, 100e18));
        timbs.transfer(BOB, 1_000e18);
    }

    function test_CapNeverBlocksMintOrBurn() public {
        timbs.setMaxTransferAmount(1e18);
        timbs.mintEmissions(ALICE, 1_000e18);
        vm.prank(ALICE);
        timbs.burn(1_000e18);
        assertEq(timbs.totalSupply(), GENESIS);
    }

    function test_SetTransferWhitelistRejectsZero() public {
        vm.expectRevert(TIMBSToken.ZeroAddress.selector);
        timbs.setTransferWhitelist(address(0), true);
    }

    // ─── Pause ───────────────────────────────────────────────────────────────

    /// The pause halts transfers AND mint/burn (whenNotPaused sits on _update).
    function test_PauseHaltsTransfersMintAndBurn() public {
        timbs.pause();
        assertTrue(timbs.paused());
        vm.prank(ALICE);
        vm.expectRevert(TIMBSToken.TransferPaused.selector);
        timbs.transfer(BOB, 1e18);
        vm.expectRevert(TIMBSToken.TransferPaused.selector);
        timbs.mintEmissions(ALICE, 1e18);
        vm.prank(ALICE);
        vm.expectRevert(TIMBSToken.TransferPaused.selector);
        timbs.burn(1e18);

        timbs.unpause();
        assertFalse(timbs.paused());
        vm.prank(ALICE);
        timbs.transfer(BOB, 1e18);
    }

    // ─── Minters ─────────────────────────────────────────────────────────────

    function test_PoolsMintAndRotationRevokes() public {
        timbs.setStakingPool(STAKING);
        timbs.setFarmPool(FARM);
        assertTrue(timbs.transferWhitelist(STAKING));
        assertTrue(timbs.transferWhitelist(FARM));
        vm.prank(STAKING);
        timbs.mintEmissions(ALICE, 1e18);
        vm.prank(FARM);
        timbs.mintEmissions(ALICE, 1e18);

        timbs.setStakingPool(address(0x57A2));
        timbs.setFarmPool(address(0xFA13));
        assertFalse(timbs.transferWhitelist(STAKING), "old staking pool loses whitelist");
        assertFalse(timbs.transferWhitelist(FARM), "old farm pool loses whitelist");
        vm.prank(STAKING);
        vm.expectRevert(TIMBSToken.NotAuthorizedMinter.selector);
        timbs.mintEmissions(ALICE, 1e18);
        vm.prank(FARM);
        vm.expectRevert(TIMBSToken.NotAuthorizedMinter.selector);
        timbs.mintEmissions(ALICE, 1e18);
    }

    function test_MintGuards() public {
        vm.expectRevert(TIMBSToken.ZeroAddress.selector);
        timbs.mintEmissions(address(0), 1e18);
        vm.expectRevert(TIMBSToken.ZeroAmount.selector);
        timbs.mintEmissions(ALICE, 0);
        uint256 room = timbs.remainingEmissionsCapacity();
        vm.expectRevert(abi.encodeWithSelector(TIMBSToken.ExceedsHardCap.selector, room + 1, room));
        timbs.mintEmissions(ALICE, room + 1);
        timbs.mintEmissions(ALICE, room);
        assertEq(timbs.totalSupply(), timbs.HARD_CAP());
        assertEq(timbs.remainingEmissionsCapacity(), 0);
    }

    function test_PoolSettersRejectZero() public {
        vm.expectRevert(TIMBSToken.ZeroAddress.selector);
        timbs.setStakingPool(address(0));
        vm.expectRevert(TIMBSToken.ZeroAddress.selector);
        timbs.setFarmPool(address(0));
    }

    // ─── Config ──────────────────────────────────────────────────────────────

    function test_SetTreasuryMovesWhitelist() public {
        timbs.setTreasury(BOB);
        assertEq(timbs.treasury(), BOB);
        assertTrue(timbs.transferWhitelist(BOB));
        assertFalse(timbs.transferWhitelist(TREASURY));
        vm.expectRevert(TIMBSToken.ZeroAddress.selector);
        timbs.setTreasury(address(0));
    }

    function test_SetEmissionRateAndEntryCost() public {
        timbs.setEmissionRate(5_000e18);
        assertEq(timbs.emissionRatePerDay(), 5_000e18);
        timbs.setEntryCostTIMBS(2_000e18);
        assertEq(timbs.entryCostTIMBS(), 2_000e18);
        vm.expectRevert(TIMBSToken.ZeroAmount.selector);
        timbs.setEntryCostTIMBS(0);
    }

    function test_AdminIsOwnerOnly() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, BOB);
        vm.startPrank(BOB);
        vm.expectRevert(err); timbs.setTreasury(BOB);
        vm.expectRevert(err); timbs.setStakingPool(BOB);
        vm.expectRevert(err); timbs.setFarmPool(BOB);
        vm.expectRevert(err); timbs.setEmissionRate(1);
        vm.expectRevert(err); timbs.setEntryCostTIMBS(1);
        vm.expectRevert(err); timbs.setMaxTransferAmount(1);
        vm.expectRevert(err); timbs.setTransferWhitelist(BOB, true);
        vm.expectRevert(err); timbs.pause();
        vm.expectRevert(err); timbs.unpause();
        vm.stopPrank();
    }

    /// Ownership moves only on acceptance (Ownable2Step).
    function test_TwoStepOwnership() public {
        timbs.transferOwnership(BOB);
        assertEq(timbs.owner(), address(this));
        assertEq(timbs.pendingOwner(), BOB);
        vm.prank(BOB);
        timbs.acceptOwnership();
        assertEq(timbs.owner(), BOB);
    }
}
