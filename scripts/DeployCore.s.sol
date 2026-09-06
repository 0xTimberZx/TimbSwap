// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import {TimbSwapFactory} from "../contracts/TimbSwapFactory.sol";
import {TimbSwapRouter} from "../contracts/TimbSwapRouter.sol";

/**
 * @title DeployCore
 * @notice Phase 1 — the standalone TimbSwap DEX.
 *
 * Deploys and wires ONLY the exchange primitive: TimbSwapFactory + TimbSwapRouter
 * + WETH. It has NO dependency on TIMBS, DAPP, the prize game, or Chainlink VRF.
 * The router's game hooks no-op while `timbPrize` / `eligibleRegistry` are unset
 * (both address(0) here, guarded in _maybeNudge), so swaps and liquidity work
 * immediately. TIMBS and the incentive layer (game, staking, farm, treasury,
 * governance) arrive LATER as a second deployment — DeployGame.s.sol — which
 * attaches to the FACTORY/ROUTER addresses this script prints.
 *
 * The DEX is the native primitive; non-native tokens (TIMBS, DAPP, …) trade on
 * it but never gate its deployment or operation.
 *
 * Env (.env — never commit):
 *   DEPLOYER_PRIVATE_KEY   deployer wallet key
 *   TREASURY_ADDRESS       protocol-fee recipient (factory feeTo + router treasury)
 *   WETH_ADDRESS           canonical WETH on the target chain
 *
 * Usage:
 *   forge script scripts/DeployCore.s.sol \
 *     --rpc-url $RPC --broadcast --verify --verifier sourcify -vvvv
 *
 * Then set FACTORY_ADDRESS + ROUTER_ADDRESS in .env from the output and run
 * DeployGame.s.sol when TIMBS + the incentive layer are ready.
 */
contract DeployCore is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address treasury    = vm.envAddress("TREASURY_ADDRESS");
        address weth        = vm.envAddress("WETH_ADDRESS");

        console.log("Deploying TimbSwap DEX core (phase 1)...");
        console.log("Deployer:", vm.addr(deployerKey));
        console.log("Treasury:", treasury);
        console.log("WETH:    ", weth);

        vm.startBroadcast(deployerKey);

        // Factory — fee recipient only. TIMBS is attached in phase 2
        // (factory.setTimbsToken); pairs are created on demand by LPs.
        TimbSwapFactory factory = new TimbSwapFactory(treasury);
        console.log("TimbSwapFactory:", address(factory));

        // Router — eligibleRegistry + timbPrize deliberately address(0). The swap
        // path guards on both (see _maybeNudge), so the DEX is fully functional
        // with no game wired; phase 2 sets them.
        TimbSwapRouter router = new TimbSwapRouter(
            address(factory),
            treasury,
            address(0), // eligibleRegistry — set in phase 2
            address(0)  // timbPrize       — set in phase 2
        );
        console.log("TimbSwapRouter: ", address(router));

        // Wire the pair. setWeth is required for ETH swaps — the monolithic
        // Deploy.s.sol never called it, so set it explicitly here.
        factory.setRouter(address(router));
        router.setWeth(weth);

        vm.stopBroadcast();

        console.log("\nDEX core is live: create pairs, add liquidity, swap ERC20/ETH.");
        console.log("Record these for phase 2 (.env):");
        console.log("  FACTORY_ADDRESS =", address(factory));
        console.log("  ROUTER_ADDRESS  =", address(router));
    }
}
