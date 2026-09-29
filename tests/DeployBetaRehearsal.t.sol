// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {DeployGame} from "../scripts/DeployGame.s.sol";
import {DeployBeta} from "../scripts/DeployBeta.s.sol";
import {TimbSwapFactory} from "../contracts/TimbSwapFactory.sol";
import {TimbSwapRouter} from "../contracts/TimbSwapRouter.sol";
import {TimbAirdropDistributor} from "../contracts/TimbAirdropDistributor.sol";
import {TimbPrize} from "../contracts/TimbPrize.sol";
import {GameRegistry} from "../contracts/GameRegistry.sol";
import {GasFaucet} from "../contracts/GasFaucet.sol";
import {TimbTreasury} from "../contracts/TimbTreasury.sol";

contract RehearsalWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 a) external { _burn(msg.sender, a); payable(msg.sender).transfer(a); }
}

contract RehearsalCoordinator {
    uint256 public n;
    struct RandomWordsRequest { bytes32 keyHash; uint256 subId; uint16 c; uint32 g; uint32 w; bytes x; }
    function requestRandomWords(RandomWordsRequest calldata) external returns (uint256) { return ++n; }
}

/**
 * @title DeployBeta rehearsal
 * @notice Rebuilds the current mainnet shape locally — Phase 1 (factory +
 *         router), Phase 2 (DeployGame, never started) and the live airdrop
 *         distributor — then runs DeployBeta on top and checks the result.
 *         Stands in for a fork simulation, which needs an Arbitrum One RPC.
 */
contract DeployBetaRehearsalTest is Test {
    uint256 constant KEY = 0xB0B;
    address deployer;
    address constant SAFE = address(0x5AFE);
    address constant DISPATCHER = address(0xD15);

    DeployGame game;
    TimbSwapRouter router;
    TimbSwapFactory factory;
    TimbAirdropDistributor airdrop;
    RehearsalWETH weth;

    function setUp() public {
        deployer = vm.addr(KEY);
        vm.deal(deployer, 100 ether);
        weth = new RehearsalWETH();
        RehearsalCoordinator coord = new RehearsalCoordinator();

        // Phase 1 — DeployCore equivalent.
        vm.startPrank(deployer);
        factory = new TimbSwapFactory(SAFE);
        router = new TimbSwapRouter(address(factory), SAFE, address(0), address(0), address(weth));
        factory.setRouter(address(router));
        vm.stopPrank();

        // Phase 2 — the real DeployGame script, as run on 2026-09-11.
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(KEY));
        vm.setEnv("FACTORY_ADDRESS", vm.toString(address(factory)));
        vm.setEnv("ROUTER_ADDRESS", vm.toString(address(router)));
        vm.setEnv("TREASURY_ADDRESS", vm.toString(SAFE));
        vm.setEnv("PROTOCOL_SINK_ADDRESS", vm.toString(SAFE));
        vm.setEnv("WETH_ADDRESS", vm.toString(address(weth)));
        vm.setEnv("VRF_COORDINATOR", vm.toString(address(coord)));
        vm.setEnv("VRF_KEY_HASH", vm.toString(bytes32(uint256(1))));
        vm.setEnv("VRF_SUB_ID", "7");
        vm.setEnv("VRF_EXTRA_ARGS", "0x");
        vm.setEnv("GOV_MULTISIG", vm.toString(SAFE));
        vm.setEnv("ENTRY_COST_TIMBS", "1000000000000000000");
        vm.setEnv("INITIAL_SUPPLY", "100000000000000000000000000");
        vm.setEnv("REWARD_RATE_PER_SEC", "1");
        vm.setEnv("FARM_REWARD_RATE", "1");
        vm.setEnv("PROPOSAL_THRESHOLD", "1");
        vm.setEnv("QUORUM_BPS", "400");
        vm.setEnv("VOTING_PERIOD", "86400");
        vm.setEnv("VOTING_DELAY", "1");
        vm.setEnv("TIMBS_ENTRY_FLOOR", "500000000000000000000");
        vm.setEnv("TIMBS_STEP", "100000000000000000000");
        game = new DeployGame();
        game.run();

        // Live airdrop distributor: on mainnet the Safe owns it and the deployer
        // is only the guardian (fast pause). Model that: this test contract
        // stands in for the Safe as owner; the deployer gets the guardian role.
        airdrop = new TimbAirdropDistributor(address(game.timbs()), 1e18, 10_000e18, 10_000e18);
        airdrop.setGuardian(deployer);

        // DeployBeta inputs.
        vm.setEnv("TIMBS_TOKEN_ADDR", vm.toString(address(game.timbs())));
        vm.setEnv("PROTOCOL_SINK_ADDR", vm.toString(SAFE));
        vm.setEnv("PRIZE_ESCROW_ADDR", vm.toString(address(game.prizeEscrow())));
        vm.setEnv("ROUTER_ADDR", vm.toString(address(router)));
        vm.setEnv("ELIGIBLE_REGISTRY_ADDR", vm.toString(address(game.eligibleRegistry())));
        vm.setEnv("YIELD_VAULT_ADDR", vm.toString(address(game.yieldVault())));
        vm.setEnv("STAKING_ADDR", vm.toString(address(game.staking())));
        vm.setEnv("TIMBS_WETH_PAIR", vm.toString(game.timbsEthPair()));
        vm.setEnv("WETH_ADDR", vm.toString(address(weth)));
        vm.setEnv("AIRDROP_ADDR", vm.toString(address(airdrop)));
        vm.setEnv("FAUCET_DISPATCHER", vm.toString(DISPATCHER));
        vm.setEnv("EXPECT_OLD_PRIZE", vm.toString(address(game.timbPrize())));
        vm.setEnv("EXPECT_OLD_REGISTRY", vm.toString(address(game.gameRegistry())));
    }

    // One test, run sequentially: vm.setEnv is process-wide and Foundry runs
    // test functions in parallel, so a second test overriding EXPECT_OLD_PRIZE
    // would race this one.
    function test_BetaDeploy() public {
        // 1. Pre-flight refuses a game the operator did not name.
        vm.setEnv("EXPECT_OLD_PRIZE", vm.toString(address(0xDEAD)));
        DeployBeta wrong = new DeployBeta();
        vm.expectRevert(bytes("PRE-FLIGHT: escrow.timbPrize != EXPECT_OLD_PRIZE"));
        wrong.run();

        // 2. Named correctly, it deploys and wires everything.
        vm.setEnv("EXPECT_OLD_PRIZE", vm.toString(address(game.timbPrize())));
        new DeployBeta().run();

        // TS-009: a new router replaces the live one; the old one is paused.
        TimbSwapRouter newRouter = TimbSwapRouter(payable(factory.router()));
        assertTrue(address(newRouter) != address(router), "factory -> new router");
        assertTrue(router.paused(), "old router paused");
        assertEq(newRouter.minNudgeAmountIn(address(weth)), newRouter.DEFAULT_WETH_NUDGE_FLOOR(), "WETH nudge floor");
        assertEq(newRouter.swapNudgeWeight(), router.swapNudgeWeight(), "nudge weight carried over");
        assertEq(newRouter.freeNudgeCapPerSeg(), router.freeNudgeCapPerSeg(), "free-nudge cap carried over");

        TimbPrize prize = TimbPrize(payable(newRouter.timbPrize()));
        assertTrue(address(prize) != address(game.timbPrize()), "new router -> new prize");
        assertEq(prize.router(), address(newRouter), "prize accepts the new router's nudges");
        assertEq(game.prizeEscrow().timbPrize(), address(prize), "escrow -> new prize");
        GameRegistry reg = GameRegistry(prize.gameRegistry());
        assertTrue(address(reg) != address(game.gameRegistry()), "new registry");
        assertEq(reg.timbPrize(), address(prize));
        assertFalse(reg.timbsEntryEnabled());
        assertEq(reg.maxExtraRounds(), 6);
        assertEq(reg.lapsePotBps(), 10_000);
        assertEq(prize.protocolCutBps(), 200, "2% round sweep");
        assertTrue(newRouter.treasury() != SAFE, "router fee -> new treasury");
        assertEq(TimbTreasury(payable(newRouter.treasury())).router(), address(newRouter), "treasury -> new router");
        assertEq(newRouter.protocolFeeBps(), 0, "router fee 0: all-in 0.30%");
        assertEq(factory.feeTo(), newRouter.treasury(), "pool protocol share -> new treasury");
        assertTrue(airdrop.paused(), "airdrop paused");
        assertFalse(prize.gameStarted(), "startGame left to the runbook");
    }
}
