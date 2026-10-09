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
import {TimbTreasury} from "../contracts/TimbTreasury.sol";
import {GasFaucet} from "../contracts/GasFaucet.sol";

interface IYieldVaultAdmin {
    function setGameRegistry(address) external;
    function setTimbPrize(address) external;
    function gameRegistry() external view returns (address);
    function timbPrize() external view returns (address);
}

interface IAirdropPause {
    function setPaused(bool) external;
    function paused() external view returns (bool);
}

/**
 * @title DeployBeta
 * @notice Mainnet (Arbitrum One) ETH-only capped beta — dev-docs/BETA_ETH_ONLY.md.
 *
 *         The Phase-2 game on mainnet was deployed 2026-09-11 but never started,
 *         so the beta-changed contracts are simply replaced before startGame:
 *
 *           NEW    GameRegistry  (ETH-only switches, entrant cap)
 *           NEW    VRFEntropy    (rerequest cap, TS-005)
 *           NEW    TimbPrize     (bound to the new registry; same pattern as
 *                                 DeployGen3Migration)
 *           NEW    TimbTreasury  (fee-sender check)
 *           NEW    GasFaucet     (top-trader reset; first mainnet deploy)
 *           NEW    TimbSwapRouter (swap-nudge input floor, TS-009); the factory
 *                  is pointed at it and the old router (ROUTER_ADDR) is paused
 *           REUSED TIMBSToken, Factory, pair, PrizeEscrow,
 *                  EligibleTokenRegistry, TimbYieldVault — repointed below.
 *
 *         Beta values set here: extra rounds free (registry default), max 6
 *         (registry default), TIMBS entries off (registry default), lapsed
 *         principal 100% to the pot, faucet 0.00025 ETH to the wallet + 0.00025
 *         ETH to the pot per claim every 24 h with the TIMBS leg off, and the
 *         testnet→mainnet TIMB airdrop paused (no TIMBS in circulation before
 *         the audit).
 *
 * Env (.env.mainnet — never commit; load the key with `read -s`):
 *   DEPLOYER_PRIVATE_KEY     current owner of the reused contracts (handoff is
 *                            still pending) and the airdrop guardian
 *   TIMBS_TOKEN_ADDR         0x44bc0ab521191e839c3cb5bb20c9d044c8471ea1
 *   PROTOCOL_SINK_ADDR       copy the live value: cast call <OLD_REGISTRY> "protocolSink()(address)"
 *   PRIZE_ESCROW_ADDR        0xa9355021cef39be7b67fb81a1c91df53fce0dd32
 *   ROUTER_ADDR              0x4f33df838c0d357c7f1a44ffb5ee0fc49a62b5fe
 *   ELIGIBLE_REGISTRY_ADDR   0x0fd3777190380a12f106f57c67913f7159bc8c34
 *   YIELD_VAULT_ADDR         0x73a33dbe76908cb2b05055931258878b0ae9b3cc
 *   STAKING_ADDR             0xed8d6d5fe6eedcd173dbc09ef9b6474e4f155a83 (treasury ctor arg; unfunded in beta)
 *   TIMBS_WETH_PAIR          0x6103c1145a0090ec0e39e9e75e6efb3c0099b86f (treasury ctor arg; no buybacks in beta)
 *   WETH_ADDR                0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
 *   AIRDROP_ADDR             0x955e5800245164EC4DCd1da9062115bBdA132c83 (paused here; 0 to skip)
 *   SETTLER_ADDR             optional keeper EOA for settleSegment()
 *   FAUCET_DISPATCHER        fresh mainnet hot key (faucet + top-trader keepers)
 *   FAUCET_GUARDIAN          optional fast-pause key
 *   VRF_COORDINATOR / VRF_KEY_HASH / VRF_SUB_ID / VRF_EXTRA_ARGS
 *                            copy from the live Prize VRFEntropy (0x862aa09c…):
 *                            `cast call <OLD_ENTROPY> "extraArgs()(bytes)"` etc.
 *                            Copy extraArgs VERBATIM (see GEN3 migration notes).
 *   VRF_CONFIRMATIONS / VRF_CALLBACK_GAS   optional, defaults 3 / 200000
 *   EXPECT_OLD_PRIZE         0x70e7c0c1470a5d79728cd5676940883e981365ed
 *   EXPECT_OLD_REGISTRY      0x8c40ed0cce3585b694a45106314b09dff4e04137
 *   Optional overrides (beta defaults shown):
 *   TIMBS_ENTRY_FLOOR=500e18  TIMBS_STEP=100e18   (TIMBS leg is off; ctor needs non-zero)
 *   FAUCET_DRIP_ETH=2.5e14  FAUCET_POT_ETH=2.5e14  FAUCET_COOLDOWN=86400
 *   FAUCET_ETH_CAP=1.5e18   OPERATOR_ETH_CAP=1e17 per OPERATOR_PERIOD=86400
 *
 * Run (read-only pre-flight, then simulate without --broadcast and read the
 * PRE-FLIGHT block, then broadcast and fill config.mainnet.js from the receipt):
 *   R1=$ARB_RPC sh scripts/beta-preflight.sh
 *   forge script scripts/DeployBeta.s.sol --rpc-url $ARB_RPC -vvvv
 *   forge script scripts/DeployBeta.s.sol --rpc-url $ARB_RPC --broadcast --gas-estimate-multiplier 300
 *   node scripts/fill-beta-config.js --write
 */
interface ITimbSwapFactoryAdmin {
    function setRouter(address router) external;
    function router() external view returns (address);
    function setFeeTo(address feeTo) external;
    function feeTo() external view returns (address);
}

contract DeployBeta is Script {
    struct Cfg {
        address timbs; address sink; address escrow; address router; address eligible;
        address vault; address staking; address pair; address weth; address airdrop;
        address settler; address dispatcher; address guardian;
        address vrfCoord; bytes32 vrfKeyHash; uint256 vrfSubId; bytes vrfExtra;
        uint16 vrfConfs; uint32 vrfCbGas;
    }

    struct Deployed {
        GameRegistry registry; VRFEntropy entropy; TimbPrize prize;
        TimbTreasury treasury; GasFaucet faucet; TimbSwapRouter router;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        Cfg memory c = _cfg();

        _preflight(c);

        vm.startBroadcast(deployerKey);
        Deployed memory d;
        d.treasury = _deployTreasury(c);
        d.router   = _deployRouter(c, d.treasury);
        _deployGame(c, d);
        _switchRouter(c, d);
        d.faucet   = _deployFaucet(c, d);
        if (c.airdrop != address(0) && !IAirdropPause(c.airdrop).paused()) {
            IAirdropPause(c.airdrop).setPaused(true);
        }
        vm.stopBroadcast();

        _report(c, d);
    }

    function _cfg() internal view returns (Cfg memory c) {
        c.timbs     = vm.envAddress("TIMBS_TOKEN_ADDR");
        c.sink      = vm.envAddress("PROTOCOL_SINK_ADDR");
        c.escrow    = vm.envAddress("PRIZE_ESCROW_ADDR");
        c.router    = vm.envAddress("ROUTER_ADDR");
        c.eligible  = vm.envAddress("ELIGIBLE_REGISTRY_ADDR");
        c.vault     = vm.envAddress("YIELD_VAULT_ADDR");
        c.staking   = vm.envAddress("STAKING_ADDR");
        c.pair      = vm.envAddress("TIMBS_WETH_PAIR");
        c.weth      = vm.envAddress("WETH_ADDR");
        c.airdrop   = vm.envOr("AIRDROP_ADDR", address(0));
        c.settler   = vm.envOr("SETTLER_ADDR", address(0));
        c.dispatcher = vm.envAddress("FAUCET_DISPATCHER");
        c.guardian  = vm.envOr("FAUCET_GUARDIAN", address(0));
        c.vrfCoord  = vm.envAddress("VRF_COORDINATOR");
        c.vrfKeyHash = vm.envBytes32("VRF_KEY_HASH");
        c.vrfSubId  = vm.envUint("VRF_SUB_ID");
        c.vrfExtra  = vm.envBytes("VRF_EXTRA_ARGS");
        c.vrfConfs  = uint16(vm.envOr("VRF_CONFIRMATIONS", uint256(3)));
        c.vrfCbGas  = uint32(vm.envOr("VRF_CALLBACK_GAS", uint256(200_000)));
    }

    /// @dev Registry + entropy + prize, wired to each other, to the new router
    ///      and to the reused escrow, eligible registry and yield vault.
    function _deployGame(Cfg memory c, Deployed memory d) internal {
        d.registry = new GameRegistry(
            c.timbs, c.sink, address(0),
            vm.envOr("TIMBS_ENTRY_FLOOR", uint256(500e18)),
            vm.envOr("TIMBS_STEP", uint256(100e18))
        );
        d.entropy = new VRFEntropy(c.vrfCoord, c.vrfKeyHash, c.vrfSubId, c.vrfConfs, c.vrfCbGas, c.vrfExtra);
        d.prize   = new TimbPrize(c.escrow, address(d.registry), address(d.router));

        d.registry.setTimbPrize(address(d.prize));
        d.registry.setYieldVault(c.vault);
        // Beta: lapsed ETH principal goes 100% to the pot (default 70/30).
        d.registry.setLapsePotBps(10_000);
        // Beta defaults already in the registry: timbsEntryEnabled=false,
        // extraRoundCostTimbs=0, maxExtraRounds=6, maxEntrantsPerString=100,
        // allowRepeatedChars=false. Asserted in _report.

        d.entropy.setBoard(address(d.prize));
        d.prize.setEntropy(address(d.entropy));
        d.prize.setEligibleRegistry(c.eligible);
        d.prize.setYieldVault(c.vault);
        if (c.settler != address(0)) d.prize.setSettler(c.settler);

        PrizeEscrow(payable(c.escrow)).setTimbPrize(address(d.prize));
        d.router.setTimbPrize(address(d.prize));
        EligibleTokenRegistry(c.eligible).registerConsumer(address(d.prize));
        IYieldVaultAdmin(c.vault).setGameRegistry(address(d.registry));
        IYieldVaultAdmin(c.vault).setTimbPrize(address(d.prize));
    }

    /// @dev New treasury (fee-sender check). The new router's 0.05% fee goes to
    ///      it; PrizeEscrow is authorised at construction for the 2% cut.
    function _deployTreasury(Cfg memory c) internal returns (TimbTreasury t) {
        t = new TimbTreasury(c.timbs, c.staking, c.escrow, c.pair, c.weth);
    }

    /// @dev New router (TS-009: swap nudges need a minimum input, which the
    ///      live router lacks). Same factory and WETH as the live router; its
    ///      nudge settings are copied so behaviour only changes by the floor.
    ///      WETH/ETH gets the default 0.001 ETH floor; any other token earns no
    ///      nudges until setMinNudgeAmountIn is called for it.
    function _deployRouter(Cfg memory c, TimbTreasury t) internal returns (TimbSwapRouter r) {
        TimbSwapRouter old = TimbSwapRouter(payable(c.router));
        r = new TimbSwapRouter(old.factory(), address(t), c.eligible, address(0), c.weth);
        if (r.swapNudgeWeight() != old.swapNudgeWeight())       r.setSwapNudgeWeight(old.swapNudgeWeight());
        if (r.freeNudgeCapPerSeg() != old.freeNudgeCapPerSeg()) r.setFreeNudgeCapPerSeg(old.freeNudgeCapPerSeg());
        t.setRouter(address(r));
    }

    /// @dev Point the factory at the new router, register it as an eligible-
    ///      registry consumer, and pause the old router so stale frontends can
    ///      no longer swap through it. Pairs stay where they are.
    function _switchRouter(Cfg memory c, Deployed memory d) internal {
        TimbSwapRouter old = TimbSwapRouter(payable(c.router));
        ITimbSwapFactoryAdmin(old.factory()).setRouter(address(d.router));
        // The pools' 0.05% protocol share is minted as LP to feeTo; the new
        // treasury's splitLpFees sends half of it to the pot.
        ITimbSwapFactoryAdmin(old.factory()).setFeeTo(address(d.treasury));
        EligibleTokenRegistry(c.eligible).registerConsumer(address(d.router));
        if (!old.paused()) old.pause();
    }

    function _deployFaucet(Cfg memory c, Deployed memory d) internal returns (GasFaucet f) {
        uint256 ethCap = vm.envOr("FAUCET_ETH_CAP", uint256(1.5e18));
        f = new GasFaucet(
            address(d.treasury), c.timbs, address(d.registry), address(d.prize),
            vm.envOr("FAUCET_DRIP_ETH", uint256(2.5e14)),
            vm.envOr("FAUCET_POT_ETH",  uint256(2.5e14)),
            0,                                            // no TIMBS leg in the beta
            vm.envOr("FAUCET_COOLDOWN", uint256(86_400))
        );
        f.setDispatcher(c.dispatcher);
        if (c.guardian != address(0)) f.setGuardian(c.guardian);
        f.setEthCap(ethCap);
        f.setTimbsCap(0);
        f.setTimbsPaused(true);

        // The faucet pulls ETH from the treasury as its rate-limited operator.
        d.treasury.setOperator(address(f));
        d.treasury.setOperatorEthCap(
            vm.envOr("OPERATOR_ETH_CAP", uint256(1e17)),
            vm.envOr("OPERATOR_PERIOD",  uint256(86_400))
        );
    }

    /// @dev Refuse to repoint shared infra away from a game the operator did not
    ///      name (INCIDENT_2026-09-15_SHARED_INFRA_REPOINT). Runs in simulation too.
    function _preflight(Cfg memory c) internal view {
        address expectPrize    = vm.envAddress("EXPECT_OLD_PRIZE");
        address expectRegistry = vm.envAddress("EXPECT_OLD_REGISTRY");
        console.log("PRE-FLIGHT: shared infra currently bound to");
        console.log("  escrow.timbPrize   ", PrizeEscrow(payable(c.escrow)).timbPrize());
        console.log("  router.timbPrize   ", TimbSwapRouter(payable(c.router)).timbPrize());
        console.log("  vault.timbPrize    ", IYieldVaultAdmin(c.vault).timbPrize());
        console.log("  vault.gameRegistry ", IYieldVaultAdmin(c.vault).gameRegistry());
        require(PrizeEscrow(payable(c.escrow)).timbPrize() == expectPrize, "PRE-FLIGHT: escrow.timbPrize != EXPECT_OLD_PRIZE");
        require(TimbSwapRouter(payable(c.router)).timbPrize() == expectPrize, "PRE-FLIGHT: router.timbPrize != EXPECT_OLD_PRIZE");
        require(IYieldVaultAdmin(c.vault).timbPrize() == expectPrize, "PRE-FLIGHT: vault.timbPrize != EXPECT_OLD_PRIZE");
        require(IYieldVaultAdmin(c.vault).gameRegistry() == expectRegistry, "PRE-FLIGHT: vault.gameRegistry != EXPECT_OLD_REGISTRY");
        require(TimbPrize(payable(expectPrize)).gameStarted() == false, "PRE-FLIGHT: old prize already started - this is a live game");
    }

    function _report(Cfg memory c, Deployed memory d) internal view {
        require(!d.registry.timbsEntryEnabled(),        "beta: TIMBS entry must be off");
        require(d.registry.extraRoundCostTimbs() == 0,  "beta: extra rounds must be free");
        require(d.registry.maxExtraRounds() == 6,       "beta: max 6 extra rounds");
        require(!d.registry.allowRepeatedChars(),       "beta: no repeated chars");
        require(d.registry.lapsePotBps() == 10_000,     "beta: lapse 100% to pot");
        require(d.treasury.authorisedFeeSenders(c.escrow), "treasury must count the escrow's cut");
        TimbSwapRouter old = TimbSwapRouter(payable(c.router));
        require(ITimbSwapFactoryAdmin(old.factory()).router() == address(d.router), "factory must use the new router");
        require(d.router.timbPrize() == address(d.prize),       "new router must nudge the new prize");
        require(d.router.treasury() == address(d.treasury),     "new router fee must go to the new treasury");
        require(d.prize.router() == address(d.router),          "prize must accept nudges from the new router");
        require(d.treasury.router() == address(d.router),       "treasury must use the new router");
        require(d.router.minNudgeAmountIn(c.weth) > 0,          "WETH nudge floor must be set (TS-009)");
        require(old.paused(),                                   "old router must be paused");
        require(d.router.protocolFeeBps() == 0,                 "router fee must be 0 (all-in 0.30%)");
        require(ITimbSwapFactoryAdmin(old.factory()).feeTo() == address(d.treasury), "pool protocol share must go to the new treasury");
        if (c.airdrop != address(0)) require(IAirdropPause(c.airdrop).paused(), "airdrop must be paused");
        // Shared infra named the OLD game in _preflight; it must name the NEW one now.
        require(PrizeEscrow(payable(c.escrow)).timbPrize() == address(d.prize),  "escrow must pay the new prize");
        require(IYieldVaultAdmin(c.vault).timbPrize() == address(d.prize),       "vault must accrue to the new prize");
        require(IYieldVaultAdmin(c.vault).gameRegistry() == address(d.registry), "vault must weigh the new registry");
        require(d.prize.yieldVault() == c.vault && d.registry.yieldVault() == c.vault, "game must use the live vault");
        require(d.registry.timbPrize() == address(d.prize),                     "registry must report to the new prize");
        require(address(d.prize.entropy()) == address(d.entropy),               "prize must draw from the new entropy");
        require(d.entropy.board() == address(d.prize),                          "entropy must serve the new prize");
        require(d.prize.eligibleRegistry() == c.eligible,                       "prize must use the live eligible registry");
        EligibleTokenRegistry elig = EligibleTokenRegistry(c.eligible);
        require(elig.registeredConsumers(address(d.prize)) && elig.registeredConsumers(address(d.router)),
                "eligible registry must know the new prize and router");
        require(d.faucet.dispatcher() == c.dispatcher,                          "faucet dispatcher must be the mainnet hot key");
        require(d.treasury.operator() == address(d.faucet),                     "faucet must be the treasury's operator");
        require(d.faucet.timbsPaused() && d.faucet.timbsCap() == 0,             "faucet TIMBS leg must be off");
        require(!d.prize.gameStarted(),                                         "deploy must not start the game");

        console.log("\n========== BETA DEPLOY COMPLETE ==========");
        console.log("GameRegistry:     ", address(d.registry));
        console.log("TimbPrize:        ", address(d.prize));
        console.log("PrizeVRFEntropy:  ", address(d.entropy));
        console.log("TimbTreasury:     ", address(d.treasury));
        console.log("GasFaucet:        ", address(d.faucet));
        console.log("TimbSwapRouter:   ", address(d.router), "(new; old router paused)");
        console.log("==========================================");
        console.log("NEXT (dev-docs/BETA_ETH_ONLY.md, deploy checklist):");
        console.log("1. Add PrizeVRFEntropy as a consumer on VRF sub", c.vrfSubId, "; remove the old entropy");
        console.log("2. Fund the treasury with the faucet's ETH budget (operator pulls from it)");
        console.log("3. Record the six addresses (incl. the new router) in MAINNET_ADDRESSES.md and config.mainnet.js");
        console.log("4. TimbPrize.startGame()  (opens round 1)");
        console.log("5. Keepers: settler, faucet, top-trader on the mainnet dispatcher/settler keys");
        console.log("6. Ownership handoff to the timelock for the new contracts too");
    }
}
