// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import {PrizeEscrow} from "../contracts/PrizeEscrow.sol";
import {TimbPrize} from "../contracts/TimbPrize.sol";

interface IOutgoingPot { function currentAccumulatedRewards() external view returns (uint256); }

/**
 * @title PotCarry
 * @notice TS-067: carry the outgoing game's live pot into the new prize at a
 *         migration. Repointing the escrow leaves the outgoing pot's ETH in
 *         PrizeEscrow while the new prize starts at currentAccumulatedRewards
 *         = 0, so it was owed to no one (only emergencyWithdraw could reach it,
 *         and no runbook step called it).
 *
 *         The carry is the outgoing prize's `currentAccumulatedRewards`, the
 *         unallocated live pot. Settled winnings still owed to its winners are
 *         not part of that counter and stay in the escrow for their claims.
 *         Call it after the escrow points at the new prize (its deposit only
 *         accepts the live prize), from the owner of both the escrow and the
 *         new prize. The outgoing prize's counter is left as a stale figure;
 *         a retired prize never settles, so nothing pays from it again.
 */
abstract contract PotCarry is Script {
    function _carryPot(address oldPrize, address escrowAddr, TimbPrize newPrize, address payout)
        internal
        returns (uint256 carry)
    {
        try IOutgoingPot(oldPrize).currentAccumulatedRewards() returns (uint256 c) {
            carry = c;
        } catch {
            console.log("!! TS-067: outgoing pot unreadable -- carry it by hand (emergencyWithdraw + fundPot):", oldPrize);
            return 0;
        }
        if (carry == 0) {
            console.log("TS-067: outgoing pot is empty, nothing to carry");
            return 0;
        }
        require(escrowAddr.balance >= carry, "TS-067: escrow holds less than the outgoing pot");
        require(PrizeEscrow(payable(escrowAddr)).timbPrize() == address(newPrize), "TS-067: repoint the escrow first");

        uint256 before = newPrize.currentAccumulatedRewards();
        PrizeEscrow(payable(escrowAddr)).emergencyWithdraw(payout, carry);
        newPrize.fundPot{value: carry}();
        require(newPrize.currentAccumulatedRewards() == before + carry, "TS-067: carry not credited");
        console.log("TS-067: carried the outgoing pot into the new prize (wei):", carry);
    }
}
