// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import "../src/TIMBSToken.sol";
import "../src/PrizeEscrow.sol";
import "../src/TimbSwapFactory.sol";
import "../src/TimbSwapRouter.sol";
import "../src/EligibleTokenRegistry.sol";
import "../src/GameRegistry.sol";
import "../src/TimbPrize.sol";
import "../src/TimbStaking.sol";
import "../src/TimbFarm.sol";
import "../src/TimbLockVault.sol";
import "../src/TimbTreasury.sol";
import "../src/TimbGovernance.sol";

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
 *   ENTRY_COST_TIMBS       — initial prize entry cost in TIMBS (18 dec)
 *   ENTRY_COST_ETH         — initial prize entry cost in ETH wei
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
    TimbStaking         public staking;
    TimbFarm            public farm;
    TimbLockVault       public lockVault;
    TimbTreasury        public treasury;
    TimbGovernance      public governance;

    address public timbsEthPair;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        address treasuryWallet  = vm.envAddress("TREASURY_ADDRESS");
        address protocolSink    = vm.envAddress("PROTOCOL_SINK_ADDRESS");
        address weth            = vm.envAddress("WETH_ADDRESS");
        address dapp            = vm.envAddress("DAPP_TOKEN_ADDRESS");
        address link            = vm.envAddress("LINK_TOKEN_ADDRESS");

        uint256 entryCostTIMBS  = vm.envUint("ENTRY_COST_TIMBS");
        uint256 entryCostETH    = vm.envUint("ENTRY_COST_ETH");
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
            address(0) // pair — set after
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

        // GameRegistry
        gameRegistry.setTimbPrize(address(timbPrize));
        gameRegistry.setEntryCosts(entryCostTIMBS, entryCostETH);
        console.log("GameRegistry: timbPrize + entry costs set");

        // PrizeEscrow
        prizeEscrow.setTimbPrize(address(timbPrize));
        console.log("PrizeEscrow: timbPrize set");

        // TimbPrize
        timbPrize.setEligibleRegistry(address(eligibleRegistry));
        timbPrize.setGameRegistry(address(gameRegistry));
        timbPrize.setPrizeEscrow(address(prizeEscrow));
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
        console.log("TimbTreasury: pair + staking set");

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
        console.log("Network:             Arbitrum Sepolia (421614)");
        console.log("");
        console.log("TIMBSToken:         ", address(timbs));
        console.log("PrizeEscrow:        ", address(prizeEscrow));
        console.log("TimbSwapFactory:    ", address(factory));
        console.log("TimbSwapRouter:     ", address(router));
        console.log("EligibleRegistry:   ", address(eligibleRegistry));
        console.log("GameRegistry:       ", address(gameRegistry));
        console.log("TimbPrize:          ", address(timbPrize));
        console.log("TimbStaking:        ", address(staking));
        console.log("TimbFarm:           ", address(farm));
        console.log("TimbLockVault:      ", address(lockVault));
        console.log("TimbTreasury:       ", address(treasury));
        console.log("TimbGovernance:     ", address(governance));
        console.log("TIMBS/WETH Pair:    ", timbsEthPair);
        console.log("=========================================");
        console.log("");
        console.log("NEXT STEPS:");
        console.log("1. Verify all contracts on Sourcify");
        console.log("2. Transfer initial TIMBS allocations from treasury wallet");
        console.log("3. Add liquidity to TIMBS/WETH pair");
        console.log("4. notifyRewardAmount() on TimbStaking + TimbFarm");
        console.log("5. Fund PrizeEscrow with initial ETH seed");
        console.log("6. Call timbPrize.startGame() after frontend tested");
        console.log("7. Add TimbSwap tab to DebugHub dashboard");
    }
}
