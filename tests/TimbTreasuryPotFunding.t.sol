// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";

import {PrizeEscrow} from "../contracts/PrizeEscrow.sol";
import {GameRegistry} from "../contracts/GameRegistry.sol";
import {TimbPrize} from "../contracts/TimbPrize.sol";
import {TimbTreasury} from "../contracts/TimbTreasury.sol";
import {MockTIMBS} from "./PrizeWindows.t.sol";

/**
 * @title TimbTreasury.distributeToPot funds the claimable pot (TS-006)
 * @notice The treasury must credit TimbPrize.currentAccumulatedRewards, the
 *         only counter settlement pays from, not just deposit into the escrow.
 */
contract TimbTreasuryPotFundingTest is Test {
    MockTIMBS    timbs;
    PrizeEscrow  escrow;
    TimbPrize    prize;
    TimbTreasury treasury;

    function setUp() public {
        timbs  = new MockTIMBS();
        escrow = new PrizeEscrow();
        GameRegistry registry = new GameRegistry(address(timbs), address(0xBEEF), address(0), 2e18, 1e18);
        prize  = new TimbPrize(address(escrow), address(registry), address(this));
        escrow.setTimbPrize(address(prize));
        treasury = new TimbTreasury(address(timbs), address(0x5742), address(escrow), address(0x9A1B), address(0x3E7));
        vm.deal(address(treasury), 5 ether);
    }

    function test_DistributeToPot_CreditsThePot() public {
        uint256 potBefore    = prize.currentAccumulatedRewards();
        uint256 escrowBefore = address(escrow).balance;

        treasury.distributeToPot(1 ether);

        assertEq(prize.currentAccumulatedRewards(), potBefore + 1 ether, "pot counter credited");
        assertEq(address(escrow).balance, escrowBefore + 1 ether, "ETH held by the escrow");
        assertEq(address(treasury).balance, 4 ether);
        assertEq(treasury.totalPotFunded(), 1 ether);
        // Every wei in the escrow is claimable pot: nothing stranded.
        assertEq(address(escrow).balance, prize.currentAccumulatedRewards(), "escrow == pot");
    }

    function test_DistributeToPot_RepeatedTopUpsAllCounted() public {
        treasury.distributeToPot(0.3 ether);
        treasury.distributeToPot(0.2 ether);
        assertEq(prize.currentAccumulatedRewards(), 0.5 ether);
        assertEq(address(escrow).balance, 0.5 ether);
        assertEq(treasury.totalPotFunded(), 0.5 ether);
    }

    function test_DistributeToPot_OnlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert();
        treasury.distributeToPot(1 ether);
    }

    function test_DistributeToPot_RevertsWhenEscrowHasNoPrize() public {
        PrizeEscrow bare = new PrizeEscrow();
        TimbTreasury t = new TimbTreasury(address(timbs), address(0x5742), address(bare), address(0x9A1B), address(0x3E7));
        vm.deal(address(t), 1 ether);
        vm.expectRevert(TimbTreasury.ZeroAddress.selector);
        t.distributeToPot(1 ether);
    }

    function test_DistributeToPot_RevertsOnEscrowMismatch() public {
        // An escrow that names this prize, while the prize deposits elsewhere:
        // funding would credit a pot whose ETH lands in a different escrow.
        PrizeEscrow other = new PrizeEscrow();
        other.setTimbPrize(address(prize));
        TimbTreasury t = new TimbTreasury(address(timbs), address(0x5742), address(other), address(0x9A1B), address(0x3E7));
        vm.deal(address(t), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(TimbTreasury.EscrowMismatch.selector, address(prize)));
        t.distributeToPot(1 ether);
    }
}
