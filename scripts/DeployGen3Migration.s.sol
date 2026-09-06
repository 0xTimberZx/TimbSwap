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

/// @dev Minimal admin surface for the reused TimbYieldVault — repoint it at the
///      NEW registry so register()/remove() (both onlyGameRegistry) accept the
///      new registry as caller. See scripts/vault-weight.js for the full ABI.
interface IYieldVaultAdmin {
    function setGameRegistry(address) external;
    function gameRegistry() external view returns (address);
}

/**
 * @title DeployGen3Migration
 * @notice GEN-3 re-migration: deploy an ALIGNED prize game — a fresh
 *         GameRegistry (with the PERMISSIONLESS activateRoundEntries the keeper
 *         needs) + a fresh TimbPrize + its Prize VRFEntropy — and repoint every
 *         reused contract (escrow, router, eligible registry, yield vault) at
 *         the new pair. TIMBS, the AMM, farms, staking and the vault's reserve
 *         are all reused.
 *
 * WHY (the bug this fixes):
 *   The live GameRegistry (0xBAb1CB…) is an OLDER compile whose
 *   activateRoundEntries is `onlyTimbPrize`. The live TimbPrize (0x5AED…) is the
 *   H2 "keeper-driven" version that DELEGATES activation to a permissionless
 *   keeper and only self-activates round 1 in startGame(). So for every round
 *   after the first, the keeper's activateRoundEntries call reverts NotTimbPrize
 *   (0x3e94dce9) and TimbPrize never calls it — nobody activates entries, and
 *   every ticket sticks "Pending" forever. Confirmed on-chain via eth_call:
 *   activateRoundEntries(round, [player]) reverts NotTimbPrize from any EOA and
 *   succeeds only from TimbPrize.
 *
 *   The repo's current contracts/GameRegistry.sol already has the fix
 *   (activateRoundEntries is `external`, gated only by `round == currentRound`,
 *   with a try/catch-fenced vault call). This script deploys THAT registry and a
 *   matching prize so the keeper-driven design and the registry finally agree.
 *
 *   TimbPrize.gameRegistry is fixed at construction and the live prize is already
 *   started (round 5), so it cannot re-run startGame() to init a fresh registry —
 *   hence a fresh prize, not a registry-only swap.
 *
 * GENERATION / OLD TICKETS:
 *   This is a brand-new registry. The prior game's tickets live entirely in the
 *   OLD registry (0xBAb1CB…) and are NOT carried over — they hold principal
 *   there and must be user-reclaimed from the old registry (see runbook). The
 *   new prize's startGame() calls the new registry's onGameStarted() (fresh
 *   epoch, round 1) — run it as a runbook step AFTER the VRF sub lists the new
 *   entropy as a consumer and is funded.
 *
 * Env (.env — never commit):
 *   DEPLOYER_PRIVATE_KEY    deployer wallet (owner of the reused contracts below)
 *   TIMBS_TOKEN_ADDR        TIMBSToken (config.js ADDRESSES.TIMBSToken)
 *   PROTOCOL_SINK_ADDR      lapsed-revenue sink — copy the CURRENT value:
 *                             cast call <OLD_REGISTRY> "protocolSink()(address)"
 *   PRIZE_ESCROW_ADDR       existing PrizeEscrow (reused, repointed)
 *   ROUTER_ADDR             existing TimbSwapRouter (reused, repointed)
 *   ELIGIBLE_REGISTRY_ADDR  existing EligibleTokenRegistry (reused, repointed)
 *   YIELD_VAULT_ADDR        existing TimbYieldVault (reused, repointed)
 *   SETTLER_ADDR            optional — keeper EOA authorised for settleSegment()
 *   VRF_COORDINATOR         Chainlink VRF v2.5 coordinator (Arbitrum Sepolia)
 *   VRF_KEY_HASH            gas lane
 *   VRF_SUB_ID              subscription this prize entropy consumes
 *   VRF_EXTRA_ARGS          v2.5 extraArgs blob (hex). COPY VERBATIM from the live
 *                             entropy — `cast call <OLD_ENTROPY> "extraArgs()(bytes)"`.
 *                             Do NOT re-encode: the deployed coordinator rejects the
 *                             canonical 36-byte _argsToBytes blob with an empty-data
 *                             revert at the first segment arm. See GEN3_MIGRATION.md.
 *   VRF_CONFIRMATIONS       optional, default 3
 *   VRF_CALLBACK_GAS        optional, default 200000
 *
 * Run:
 *   forge script scripts/DeployGen3Migration.s.sol \
 *     --rpc-url $ARB_SEPOLIA_RPC --broadcast -vvvv
 */
contract DeployGen3Migration is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        address timbsToken   = vm.envAddress("TIMBS_TOKEN_ADDR");
        address protocolSink = vm.envAddress("PROTOCOL_SINK_ADDR");
        address escrowAddr   = vm.envAddress("PRIZE_ESCROW_ADDR");
        address routerAddr   = vm.envAddress("ROUTER_ADDR");
        address eligibleAddr = vm.envAddress("ELIGIBLE_REGISTRY_ADDR");
        address vaultAddr    = vm.envAddress("YIELD_VAULT_ADDR");
        address settlerAddr  = vm.envOr("SETTLER_ADDR", address(0));

        address vrfCoordinator = vm.envAddress("VRF_COORDINATOR");
        bytes32 vrfKeyHash     = vm.envBytes32("VRF_KEY_HASH");
        uint256 vrfSubId       = vm.envUint("VRF_SUB_ID");
        bytes memory vrfExtra  = vm.envBytes("VRF_EXTRA_ARGS");
        uint16  vrfConfs       = uint16(vm.envOr("VRF_CONFIRMATIONS", uint256(3)));
        uint32  vrfCbGas       = uint32(vm.envOr("VRF_CALLBACK_GAS", uint256(200_000)));

        vm.startBroadcast(deployerKey);

        // 1. Fresh GameRegistry (repo source — permissionless activateRoundEntries).
        //    timbPrize is set after the prize exists (constructor allows 0 here).
        GameRegistry registry = new GameRegistry(timbsToken, protocolSink, address(0));
        console.log("New GameRegistry:   ", address(registry));

        // 2. Prize VRF entropy (dedicated instance; setBoard is one-time).
        VRFEntropy prizeEntropy = new VRFEntropy(
            vrfCoordinator, vrfKeyHash, vrfSubId, vrfConfs, vrfCbGas, vrfExtra
        );
        console.log("Prize VRFEntropy:   ", address(prizeEntropy));

        // 3. Fresh TimbPrize bound to the NEW registry + reused escrow/router.
        TimbPrize prize = new TimbPrize(escrowAddr, address(registry), routerAddr);
        console.log("New TimbPrize:      ", address(prize));

        // 4. Wire the registry <-> prize and the registry -> vault.
        registry.setTimbPrize(address(prize));
        registry.setYieldVault(vaultAddr);

        // 5. Wire entropy both ways, then the prize's dependencies.
        prizeEntropy.setBoard(address(prize));
        prize.setEntropy(address(prizeEntropy));
        prize.setEligibleRegistry(eligibleAddr);
        prize.setYieldVault(vaultAddr);
        if (settlerAddr != address(0)) prize.setSettler(settlerAddr);

        // 6. Repoint reused infra at the NEW prize (owner-only setters). Escrow
        //    and router have payable receive()s, so cast from a payable address.
        PrizeEscrow(payable(escrowAddr)).setTimbPrize(address(prize));
        TimbSwapRouter(payable(routerAddr)).setTimbPrize(address(prize));
        EligibleTokenRegistry(eligibleAddr).registerConsumer(address(prize));

        // 7. Repoint the reused vault at the NEW registry so register()/remove()
        //    (onlyGameRegistry) accept it. Without this, activation would flip
        //    tickets Active but silently drop their yield weight (the vault call
        //    is try/catch-fenced in the new registry, so it never bricks).
        IYieldVaultAdmin(vaultAddr).setGameRegistry(address(registry));

        vm.stopBroadcast();

        console.log("\n========== GEN-3 MIGRATION COMPLETE ==========");
        console.log("New GameRegistry:   ", address(registry));
        console.log("New TimbPrize:      ", address(prize));
        console.log("Prize VRFEntropy:   ", address(prizeEntropy));
        console.log("=============================================");
        console.log("");
        console.log("NEXT (runbook, dev-docs/GEN3_MIGRATION.md):");
        console.log("1. Add the Prize VRFEntropy as a consumer on VRF sub", vrfSubId);
        console.log("2. Fund the subscription (LINK or native)");
        console.log("3. Update config.js: GameRegistry + TimbPrize + PrizeVRFEntropy -> new");
        console.log("4. Call new TimbPrize.startGame()  (fresh epoch, opens round 1)");
        console.log("5. Confirm settler activates round 2+ (activateRoundEntries no longer reverts)");
        console.log("6. Tell holders to reclaim principal from the OLD registry (user-reclaim only)");
    }
}
