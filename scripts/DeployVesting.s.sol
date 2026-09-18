// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import {TimbVesting} from "../contracts/TimbVesting.sol";

/**
 * @title DeployVesting
 * @notice Deploys one {TimbVesting} wallet per beneficiary. It does NOT move
 *         any TIMBS: the allocations sit in the Safe, so funding is a Safe
 *         transaction per wallet, printed at the end as a checklist.
 *
 * Env:
 *   DEPLOYER_PRIVATE_KEY    deployer (gas only; owns nothing afterwards)
 *   TIMBS_ADDRESS           the TIMBS token (for the funding checklist)
 *   VEST_BENEFICIARIES      comma-separated addresses
 *   VEST_AMOUNTS            comma-separated whole-token amounts (18 dec), same order
 *   VEST_CLIFF_SECONDS      e.g. 15552000  (180 days)
 *   VEST_DURATION_SECONDS   e.g. 63072000  (730 days) — the WHOLE window
 *   VEST_START              optional unix seconds; defaults to the current block
 *
 * Era-1 plan (dev-docs/EMISSIONS_SCHEDULE.md §7):
 *   team        7,500,000 TIMBS
 *   founder/dev 6,000,000 TIMBS
 *   cliff 180 d inside a 730 d window → 180/730 unlocks at month six, linear to
 *   month twenty-four. Fund each wallet ONCE, before its cliff.
 */
contract DeployVesting is Script {
    function run() external {
        uint256 pk       = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address timbs    = vm.envAddress("TIMBS_ADDRESS");
        address[] memory bens = vm.envAddress("VEST_BENEFICIARIES", ",");
        uint256[] memory amts = vm.envUint("VEST_AMOUNTS", ",");
        uint64 cliff     = uint64(vm.envUint("VEST_CLIFF_SECONDS"));
        uint64 duration  = uint64(vm.envUint("VEST_DURATION_SECONDS"));
        uint64 start     = uint64(vm.envOr("VEST_START", block.timestamp));

        require(bens.length > 0, "VEST_BENEFICIARIES is empty");
        require(bens.length == amts.length, "VEST_BENEFICIARIES / VEST_AMOUNTS length mismatch");
        require(cliff <= duration, "VEST_CLIFF_SECONDS > VEST_DURATION_SECONDS");
        for (uint256 i = 0; i < bens.length; i++) {
            require(bens[i] != address(0), "zero beneficiary");
            require(amts[i] > 0, "zero amount");
        }

        console.log("TimbVesting deploy");
        console.log("  timbs    :", timbs);
        console.log("  start    :", start);
        console.log("  cliff    :", cliff, "s");
        console.log("  duration :", duration, "s");

        vm.startBroadcast(pk);
        address[] memory wallets = new address[](bens.length);
        for (uint256 i = 0; i < bens.length; i++) {
            TimbVesting w = new TimbVesting(bens[i], start, cliff, duration);
            wallets[i] = address(w);
            console.log("  wallet", i, "->", address(w));
            console.log("    beneficiary:", bens[i]);
        }
        vm.stopBroadcast();

        // Nothing has been funded. Print the exact Safe transfers so launch day is
        // paste-and-sign, and so the amounts on this doc and on-chain cannot drift.
        console.log("");
        console.log("FUND FROM THE SAFE (one ERC20 transfer per wallet, before the cliff):");
        for (uint256 i = 0; i < bens.length; i++) {
            console.log(
                string.concat("  TIMBS.transfer(", vm.toString(wallets[i]), ", ", vm.toString(amts[i]), ")")
            );
        }
        console.log("Verify each on-chain afterwards:");
        console.log("  cast call <wallet> 'releasable(address)(uint256)' <TIMBS>   # 0 until the cliff");
        console.log("  cast call <TIMBS>  'balanceOf(address)(uint256)' <wallet>   # == the amount above");
    }
}
