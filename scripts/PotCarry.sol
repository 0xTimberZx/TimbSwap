// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import {PrizeEscrow} from "../contracts/PrizeEscrow.sol";
import {TimbPrize} from "../contracts/TimbPrize.sol";

interface IOutgoingPot {
    function currentAccumulatedRewards() external view returns (uint256);
    function currentRound() external view returns (uint256);
    function gameUnclaimed_winningsPool() external view returns (uint256);
    function protocolCutAccrued() external view returns (uint256);
    function roundPerWinnerAmount(uint256 round) external view returns (uint256);
    function roundRecycled(uint256 round) external view returns (bool);
    function roundWinners(uint256 round, uint256 i) external view returns (address);
    function hasClaimed(uint256 round, address winner) external view returns (bool);
    function recycleUnclaimed(uint256 round) external;
    function withdrawProtocolCut(address to) external;
}

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
 *
 *         TS-071: the carry missed the outgoing game's unclaimed winnings.
 *         (1) Shares whose claim window had closed but that nobody had
 *         recycled sat in gameUnclaimed_winningsPool; recycling them after the
 *         migration only credits the retired prize. `_carryPot` now recycles
 *         every expired round first, so they ride the carry. (2) retire()
 *         freezes currentRound, so the last settled rounds can never be
 *         recycled, and once the runbook revokes the retired payer their
 *         unclaimed shares can be neither claimed nor recycled.
 *         `_releaseRetired` is that runbook step: it delivers the old prize's
 *         protocol cut while it can still pay, revokes it, then carries what
 *         is left unclaimed into the live prize.
 */
abstract contract PotCarry is Script {
    /// TimbPrize.CLAIM_WINDOW_ROUNDS: a round's shares are claimable while
    /// currentRound <= round + 2 and recyclable after.
    uint256 internal constant CLAIM_WINDOW_ROUNDS = 2;

    function _carryPot(address oldPrize, address escrowAddr, TimbPrize newPrize, address payout)
        internal
        returns (uint256 carry)
    {
        _recycleExpired(oldPrize);
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

    /// @dev TS-071 (1): recycle every settled round whose claim window has
    ///      closed and that still holds an unclaimed share, moving it from
    ///      gameUnclaimed_winningsPool into currentAccumulatedRewards before the
    ///      carry reads it. recycleUnclaimed is permissionless and only moves
    ///      counters, so it works on a retired prize too. Reads are free in a
    ///      script; only rounds with something to recycle are sent.
    function _recycleExpired(address oldPrize) internal returns (uint256 rounds) {
        IOutgoingPot p = IOutgoingPot(oldPrize);
        uint256 cur;
        try p.currentRound() returns (uint256 c) { cur = c; } catch {
            console.log("!! TS-071: outgoing round unreadable -- recycle expired rounds by hand:", oldPrize);
            return 0;
        }
        try p.gameUnclaimed_winningsPool() returns (uint256 pool) {
            if (pool == 0) return 0;
        } catch {
            return 0;
        }
        for (uint256 r = 1; r + CLAIM_WINDOW_ROUNDS < cur; r++) {
            if (!_hasUnclaimed(p, r)) continue;
            try p.recycleUnclaimed(r) {
                rounds++;
            } catch {
                console.log("!! TS-071: recycleUnclaimed failed for round", r);
            }
        }
        if (rounds > 0) console.log("TS-071: recycled expired rounds before the carry:", rounds);
    }

    function _hasUnclaimed(IOutgoingPot p, uint256 r) private view returns (bool open) {
        try p.roundPerWinnerAmount(r) returns (uint256 share) {
            if (share == 0) return false;
        } catch {
            return false;
        }
        try p.roundRecycled(r) returns (bool done) {
            if (done) return false;
        } catch {
            return false;
        }
        for (uint256 i = 0; ; i++) {
            try p.roundWinners(r, i) returns (address w) {
                if (!p.hasClaimed(r, w)) return true;
            } catch {
                return false; // past the last winner
            }
        }
    }

    /// @dev TS-071 (2): the runbook's "revoke the retired payer" step. Run it
    ///      once the old prize's last claim period is over. Order matters:
    ///      the protocol cut is delivered while the old prize can still pay;
    ///      the revoke then ends claims, so nothing can be paid twice; what is
    ///      left in the old prize's unclaimed pool is carried into the live
    ///      prize. Its books keep listing those shares, but it has no pay right.
    function _releaseRetired(address oldPrize, address escrowAddr, TimbPrize livePrize, address payout, address cutTo)
        internal
        returns (uint256 owed)
    {
        PrizeEscrow escrow = PrizeEscrow(payable(escrowAddr));
        require(oldPrize != address(livePrize), "TS-071: old prize is the live prize");
        require(escrow.timbPrize() == address(livePrize), "TS-071: escrow must point at the live prize");
        require(escrow.retiredPrize(oldPrize), "TS-071: old prize is not a retired payer (already revoked?)");

        IOutgoingPot p = IOutgoingPot(oldPrize);
        uint256 cut = p.protocolCutAccrued();
        if (cut > 0) {
            require(cutTo != address(0), "TS-071: old prize has an undelivered protocol cut; set PROTOCOL_CUT_TO");
            p.withdrawProtocolCut(cutTo);
            console.log("TS-071: delivered the old prize's protocol cut (wei):", cut);
        }

        owed = p.gameUnclaimed_winningsPool();
        escrow.setRetiredPrize(oldPrize, false);
        console.log("TS-071: revoked the retired payer:", oldPrize);

        if (owed == 0) {
            console.log("TS-071: no unclaimed winnings left on the old prize");
            return 0;
        }
        require(escrowAddr.balance >= owed, "TS-071: escrow holds less than the old unclaimed pool");
        uint256 before = livePrize.currentAccumulatedRewards();
        escrow.emergencyWithdraw(payout, owed);
        livePrize.fundPot{value: owed}();
        require(livePrize.currentAccumulatedRewards() == before + owed, "TS-071: release not credited");
        console.log("TS-071: carried the old prize's unclaimed winnings into the live pot (wei):", owed);
    }
}
