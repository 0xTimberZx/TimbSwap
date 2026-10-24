// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {PrizeWindowsTest} from "./PrizeWindows.t.sol";
import {TimbPrize} from "../contracts/TimbPrize.sol";

/// @dev Yield vault stand-in: harvest() pays `sendNext` to the prize and
///      reports `reportNext` (equal unless a test wants a lying vault).
contract HarvestVaultMock {
    uint256 public sendNext;
    uint256 public reportNext;
    function set(uint256 send_, uint256 report_) external { sendNext = send_; reportNext = report_; }
    function harvest() external returns (uint256) {
        if (sendNext > 0) {
            (bool ok,) = payable(msg.sender).call{value: sendNext}("");
            require(ok, "pay");
        }
        return reportNext;
    }
    receive() external payable {}
}

/**
 * TS-063: when PrizeEscrow rejected a harvest deposit, the ETH stayed on
 * TimbPrize and the comment said it "self-heals on the next successful
 * deposit". It never did: _harvestYield forwarded min(harvested, balance),
 * i.e. only the current harvest, and TimbPrize has no other ETH exit. It now
 * forwards the whole balance (only the vault can send ETH here, and
 * fundPot/addToPot forward msg.value straight on), so the next successful
 * settlement recovers and credits anything stranded.
 */
contract PrizeHarvestStrandedTest is PrizeWindowsTest {
    HarvestVaultMock vault;

    function _setUpVault() internal {
        vault = new HarvestVaultMock();
        vm.deal(address(vault), 10 ether);
        prize.setYieldVault(address(vault));
    }

    /// Settle the current round; return the amount of the prize's harvest
    /// event for it (YieldHarvested or YieldDepositFailed), 0 if none.
    function _settleRound(bytes32 topic) internal returns (uint256 amount) {
        uint256 round = prize.currentRound();
        vm.recordLogs();
        runUntilRound(round + 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(prize) && logs[i].topics[0] == topic && uint256(logs[i].topics[1]) == round) {
                amount += abi.decode(logs[i].data, (uint256));
            }
        }
    }
    bytes32 constant HARVESTED = keccak256("YieldHarvested(uint256,uint256)");
    bytes32 constant FAILED    = keccak256("YieldDepositFailed(uint256,uint256)");

    /// Strand 0.1 ETH: harvest while the escrow points at another prize.
    function _strand() internal {
        _setUpVault();
        vault.set(0.1 ether, 0.1 ether);
        escrow.setTimbPrize(address(0xBEEF2));        // mis-wired: deposit() reverts
        assertEq(_settleRound(FAILED), 0.1 ether, "deposit rejected");
        assertEq(address(prize).balance, 0.1 ether, "harvest stranded on the prize");
        escrow.setTimbPrize(address(prize));          // wiring repaired
    }

    function test_TS063_StrandedHarvestRecoveredOnNextDeposit() public {
        _strand();
        vault.set(0.05 ether, 0.05 ether);
        uint256 escrowBefore = address(escrow).balance;
        assertEq(_settleRound(HARVESTED), 0.15 ether, "stranded + new harvest credited");
        assertEq(address(prize).balance, 0, "nothing left stranded");
        assertEq(address(escrow).balance - escrowBefore, 0.15 ether, "both harvests reach the escrow");
    }

    /// The sweep does not wait for a non-zero harvest.
    function test_TS063_RecoveredEvenWhenNextHarvestIsZero() public {
        _strand();
        vault.set(0, 0);
        assertEq(_settleRound(HARVESTED), 0.1 ether, "stranded harvest credited");
        assertEq(address(prize).balance, 0, "stranded ETH swept on a zero harvest");
    }

    /// M2 still holds: a vault that reports more than it sent cannot make the
    /// deposit revert (only what the prize holds is forwarded).
    function test_TS063_OverReportingVaultCannotBrickSettlement() public {
        _setUpVault();
        vault.set(0.02 ether, 5 ether);
        uint256 round = prize.currentRound();
        assertEq(_settleRound(HARVESTED), 0.02 ether, "only what was received");
        assertEq(prize.currentRound(), round + 1, "round settled");
        assertEq(address(prize).balance, 0);
    }

    /// Nothing held, nothing harvested: no deposit, no event, no revert.
    function test_TS063_EmptyBalanceIsANoOp() public {
        _setUpVault();
        vault.set(0, 0);
        uint256 escrowBefore = address(escrow).balance;
        assertEq(_settleRound(HARVESTED), 0, "no harvest event");
        assertEq(address(escrow).balance, escrowBefore);
    }
}
