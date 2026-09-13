// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import {TimbAirdropDistributor} from "../contracts/TimbAirdropDistributor.sol";

/**
 * @title DeployAirdropDistributor
 * @notice Deploys the cross-chain TIMB airdrop sink on ARBITRUM ONE. The deployer
 *         becomes owner and this script sets the dispatcher, guardian, and caps
 *         (caps also passed to the constructor).
 *
 * AFTER (owner = the Safe, ideally): pre-fund the TIMB float
 * (`timbs.transfer(distributor, budget)` — a SMALL amount you'd accept losing),
 * then transferOwnership(Safe) + accept (Ownable2Step). The float, not the code,
 * is your value-at-risk — keep it capped.
 *
 * Env (.env — never commit):
 *   DEPLOYER_PRIVATE_KEY        deployer wallet key (becomes owner)
 *   TIMBS_ADDRESS               TIMBS on Arbitrum One (0x44BC...eA1)
 *   AIRDROP_DISPATCHER          the off-chain dispatcher hot wallet
 *   AIRDROP_GUARDIAN            fast pause key (optional; 0x0 to skip)
 *   AIRDROP_AMOUNT_PER_CLAIM    TIMB (18dp) per recipient (e.g. 1e18 = 1 TIMB)
 *   AIRDROP_TOTAL_CAP           cumulative max TIMB (18dp) to ever distribute
 *   AIRDROP_PER_ROUND_CAP       max TIMB (18dp) per round
 */
contract DeployAirdropDistributor is Script {
    function run() external {
        uint256 pk         = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address timbs      = vm.envAddress("TIMBS_ADDRESS");
        address dispatcher = vm.envAddress("AIRDROP_DISPATCHER");
        address guardian   = vm.envOr("AIRDROP_GUARDIAN", address(0));
        uint256 amount     = vm.envUint("AIRDROP_AMOUNT_PER_CLAIM");
        uint256 totalCap   = vm.envUint("AIRDROP_TOTAL_CAP");
        uint256 roundCap   = vm.envUint("AIRDROP_PER_ROUND_CAP");

        vm.startBroadcast(pk);

        TimbAirdropDistributor d = new TimbAirdropDistributor(timbs, amount, totalCap, roundCap);
        d.setDispatcher(dispatcher);
        if (guardian != address(0)) d.setGuardian(guardian);

        vm.stopBroadcast();

        console.log("TimbAirdropDistributor deployed:", address(d));
        console.log("  timbs:          ", timbs);
        console.log("  dispatcher:     ", dispatcher);
        console.log("  guardian:       ", guardian);
        console.log("  amountPerClaim: ", amount);
        console.log("  totalCap:       ", totalCap);
        console.log("  perRoundCap:    ", roundCap);
        console.log("");
        console.log("NEXT: pre-fund a SMALL TIMB float (timbs.transfer to the address above),");
        console.log("      set DISTRIBUTOR_ADDRESS in the airdrop-dispatch edge fn,");
        console.log("      then transferOwnership(Safe) + accept.");
    }
}
