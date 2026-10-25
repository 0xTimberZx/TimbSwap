// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import {PotCarry} from "./PotCarry.sol";

import {PrizeEscrow} from "../contracts/PrizeEscrow.sol";
import {TimbPrize} from "../contracts/TimbPrize.sol";

/**
 * @title ReleaseRetiredPrize
 * @notice TS-071: the migration runbook's last step for an outgoing prize.
 *         After a migration the old prize stays a retired escrow payer so its
 *         winners can still claim (TS-018). Once its last claim period is over
 *         (its last settled round + 2, counted in rounds of the live game),
 *         run this instead of a bare `escrow.setRetiredPrize(OLD_PRIZE, false)`:
 *         that call alone left the old prize's unclaimed winnings and any
 *         undelivered protocol cut in the escrow, owed to no one.
 *
 *         Delivers the old protocol cut (to PROTOCOL_CUT_TO), revokes the
 *         payer, then carries the old unclaimed pool into the live prize.
 *         Broadcaster must own the escrow, the old prize and the live prize.
 *
 * Env: DEPLOYER_PRIVATE_KEY, PRIZE_ESCROW_ADDR, OLD_PRIZE,
 *      PROTOCOL_CUT_TO (required only if the old prize has a cut accrued).
 *
 *   forge script scripts/ReleaseRetiredPrize.s.sol --rpc-url $RPC --broadcast
 */
contract ReleaseRetiredPrize is PotCarry {
    function run() external {
        uint256 key        = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address escrowAddr = vm.envAddress("PRIZE_ESCROW_ADDR");
        address oldPrize   = vm.envAddress("OLD_PRIZE");
        address cutTo      = vm.envOr("PROTOCOL_CUT_TO", address(0));
        TimbPrize live     = TimbPrize(payable(PrizeEscrow(payable(escrowAddr)).timbPrize()));

        console.log("Old prize:  ", oldPrize);
        console.log("Live prize: ", address(live));

        vm.startBroadcast(key);
        _releaseRetired(oldPrize, escrowAddr, live, vm.addr(key), cutTo);
        vm.stopBroadcast();
    }
}
