// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import {TimbPrize} from "../contracts/TimbPrize.sol";
import {VRFEntropy} from "../contracts/VRFEntropy.sol";
import {GameRegistry} from "../contracts/GameRegistry.sol";
import {PrizeEscrow} from "../contracts/PrizeEscrow.sol";
import {TimbSwapRouter} from "../contracts/TimbSwapRouter.sol";
import {EligibleTokenRegistry} from "../contracts/EligibleTokenRegistry.sol";

/**
 * @title DeployPrizeVRFMigration
 * @notice TARGETED H1 migration: deploy a new VRF-backed TimbPrize + its
 *         VRFEntropy and re-point the EXISTING registry / escrow / router /
 *         eligible-registry at it. Everything else (TIMBS, AMM, farms, the
 *         registry itself and its escrow) is reused — this only swaps the prize.
 *
 * Why: H1 (#333) migrated the prize game off grindable blockhash onto Chainlink
 * VRF, but the change only landed in code. The deployed prize is still pre-H1,
 * so the H1 settler's entropy()/arm→lock calls revert. This script brings the
 * chain up to the code.
 *
 * Generation-safe: the new prize's startGame() calls registry.onGameStarted(),
 * which bumps the generation — the prior game's tickets retire (reclaimable via
 * reclaimFromPastGame) and round numbering restarts at 1. So this is a clean new
 * game epoch, not an in-place edit of live round state.
 *
 * startGame() is NOT called here — do it as a runbook step AFTER the VRF
 * subscription lists the new entropy as a consumer and is funded (see
 * dev-docs/H1_TESTNET_DEPLOY.md). Deploying + wiring is safe to do first; the
 * game only needs VRF once a segment actually settles.
 *
 * Env (.env — never commit):
 *   DEPLOYER_PRIVATE_KEY    deployer wallet (current owner of the contracts below)
 *   GAME_REGISTRY_ADDR      existing GameRegistry (from config.js)
 *   PRIZE_ESCROW_ADDR       existing PrizeEscrow
 *   ROUTER_ADDR             existing TimbSwapRouter
 *   ELIGIBLE_REGISTRY_ADDR  existing EligibleTokenRegistry
 *   VRF_COORDINATOR         Chainlink VRF v2.5 coordinator (Arbitrum Sepolia)
 *   VRF_KEY_HASH            gas lane
 *   VRF_SUB_ID              subscription this prize entropy consumes
 *   VRF_EXTRA_ARGS          v2.5 extraArgs blob (hex)
 *   VRF_CONFIRMATIONS       optional, default 3
 *   VRF_CALLBACK_GAS        optional, default 200000
 *
 * Run:
 *   forge script scripts/DeployPrizeVRFMigration.s.sol \
 *     --rpc-url $ARB_SEPOLIA_RPC --broadcast -vvvv
 */
contract DeployPrizeVRFMigration is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        address registryAddr = vm.envAddress("GAME_REGISTRY_ADDR");
        address escrowAddr    = vm.envAddress("PRIZE_ESCROW_ADDR");
        address routerAddr    = vm.envAddress("ROUTER_ADDR");
        address eligibleAddr  = vm.envAddress("ELIGIBLE_REGISTRY_ADDR");

        address vrfCoordinator = vm.envAddress("VRF_COORDINATOR");
        bytes32 vrfKeyHash     = vm.envBytes32("VRF_KEY_HASH");
        uint256 vrfSubId       = vm.envUint("VRF_SUB_ID");
        bytes memory vrfExtra  = vm.envBytes("VRF_EXTRA_ARGS");
        uint16  vrfConfs       = uint16(vm.envOr("VRF_CONFIRMATIONS", uint256(3)));
        uint32  vrfCbGas       = uint32(vm.envOr("VRF_CALLBACK_GAS", uint256(200_000)));

        vm.startBroadcast(deployerKey);

        // 1. Prize VRF entropy (dedicated instance, mirrors the board's path).
        VRFEntropy prizeEntropy = new VRFEntropy(
            vrfCoordinator, vrfKeyHash, vrfSubId, vrfConfs, vrfCbGas, vrfExtra
        );
        console.log("Prize VRFEntropy:   ", address(prizeEntropy));

        // 2. New H1 TimbPrize, constructed against the EXISTING escrow/registry/router.
        TimbPrize prize = new TimbPrize(escrowAddr, registryAddr, routerAddr);
        console.log("New TimbPrize:      ", address(prize));

        // 3. Wire entropy both ways (setBoard is one-time on the fresh entropy).
        prizeEntropy.setBoard(address(prize));
        prize.setEntropy(address(prizeEntropy));

        // 4. Point the new prize at the existing dependencies. Escrow + registry
        //    are already set via the constructor; set the eligible registry too.
        prize.setEligibleRegistry(eligibleAddr);

        // 5. Re-point the existing contracts at the NEW prize (owner-only setters).
        //    PrizeEscrow and TimbSwapRouter have payable receive()s, so their
        //    contract type must be cast from a `payable` address.
        GameRegistry(registryAddr).setTimbPrize(address(prize));
        PrizeEscrow(payable(escrowAddr)).setTimbPrize(address(prize));
        TimbSwapRouter(payable(routerAddr)).setTimbPrize(address(prize));
        EligibleTokenRegistry(eligibleAddr).registerConsumer(address(prize));

        vm.stopBroadcast();

        console.log("\n========== PRIZE VRF MIGRATION COMPLETE ==========");
        console.log("New TimbPrize:      ", address(prize));
        console.log("Prize VRFEntropy:   ", address(prizeEntropy));
        console.log("=================================================");
        console.log("");
        console.log("NEXT (runbook, dev-docs/H1_TESTNET_DEPLOY.md):");
        console.log("1. Add the Prize VRFEntropy as a consumer on VRF sub", vrfSubId);
        console.log("2. Fund the subscription (LINK or native)");
        console.log("3. Update config.js: TimbPrize -> new address (+ record the entropy)");
        console.log("4. Call new TimbPrize.startGame()  (bumps generation, opens round 1)");
        console.log("5. Re-enable the TimbSwap Settler workflow");
    }
}
