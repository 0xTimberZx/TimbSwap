// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";

// Selective imports (contract types only). Several of these files declare their
// own file-level `interface IWETH` / `interface ITimbSwapPair` (Router, Factory
// and Treasury each carry a private copy); wildcard-importing all of them into
// one script collides on those identifiers. Named imports pull just the contract
// (and its nested types), never the ambient interfaces — and touch no deployed
// contract source.
import {TIMBSToken} from "../contracts/TIMBSToken.sol";
import {PrizeEscrow} from "../contracts/PrizeEscrow.sol";
import {TimbSwapFactory} from "../contracts/TimbSwapFactory.sol";
import {TimbSwapRouter} from "../contracts/TimbSwapRouter.sol";
import {EligibleTokenRegistry} from "../contracts/EligibleTokenRegistry.sol";
import {GameRegistry} from "../contracts/GameRegistry.sol";
import {TimbPrize} from "../contracts/TimbPrize.sol";
import {VRFEntropy} from "../contracts/VRFEntropy.sol";
import {TimbStaking} from "../contracts/TimbStaking.sol";
import {TimbFarm} from "../contracts/TimbFarm.sol";
import {TimbLockVault} from "../contracts/TimbLockVault.sol";
import {TimbTreasury} from "../contracts/TimbTreasury.sol";
import {TimbGovernance} from "../contracts/TimbGovernance.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title Deploy
 * @notice Full TimbSwap deployment script for Arbitrum Sepolia.
 *
 * Usage:
 *   forge script script/Deploy.s.sol \
 *     --rpc-url $ARB_SEPOLIA_RPC \
 *     --broadcast \
 *     --verify \
 *     --verifier sourcify \
 *     -vvvv
 *
 * Environment variables required (.env — never commit):
 *   DEPLOYER_PRIVATE_KEY   — deployer wallet private key
 *   TREASURY_ADDRESS       — treasury / team wallet address
 *   PROTOCOL_SINK_ADDRESS  — address that receives additional-round TIMBS sinks
 *   WETH_ADDRESS           — WETH address on Arbitrum Sepolia
 *   DAPP_TOKEN_ADDRESS     — existing DAPP token address (for eligible registry)
 *   LINK_TOKEN_ADDRESS     — LINK token address (for lock vault whitelist)
 *   VRF_COORDINATOR        — Chainlink VRF v2.5 coordinator (prize-game entropy, H1)
 *   VRF_KEY_HASH           — the gas lane
 *   VRF_SUB_ID             — subscription this prize entropy is a consumer of
 *   VRF_EXTRA_ARGS         — v2.5 extraArgs blob, hex (LINK vs native payment)
 *   VRF_CONFIRMATIONS      — optional, default 3
 *   VRF_CALLBACK_GAS       — optional, default 200000
 *   GOV_MULTISIG           — Gnosis Safe (or multisig) that proposes/executes
 *                            timelocked owner actions (M1/M3/M6 hardening)
 *   TIMELOCK_MIN_DELAY     — optional, seconds; default 172800 (48h)
 *   ENTRY_COST_TIMBS       — TIMBSToken constructor param (18 dec); prize entry
 *                            costs themselves are dynamic on-chain (no config)
 *   INITIAL_SUPPLY         — TIMBS initial mint amount (18 dec)
 *   REWARD_RATE_PER_SEC    — TIMBS staking reward rate (wei/sec)
 *   FARM_REWARD_RATE       — TIMBS farm reward rate (wei/sec)
 *   PROPOSAL_THRESHOLD     — min TIMBS to submit governance proposal
 *   QUORUM_BPS             — governance quorum in basis points
 *   VOTING_PERIOD          — governance voting period in seconds
 *   VOTING_DELAY           — governance voting delay in seconds
 */
contract Deploy is Script {

    // ─── Deployed Addresses ───────────────────────────────────────────────────
    // Populated during run(), logged at end.

    TIMBSToken          public timbs;
    PrizeEscrow         public prizeEscrow;
    TimbSwapFactory     public factory;
    TimbSwapRouter      public router;
    EligibleTokenRegistry public eligibleRegistry;
    GameRegistry        public gameRegistry;
    TimbPrize           public timbPrize;
    VRFEntropy          public prizeEntropy;
    TimbStaking         public staking;
    TimbFarm            public farm;
    TimbLockVault       public lockVault;
    TimbTreasury        public treasury;
    TimbGovernance      public governance;
    TimelockController  public timelock;

    address public timbsEthPair;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        address treasuryWallet  = vm.envAddress("TREASURY_ADDRESS");
        address protocolSink    = vm.envAddress("PROTOCOL_SINK_ADDRESS");
        address weth            = vm.envAddress("WETH_ADDRESS");
        address dapp            = vm.envAddress("DAPP_TOKEN_ADDRESS");
        address link            = vm.envAddress("LINK_TOKEN_ADDRESS");

        // H1: prize-game VRF entropy wiring (same subscription may list the board
        // and this as consumers). Read off Chainlink's published tables at deploy.
        address vrfCoordinator  = vm.envAddress("VRF_COORDINATOR");
        bytes32 vrfKeyHash      = vm.envBytes32("VRF_KEY_HASH");
        uint256 vrfSubId        = vm.envUint("VRF_SUB_ID");
        bytes memory vrfExtra   = vm.envBytes("VRF_EXTRA_ARGS");
        uint16  vrfConfs        = uint16(vm.envOr("VRF_CONFIRMATIONS", uint256(3)));
        uint32  vrfCbGas        = uint32(vm.envOr("VRF_CALLBACK_GAS", uint256(200_000)));

        // Governance hardening (M1/M3/M6): the multisig proposes/executes owner
        // actions through a timelock. Ownership handoff itself is a post-deploy
        // runbook step (see below) so setup stays under the deployer key.
        address govMultisig     = vm.envAddress("GOV_MULTISIG");
        uint256 timelockDelay   = vm.envOr("TIMELOCK_MIN_DELAY", uint256(48 hours));

        uint256 entryCostTIMBS  = vm.envUint("ENTRY_COST_TIMBS"); // TIMBSToken faucet/mint param
        uint256 initialSupply   = vm.envUint("INITIAL_SUPPLY");
        uint256 rewardRateSec   = vm.envUint("REWARD_RATE_PER_SEC");
        uint256 farmRateSec     = vm.envUint("FARM_REWARD_RATE");
        uint256 propThreshold   = vm.envUint("PROPOSAL_THRESHOLD");
        uint256 quorumBps       = vm.envUint("QUORUM_BPS");
        uint256 votingPeriodSec = vm.envUint("VOTING_PERIOD");
        uint256 votingDelaySec  = vm.envUint("VOTING_DELAY");

        console.log("Deploying TimbSwap to Arbitrum Sepolia...");
        console.log("Deployer:", deployer);
        console.log("Treasury:", treasuryWallet);

        vm.startBroadcast(deployerKey);

        // ── 1. TIMBSToken ────────────────────────────────────────────────────
        timbs = new TIMBSToken(
            treasuryWallet,
            initialSupply,
            entryCostTIMBS
        );
        console.log("TIMBSToken:         ", address(timbs));

        // ── 2. PrizeEscrow ───────────────────────────────────────────────────
        prizeEscrow = new PrizeEscrow();
        console.log("PrizeEscrow:        ", address(prizeEscrow));

        // ── 3. TimbSwapFactory ───────────────────────────────────────────────
        factory = new TimbSwapFactory(treasuryWallet);
        console.log("TimbSwapFactory:    ", address(factory));

        // ── 4. TimbSwapRouter ────────────────────────────────────────────────
        // Treasury, eligibleRegistry, timbPrize set post-deploy
        router = new TimbSwapRouter(
            address(factory),
            treasuryWallet,
            address(0), // eligibleRegistry — set after
            address(0)  // timbPrize — set after
        );
        console.log("TimbSwapRouter:     ", address(router));

        // ── 5. EligibleTokenRegistry ─────────────────────────────────────────
        address[] memory initialTokens = new address[](3);
        initialTokens[0] = address(timbs);
        initialTokens[1] = weth;
        initialTokens[2] = dapp;
        eligibleRegistry = new EligibleTokenRegistry(initialTokens);
        console.log("EligibleRegistry:   ", address(eligibleRegistry));

        // ── 6. GameRegistry ──────────────────────────────────────────────────
        gameRegistry = new GameRegistry(
            address(timbs),
            protocolSink,
            address(0) // timbPrize — set after
        );
        console.log("GameRegistry:       ", address(gameRegistry));

        // ── 7. TimbPrize ─────────────────────────────────────────────────────
        timbPrize = new TimbPrize(
            address(prizeEscrow),
            address(gameRegistry),
            address(router)
        );
        console.log("TimbPrize:          ", address(timbPrize));

        // ── 7b. Prize VRF entropy (H1) ───────────────────────────────────────
        // Dedicated VRFEntropy for the prize game, mirroring the board's path.
        // setBoard(timbPrize) locks it to the one consumer; setEntropy wires the
        // reverse edge in the dependency section below.
        prizeEntropy = new VRFEntropy(
            vrfCoordinator, vrfKeyHash, vrfSubId, vrfConfs, vrfCbGas, vrfExtra
        );
        prizeEntropy.setBoard(address(timbPrize));
        console.log("Prize VRFEntropy:   ", address(prizeEntropy));

        // ── 8. TimbStaking ───────────────────────────────────────────────────
        staking = new TimbStaking(address(timbs), rewardRateSec);
        console.log("TimbStaking:        ", address(staking));

        // ── 9. TimbFarm ──────────────────────────────────────────────────────
        farm = new TimbFarm(address(timbs), farmRateSec);
        console.log("TimbFarm:           ", address(farm));

        // ── 10. TimbLockVault ────────────────────────────────────────────────
        lockVault = new TimbLockVault(address(timbs));
        console.log("TimbLockVault:      ", address(lockVault));

        // ── 11. TimbTreasury ─────────────────────────────────────────────────
        // timbsEthPair — set after pair creation
        treasury = new TimbTreasury(
            address(timbs),
            address(staking),
            address(prizeEscrow),
            address(0), // pair — set after
            weth
        );
        console.log("TimbTreasury:       ", address(treasury));

        // ── 12. TimbGovernance ───────────────────────────────────────────────
        governance = new TimbGovernance(
            address(timbs),
            propThreshold,
            quorumBps,
            votingPeriodSec,
            votingDelaySec
        );
        console.log("TimbGovernance:     ", address(governance));

        // ── 13. TimelockController (governance hardening M1/M3/M6) ────────────
        // The multisig is the sole proposer and executor; the timelock self-
        // administers (admin = address(0)) so no one can bypass the delay by
        // re-granting roles. Privileged owners (Treasury, GameRegistry,
        // UnderwriteReserve, …) are transferred to this timelock AFTER the
        // system is verified — a post-deploy runbook step, not done here, so a
        // wiring mistake can't strand setup behind a 48h delay.
        {
            address[] memory proposers = new address[](1);
            address[] memory executors = new address[](1);
            proposers[0] = govMultisig;
            executors[0] = govMultisig;
            timelock = new TimelockController(timelockDelay, proposers, executors, address(0));
        }
        console.log("TimelockController:  ", address(timelock));

        // ─────────────────────────────────────────────────────────────────────
        // WIRING — post-deploy configuration
        // ─────────────────────────────────────────────────────────────────────

        console.log("\nWiring contracts...");

        // Factory
        factory.setRouter(address(router));
        factory.setTimbsToken(address(timbs));
        console.log("Factory: router + timbsToken set");

        // Create TIMBS/WETH pair
        timbsEthPair = factory.getPairAddress(address(timbs), weth);
        if (timbsEthPair == address(0)) {
            factory.createPair(address(timbs), weth);
            timbsEthPair = factory.getPairAddress(address(timbs), weth);
        }
        factory.setEmissionsWhitelist(timbsEthPair, true);
        console.log("Factory: TIMBS/WETH pair created + whitelisted:", timbsEthPair);

        // Router
        router.setEligibleRegistry(address(eligibleRegistry));
        router.setTimbPrize(address(timbPrize));
        console.log("Router: eligibleRegistry + timbPrize set");

        // GameRegistry — entry costs are dynamic in v5 (no setter).
        gameRegistry.setTimbPrize(address(timbPrize));
        console.log("GameRegistry: timbPrize set");

        // PrizeEscrow
        prizeEscrow.setTimbPrize(address(timbPrize));
        console.log("PrizeEscrow: timbPrize set");

        // TimbPrize
        timbPrize.setEligibleRegistry(address(eligibleRegistry));
        timbPrize.setGameRegistry(address(gameRegistry));
        timbPrize.setPrizeEscrow(address(prizeEscrow));
        timbPrize.setEntropy(address(prizeEntropy)); // H1: required before startGame
        console.log("TimbPrize: all dependencies set");

        // TIMBSToken
        timbs.setStakingPool(address(staking));
        timbs.setFarmPool(address(farm));
        timbs.setTransferWhitelist(address(router), true);
        timbs.setTransferWhitelist(address(treasury), true);
        console.log("TIMBSToken: stakingPool + farmPool + whitelist set");

        // TimbFarm
        farm.setLpToken(timbsEthPair);
        farm.setTreasury(address(treasury));
        console.log("TimbFarm: lpToken + treasury set");

        // TimbStaking
        staking.setTreasury(address(treasury));
        console.log("TimbStaking: treasury set");

        // TimbTreasury
        treasury.setTimbsEthPair(timbsEthPair);
        treasury.setTimbStaking(address(staking));
        treasury.setRouter(address(router)); // enables protocol-owned liquidity
        console.log("TimbTreasury: pair + staking + router set");

        // EligibleRegistry
        eligibleRegistry.registerConsumer(address(router));
        eligibleRegistry.registerConsumer(address(timbPrize));
        console.log("EligibleRegistry: consumers registered");

        // LockVault whitelist
        address[] memory lockTokens = new address[](3);
        lockTokens[0] = weth;
        lockTokens[1] = dapp;
        lockTokens[2] = link;
        lockVault.addManyToWhitelist(lockTokens);
        console.log("LockVault: WETH + DAPP + LINK whitelisted");

        vm.stopBroadcast();

        // ─────────────────────────────────────────────────────────────────────
        // DEPLOYMENT SUMMARY
        // ─────────────────────────────────────────────────────────────────────

        console.log("\n========== DEPLOYMENT COMPLETE ==========");
        console.log("Network:             Arbitrum Sepolia (42161)");
        console.log("");
        console.log("TIMBSToken:         ", address(timbs));
        console.log("PrizeEscrow:        ", address(prizeEscrow));
        console.log("TimbSwapFactory:    ", address(factory));
        console.log("TimbSwapRouter:     ", address(router));
        console.log("EligibleRegistry:   ", address(eligibleRegistry));
        console.log("GameRegistry:       ", address(gameRegistry));
        console.log("TimbPrize:          ", address(timbPrize));
        console.log("Prize VRFEntropy:   ", address(prizeEntropy));
        console.log("TimbStaking:        ", address(staking));
        console.log("TimbFarm:           ", address(farm));
        console.log("TimbLockVault:      ", address(lockVault));
        console.log("TimbTreasury:       ", address(treasury));
        console.log("TimbGovernance:     ", address(governance));
        console.log("TimelockController:  ", address(timelock));
        console.log("TIMBS/WETH Pair:    ", timbsEthPair);
        console.log("=========================================");
        console.log("");
        console.log("NEXT STEPS:");
        console.log("1. Verify all contracts on Sourcify");
        console.log("2. Transfer initial TIMBS allocations from treasury wallet");
        console.log("3. Add liquidity to TIMBS/WETH pair");
        console.log("4. notifyRewardAmount() on TimbStaking + TimbFarm");
        console.log("5. Fund PrizeEscrow with initial ETH seed");
        console.log("6. Add Prize VRFEntropy as a consumer on the VRF subscription");
        console.log("   and fund the subscription (LINK/native) before startGame");
        console.log("7. Call timbPrize.startGame() after frontend tested");
        console.log("8. Add TimbSwap tab to DebugHub dashboard");
        console.log("9. GOVERNANCE HANDOFF (after full verification) - for each of");
        console.log("   TimbTreasury / GameRegistry / UnderwriteReserve:");
        console.log("     owner: transferOwnership(timelock)  [Ownable2Step]");
        console.log("     then via a timelock proposal from the multisig:");
        console.log("       acceptOwnership()");
        console.log("   Set TimbTreasury operator + operator ETH cap for routine ops.");
        console.log("   See dev-docs/GOVERNANCE_HARDENING.md for the full runbook.");
    }
}
