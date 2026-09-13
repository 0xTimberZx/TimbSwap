// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import {GasFaucet} from "../contracts/GasFaucet.sol";

/**
 * @title DeployFaucet
 * @notice Deploys GasFaucet against an ALREADY-LIVE deployment (testnet: Arbitrum
 *         Sepolia). GameRegistry / TimbPrize / TIMBSToken / TimbTreasury must
 *         already exist — paste their addresses from the env. The deployer becomes
 *         the faucet owner and this script sets its dispatcher, guardian, and caps.
 *
 * WHAT THIS SCRIPT DOES (deployer = faucet owner):
 *   1. deploy GasFaucet(treasury, timbs, registry, prize, drip, pot, perClaim, cooldown)
 *   2. setDispatcher(FAUCET_DISPATCHER)   — the keeper hot wallet
 *   3. setGuardian(FAUCET_GUARDIAN)       — fast pause key (0 to skip)
 *   4. setEthCap / setTimbsCap            — cumulative approved ceilings
 *
 * WHAT YOU MUST DO AFTER (owner = the TREASURY's owner, i.e. the Safe — NOT this
 * script's deployer, so they can't be scripted here):
 *   a. treasury.setOperator(faucet)                    — allow ETH pulls
 *   b. treasury.setOperatorEthCap(<amount>, <window>)  — 2nd ETH ceiling
 *   c. treasury.withdrawToken(timbs, faucet, <budget>) — PRE-FUND the TIMBS leg
 *   d. (optional) faucet.transferOwnership(Safe) + Safe accepts (Ownable2Step)
 * Without (a)/(b) the ETH legs revert; without (c) the TIMBS leg reverts on
 * InsufficientTimbsBalance. See dev-docs/FAUCET_SPEC.md.
 *
 * Env (.env — never commit):
 *   DEPLOYER_PRIVATE_KEY     deployer wallet key (becomes faucet owner)
 *   TREASURY_ADDRESS         TimbTreasury
 *   TIMBS_ADDRESS            TIMBSToken
 *   GAME_REGISTRY_ADDRESS    GameRegistry (eligibility oracle)
 *   TIMBPRIZE_ADDRESS        TimbPrize (pot sink)
 *   FAUCET_DISPATCHER        keeper hot wallet (may dispense)
 *   FAUCET_GUARDIAN          fast pause key (optional; 0x0 to skip)
 *   FAUCET_DRIP_ETH          wei to the claimant per claim      (e.g. 5e12 = 0.000005)
 *   FAUCET_POT_ETH           wei to the pot per claim           (e.g. 5e12)
 *   FAUCET_TIMBS_PER_CLAIM   TIMBS (18dp) per claim             (e.g. 1e18 = 1 TIMB)
 *   FAUCET_COOLDOWN          seconds between claims per wallet  (e.g. 86400 = 24h)
 *   FAUCET_ETH_CAP           cumulative max ETH (wei) to ever distribute
 *   FAUCET_TIMBS_CAP         cumulative max TIMBS (18dp) to ever distribute
 */
contract DeployFaucet is Script {
    function run() external {
        uint256 pk        = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address treasury  = vm.envAddress("TREASURY_ADDRESS");
        address timbs     = vm.envAddress("TIMBS_ADDRESS");
        address registry  = vm.envAddress("GAME_REGISTRY_ADDRESS");
        address prize     = vm.envAddress("TIMBPRIZE_ADDRESS");

        address dispatcher = vm.envAddress("FAUCET_DISPATCHER");
        address guardian   = vm.envOr("FAUCET_GUARDIAN", address(0));

        uint256 dripEth       = vm.envUint("FAUCET_DRIP_ETH");
        uint256 potEth        = vm.envUint("FAUCET_POT_ETH");
        uint256 timbsPerClaim = vm.envUint("FAUCET_TIMBS_PER_CLAIM");
        uint256 cooldown      = vm.envUint("FAUCET_COOLDOWN");
        uint256 ethCap        = vm.envUint("FAUCET_ETH_CAP");
        uint256 timbsCap      = vm.envUint("FAUCET_TIMBS_CAP");

        vm.startBroadcast(pk);

        GasFaucet faucet = new GasFaucet(
            treasury, timbs, registry, prize,
            dripEth, potEth, timbsPerClaim, cooldown
        );
        faucet.setDispatcher(dispatcher);
        if (guardian != address(0)) faucet.setGuardian(guardian);
        faucet.setEthCap(ethCap);
        faucet.setTimbsCap(timbsCap);

        vm.stopBroadcast();

        console.log("GasFaucet deployed:", address(faucet));
        console.log("  dispatcher:", dispatcher);
        console.log("  guardian:  ", guardian);
        console.log("  ethCap:    ", ethCap);
        console.log("  timbsCap:  ", timbsCap);
        console.log("");
        console.log("NEXT (owner of the TREASURY / Safe, not the deployer):");
        console.log("  1. treasury.setOperator(faucet)");
        console.log("  2. treasury.setOperatorEthCap(amount, window)");
        console.log("  3. treasury.withdrawToken(timbs, faucet, budget)  # pre-fund TIMBS");
        console.log("  4. set GasFaucet in config.js ADDRESSES to the address above");
    }
}
