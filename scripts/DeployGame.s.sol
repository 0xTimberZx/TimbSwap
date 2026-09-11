// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";

// Named imports (contract types only) — several deployed sources declare their
// own file-level `interface IWETH` / `interface ITimbSwapPair`, so a wildcard
// import would collide. See Deploy.s.sol for the same rationale.
import {TIMBSToken} from "../contracts/TIMBSToken.sol";
import {PrizeEscrow} from "../contracts/PrizeEscrow.sol";
import {TimbSwapFactory} from "../contracts/TimbSwapFactory.sol";
import {TimbSwapRouter} from "../contracts/TimbSwapRouter.sol";
import {EligibleTokenRegistry} from "../contracts/EligibleTokenRegistry.sol";
import {GameRegistry} from "../contracts/GameRegistry.sol";
import {TimbPrize} from "../contracts/TimbPrize.sol";
import {VRFEntropy} from "../contracts/VRFEntropy.sol";
import {TimbYieldVault} from "../contracts/TimbYieldVault.sol";
import {TimbStaking} from "../contracts/TimbStaking.sol";
import {TimbFarm} from "../contracts/TimbFarm.sol";
import {TimbLockVault} from "../contracts/TimbLockVault.sol";
import {TimbTreasury} from "../contracts/TimbTreasury.sol";
import {TimbGovernance} from "../contracts/TimbGovernance.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title DeployGame
 * @notice Phase 2 — TIMBS + the prize game + the incentive layer, attached to
 *         the LIVE DEX that DeployCore.s.sol (phase 1) already deployed.
 *
 * Phase 1 (DeployCore) deployed and wired the standalone exchange primitive:
 * TimbSwapFactory + TimbSwapRouter (factory.setRouter; WETH is an immutable
 * router constructor arg), with the router's game hooks no-op
 * (eligibleRegistry / timbPrize == address(0),
 * guarded in _maybeNudge). This script deploys everything else and switches the
 * game hooks on, so the exact same factory/router now also drive the prize game.
 *
 * It reads FACTORY_ADDRESS / ROUTER_ADDRESS from the environment — paste them
 * from DeployCore's output — and MUST run under the SAME DEPLOYER_PRIVATE_KEY
 * that ran phase 1, because it calls owner-only setters on that factory/router
 * (setTimbsToken, setEmissionsWhitelist, setEligibleRegistry, setTimbPrize).
 *
 * What this deploys that the old monolith did NOT: the TimbYieldVault, and its
 * full two-way wiring. On testnet the vault was a separate deploy whose
 * timbPrize pointer was never repointed after a prize migration, so harvest()
 * (onlyTimbPrize) reverted silently and yield never reached the pot. Here the
 * vault<->prize and vault<->registry links are all wired at deploy, in one
 * place, so that gap cannot recur.
 *
 * Env (.env — never commit):
 *   DEPLOYER_PRIVATE_KEY   deployer wallet key (SAME as phase 1)
 *   FACTORY_ADDRESS        TimbSwapFactory from DeployCore output
 *   ROUTER_ADDRESS         TimbSwapRouter  from DeployCore output
 *   TREASURY_ADDRESS       treasury / team wallet
 *   PROTOCOL_SINK_ADDRESS  receives additional-round TIMBS + lapsed escrow
 *   WETH_ADDRESS           canonical WETH on the target chain
 *   DAPP_TOKEN_ADDRESS     existing DAPP token (eligible registry + lock vault)
 *   LINK_TOKEN_ADDRESS     LINK token (lock vault whitelist)
 *   VRF_COORDINATOR        Chainlink VRF v2.5 coordinator (prize entropy, H1)
 *   VRF_KEY_HASH           the gas lane
 *   VRF_SUB_ID             subscription this entropy is a consumer of
 *   VRF_EXTRA_ARGS         v2.5 extraArgs blob, hex (LINK vs native payment)
 *   VRF_CONFIRMATIONS      optional, default 3
 *   VRF_CALLBACK_GAS       optional, default 200000
 *   GOV_MULTISIG           Safe/multisig that proposes+executes timelock actions
 *   TIMELOCK_MIN_DELAY     optional, seconds; default 172800 (48h)
 *   ENTRY_COST_TIMBS       TIMBSToken constructor param (18 dec)
 *   INITIAL_SUPPLY         TIMBS initial mint (18 dec)
 *   REWARD_RATE_PER_SEC    TIMBS staking reward rate (wei/sec)
 *   FARM_REWARD_RATE       TIMBS farm reward rate (wei/sec)
 *   PROPOSAL_THRESHOLD     min TIMBS to submit a governance proposal
 *   QUORUM_BPS             governance quorum in basis points
 *   VOTING_PERIOD          governance voting period (seconds)
 *   VOTING_DELAY           governance voting delay (seconds)
 *   VAULT_RATE_PER_SEC1E18 optional, yield-vault rate (1e18-scaled); default 0
 *                          (0 = accrual paused until the owner sets it + funds
 *                          the reserve — a post-deploy step)
 *
 * Usage:
 *   forge script scripts/DeployGame.s.sol \
 *     --rpc-url $ARB_RPC --broadcast --verify --verifier sourcify -vvvv
 */
contract DeployGame is Script {

    // ─── Deployed (phase 2) ────────────────────────────────────────────────────
    TIMBSToken            public timbs;
    PrizeEscrow           public prizeEscrow;
    EligibleTokenRegistry public eligibleRegistry;
    GameRegistry          public gameRegistry;
    TimbPrize             public timbPrize;
    VRFEntropy            public prizeEntropy;
    TimbYieldVault        public yieldVault;
    TimbStaking           public staking;
    TimbFarm              public farm;
    TimbLockVault         public lockVault;
    TimbTreasury          public treasury;
    TimbGovernance        public governance;
    TimelockController    public timelock;

    // ─── From phase 1 (env) ────────────────────────────────────────────────────
    TimbSwapFactory public factory;
    TimbSwapRouter  public router;

    address public timbsEthPair;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        // Phase-1 primitives — the live DEX this game attaches to.
        factory = TimbSwapFactory(vm.envAddress("FACTORY_ADDRESS"));
        router  = TimbSwapRouter(payable(vm.envAddress("ROUTER_ADDRESS")));

        address treasuryWallet = vm.envAddress("TREASURY_ADDRESS");
        address protocolSink   = vm.envAddress("PROTOCOL_SINK_ADDRESS");
        address weth           = vm.envAddress("WETH_ADDRESS");
        address dapp           = vm.envAddress("DAPP_TOKEN_ADDRESS");
        address link           = vm.envAddress("LINK_TOKEN_ADDRESS");

        address vrfCoordinator = vm.envAddress("VRF_COORDINATOR");
        bytes32 vrfKeyHash     = vm.envBytes32("VRF_KEY_HASH");
        uint256 vrfSubId       = vm.envUint("VRF_SUB_ID");
        bytes memory vrfExtra  = vm.envBytes("VRF_EXTRA_ARGS");
        uint16  vrfConfs       = uint16(vm.envOr("VRF_CONFIRMATIONS", uint256(3)));
        uint32  vrfCbGas       = uint32(vm.envOr("VRF_CALLBACK_GAS", uint256(200_000)));

        address govMultisig    = vm.envAddress("GOV_MULTISIG");
        uint256 timelockDelay  = vm.envOr("TIMELOCK_MIN_DELAY", uint256(48 hours));

        uint256 entryCostTIMBS = vm.envUint("ENTRY_COST_TIMBS");
        uint256 initialSupply  = vm.envUint("INITIAL_SUPPLY");
        uint256 rewardRateSec  = vm.envUint("REWARD_RATE_PER_SEC");
        uint256 farmRateSec    = vm.envUint("FARM_REWARD_RATE");
        uint256 propThreshold  = vm.envUint("PROPOSAL_THRESHOLD");
        uint256 quorumBps      = vm.envUint("QUORUM_BPS");
        uint256 votingPeriod   = vm.envUint("VOTING_PERIOD");
        uint256 votingDelay    = vm.envUint("VOTING_DELAY");
        uint256 vaultRate      = vm.envOr("VAULT_RATE_PER_SEC1E18", uint256(0));

        require(address(factory) != address(0), "FACTORY_ADDRESS unset");
        require(address(router)  != address(0), "ROUTER_ADDRESS unset");

        console.log("Deploying TimbSwap game layer (phase 2) onto the live DEX...");
        console.log("Deployer:", deployer);
        console.log("Factory: ", address(factory));
        console.log("Router:  ", address(router));

        vm.startBroadcast(deployerKey);

        // ── Deploys ──────────────────────────────────────────────────────────
        timbs = new TIMBSToken(treasuryWallet, initialSupply, entryCostTIMBS);
        console.log("TIMBSToken:         ", address(timbs));

        prizeEscrow = new PrizeEscrow();
        console.log("PrizeEscrow:        ", address(prizeEscrow));

        address[] memory initialTokens = new address[](3);
        initialTokens[0] = address(timbs);
        initialTokens[1] = weth;
        initialTokens[2] = dapp;
        eligibleRegistry = new EligibleTokenRegistry(initialTokens);
        console.log("EligibleRegistry:   ", address(eligibleRegistry));

        gameRegistry = new GameRegistry(address(timbs), protocolSink, address(0));
        console.log("GameRegistry:       ", address(gameRegistry));

        timbPrize = new TimbPrize(
            address(prizeEscrow),
            address(gameRegistry),
            address(router)
        );
        console.log("TimbPrize:          ", address(timbPrize));

        prizeEntropy = new VRFEntropy(
            vrfCoordinator, vrfKeyHash, vrfSubId, vrfConfs, vrfCbGas, vrfExtra
        );
        prizeEntropy.setBoard(address(timbPrize));
        console.log("Prize VRFEntropy:   ", address(prizeEntropy));

        // The yield vault the monolith never deployed. Constructor takes no args;
        // gameRegistry + timbPrize are wired below (both directions).
        yieldVault = new TimbYieldVault();
        console.log("TimbYieldVault:     ", address(yieldVault));

        staking = new TimbStaking(address(timbs), rewardRateSec);
        console.log("TimbStaking:        ", address(staking));

        farm = new TimbFarm(address(timbs), farmRateSec);
        console.log("TimbFarm:           ", address(farm));

        lockVault = new TimbLockVault(address(timbs));
        console.log("TimbLockVault:      ", address(lockVault));

        treasury = new TimbTreasury(
            address(timbs),
            address(staking),
            address(prizeEscrow),
            address(0), // pair — set after creation
            weth
        );
        console.log("TimbTreasury:       ", address(treasury));

        governance = new TimbGovernance(
            address(timbs), propThreshold, quorumBps, votingPeriod, votingDelay
        );
        console.log("TimbGovernance:     ", address(governance));

        {
            address[] memory proposers = new address[](1);
            address[] memory executors = new address[](1);
            proposers[0] = govMultisig;
            executors[0] = govMultisig;
            // Self-administered timelock (admin = address(0)); ownership handoff
            // of the privileged contracts is a post-deploy runbook step.
            timelock = new TimelockController(timelockDelay, proposers, executors, address(0));
        }
        console.log("TimelockController:  ", address(timelock));

        // ── Wiring ────────────────────────────────────────────────────────────
        console.log("\nWiring contracts...");

        // Factory (phase-1 contract, owned by the deployer). setRouter + WETH
        // were done in phase 1; here we attach TIMBS and create the pair.
        factory.setTimbsToken(address(timbs));
        timbsEthPair = factory.getPairAddress(address(timbs), weth);
        if (timbsEthPair == address(0)) {
            factory.createPair(address(timbs), weth);
            timbsEthPair = factory.getPairAddress(address(timbs), weth);
        }
        factory.setEmissionsWhitelist(timbsEthPair, true);
        console.log("Factory: timbsToken + TIMBS/WETH pair:", timbsEthPair);

        // Router (phase-1 contract) — switch the game hooks on.
        router.setEligibleRegistry(address(eligibleRegistry));
        router.setTimbPrize(address(timbPrize));
        console.log("Router: eligibleRegistry + timbPrize set (game hooks live)");

        // GameRegistry — prize lifecycle driver + yield-weight sink.
        gameRegistry.setTimbPrize(address(timbPrize));
        gameRegistry.setYieldVault(address(yieldVault));
        console.log("GameRegistry: timbPrize + yieldVault set");

        // PrizeEscrow — only TimbPrize may pay.
        prizeEscrow.setTimbPrize(address(timbPrize));
        console.log("PrizeEscrow: timbPrize set");

        // TimbPrize — all dependencies, including the yield vault.
        timbPrize.setEligibleRegistry(address(eligibleRegistry));
        timbPrize.setGameRegistry(address(gameRegistry));
        timbPrize.setPrizeEscrow(address(prizeEscrow));
        timbPrize.setEntropy(address(prizeEntropy)); // H1 — required before startGame
        timbPrize.setYieldVault(address(yieldVault));
        console.log("TimbPrize: escrow + registry + entropy + yieldVault set");

        // TimbYieldVault — BOTH directions. This is the wiring whose omission
        // silently starved the pot on testnet: register()/remove() are
        // onlyGameRegistry and harvest() is onlyTimbPrize, so BOTH must point
        // back here for weight to register and yield to sweep.
        yieldVault.setGameRegistry(address(gameRegistry));
        yieldVault.setTimbPrize(address(timbPrize));
        if (vaultRate > 0) yieldVault.setRatePerSecond(vaultRate);
        console.log("TimbYieldVault: gameRegistry + timbPrize set (harvest wired)");

        // TIMBSToken.
        timbs.setStakingPool(address(staking));
        timbs.setFarmPool(address(farm));
        timbs.setTransferWhitelist(address(router), true);
        timbs.setTransferWhitelist(address(treasury), true);
        console.log("TIMBSToken: stakingPool + farmPool + whitelist set");

        // TimbFarm.
        farm.setLpToken(timbsEthPair);
        farm.setTreasury(address(treasury));
        console.log("TimbFarm: lpToken + treasury set");

        // TimbStaking.
        staking.setTreasury(address(treasury));
        console.log("TimbStaking: treasury set");

        // TimbTreasury.
        treasury.setTimbsEthPair(timbsEthPair);
        treasury.setTimbStaking(address(staking));
        treasury.setRouter(address(router)); // protocol-owned liquidity
        console.log("TimbTreasury: pair + staking + router set");

        // EligibleRegistry consumers.
        eligibleRegistry.registerConsumer(address(router));
        eligibleRegistry.registerConsumer(address(timbPrize));
        console.log("EligibleRegistry: consumers registered");

        // LockVault whitelist.
        address[] memory lockTokens = new address[](3);
        lockTokens[0] = weth;
        lockTokens[1] = dapp;
        lockTokens[2] = link;
        lockVault.addManyToWhitelist(lockTokens);
        console.log("LockVault: WETH + DAPP + LINK whitelisted");

        vm.stopBroadcast();

        // ── Summary ────────────────────────────────────────────────────────────
        console.log("\n========== PHASE 2 COMPLETE ==========");
        console.log("TIMBSToken:         ", address(timbs));
        console.log("PrizeEscrow:        ", address(prizeEscrow));
        console.log("EligibleRegistry:   ", address(eligibleRegistry));
        console.log("GameRegistry:       ", address(gameRegistry));
        console.log("TimbPrize:          ", address(timbPrize));
        console.log("Prize VRFEntropy:   ", address(prizeEntropy));
        console.log("TimbYieldVault:     ", address(yieldVault));
        console.log("TimbStaking:        ", address(staking));
        console.log("TimbFarm:           ", address(farm));
        console.log("TimbLockVault:      ", address(lockVault));
        console.log("TimbTreasury:       ", address(treasury));
        console.log("TimbGovernance:     ", address(governance));
        console.log("TimelockController:  ", address(timelock));
        console.log("TIMBS/WETH Pair:    ", timbsEthPair);
        console.log("Factory (phase 1):  ", address(factory));
        console.log("Router  (phase 1):  ", address(router));
        console.log("======================================");
        console.log("");
        console.log("NEXT STEPS:");
        console.log("1. Verify all phase-2 contracts on Sourcify.");
        console.log("2. Transfer initial TIMBS allocations from the treasury wallet.");
        console.log("3. Add liquidity to the TIMBS/WETH pair.");
        console.log("4. notifyRewardAmount() on TimbStaking + TimbFarm.");
        console.log("5. Fund PrizeEscrow with the initial ETH seed.");
        console.log("6. Fund the yield vault: yieldVault.fund{value:}() and, if not");
        console.log("   set via VAULT_RATE_PER_SEC1E18, setRatePerSecond / setYieldAPRBps.");
        console.log("7. Add Prize VRFEntropy as a consumer on the VRF subscription");
        console.log("   and fund the subscription (LINK/native) BEFORE startGame.");
        console.log("8. VERIFY the wiring matrix on-chain before startGame:");
        console.log("   GameRegistry.timbPrize/yieldVault, TimbPrize.gameRegistry/");
        console.log("   yieldVault/entropy, TimbYieldVault.gameRegistry/timbPrize,");
        console.log("   PrizeEscrow.timbPrize, VRFEntropy.board, Router.timbPrize.");
        console.log("9. timbPrize.startGame() after the frontend is tested.");
        console.log("10. GOVERNANCE HANDOFF (after full verification) - for each of");
        console.log("    the Ownable2Step contracts: owner.transferOwnership(timelock),");
        console.log("    then acceptOwnership() via a timelock proposal from the");
        console.log("    multisig. See dev-docs/GOVERNANCE_HARDENING.md.");
    }
}
