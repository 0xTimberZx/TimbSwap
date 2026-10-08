// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";

import {PrizeEscrow} from "../contracts/PrizeEscrow.sol";
import {GameRegistry} from "../contracts/GameRegistry.sol";
import {TimbPrize} from "../contracts/TimbPrize.sol";
import {MockTIMBS} from "./PrizeWindows.t.sol";

/**
 * @title PrizeEscrow accepts ETH only from TimbPrize (fix-list item 11)
 * @notice A direct deposit() or plain transfer would sit outside
 *         TimbPrize.currentAccumulatedRewards and never reach a winner
 *         (TS-006), so both are refused; TimbPrize's own paths still work.
 */
contract EscrowStrayToken is MockTIMBS { function mint(address to, uint256 a) external { _mint(to, a); } }

contract PrizeEscrowDepositGuardTest is Test {
    PrizeEscrow escrow;
    TimbPrize   prize;
    address     stranger = address(0xBAD);

    function setUp() public {
        MockTIMBS timbs = new MockTIMBS();
        escrow = new PrizeEscrow();
        GameRegistry registry = new GameRegistry(address(timbs), address(0xBEEF), address(0), 2e18, 1e18);
        prize = new TimbPrize(address(escrow), address(registry), address(this));
        escrow.setTimbPrize(address(prize));
        vm.deal(stranger, 10 ether);
        vm.deal(address(this), 10 ether);
    }

    function test_DirectDeposit_Reverts() public {
        vm.prank(stranger);
        vm.expectRevert(PrizeEscrow.NotTimbPrize.selector);
        escrow.deposit{value: 1 ether}();
    }

    function test_OwnerDirectDeposit_Reverts() public {
        // The escrow owner is no exception: owner ETH must also go via TimbPrize.
        vm.expectRevert(PrizeEscrow.NotTimbPrize.selector);
        escrow.deposit{value: 1 ether}();
    }

    function test_PlainTransfer_Reverts() public {
        vm.prank(stranger);
        (bool ok,) = payable(address(escrow)).call{value: 1 ether}("");
        assertFalse(ok, "plain ETH transfer must be refused");
        assertEq(address(escrow).balance, 0);
    }

    function test_AddToPot_StillWorks_AndIsCounted() public {
        vm.prank(stranger);
        prize.addToPot{value: 0.4 ether}();
        assertEq(prize.currentAccumulatedRewards(), 0.4 ether);
        assertEq(address(escrow).balance, 0.4 ether);
    }

    function test_FundPot_StillWorks_AndIsCounted() public {
        prize.fundPot{value: 0.6 ether}();
        assertEq(prize.currentAccumulatedRewards(), 0.6 ether);
        assertEq(address(escrow).balance, 0.6 ether);
    }

    function test_DepositBeforePrizeIsSet_Reverts() public {
        PrizeEscrow fresh = new PrizeEscrow();
        vm.expectRevert(PrizeEscrow.NotTimbPrize.selector);
        fresh.deposit{value: 1 ether}();
    }

    function test_RecoveryPath_EmergencyWithdrawThenAddToPot() public {
        // The testnet-surplus recovery: owner pulls ETH out, then re-adds it
        // through TimbPrize so it is counted.
        prize.addToPot{value: 1 ether}();
        uint256 before = address(this).balance;
        escrow.emergencyWithdraw(address(this), 0.5 ether);
        assertEq(address(this).balance, before + 0.5 ether);
        prize.addToPot{value: 0.5 ether}();
        assertEq(address(escrow).balance, 1 ether);
    }

    receive() external payable {}

    // ─── Fix-list 61: stray ERC-20 exit ──────────────────────────────────────
    function test_recoverERC20_sweepsStrayToken() public {
        EscrowStrayToken tok = new EscrowStrayToken();
        tok.mint(address(escrow), 1 ether);
        uint256 ethBefore = address(escrow).balance;
        escrow.recoverERC20(address(tok), address(0x5EEF), 1 ether);
        assertEq(tok.balanceOf(address(0x5EEF)), 1 ether, "swept");
        assertEq(address(escrow).balance, ethBefore, "ETH untouched");
        vm.prank(address(0xBAD));
        vm.expectRevert();
        escrow.recoverERC20(address(tok), address(0xBAD), 1);
    }
}
