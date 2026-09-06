// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import "../contracts/PoolLedger.sol";
import "../contracts/SeedRegistry.sol";
import "../contracts/VRFEntropy.sol";
import "../contracts/UnderwriteReserve.sol";
import "../contracts/SegmentBoardVRF9.sol";

/**
 * @title DeploySegmentBoardVRF9
 * @notice Deploys GENERATION 9 — the seed-reroute board
 *         (dev-docs/AUDIT_SEED_FARM.md §"The gen-9 fix").
 *
 * What is different from DeploySegmentBoardVRF.s.sol (gen-8):
 *   - the board is `SegmentBoardVRF9`. The ONLY behavioural change is the flow of
 *     the 100-TIMBS table seed: gen-8 sprinkled it across contested pots (the
 *     §9 two-wallet hedge farmed ~79% of it, risk-free); gen-9 never puts it in
 *     a pot at all and sweeps the whole seed to the UnderwriteReserve at retire.
 *     Honest winners land on the identical stake x fair x 0.90 target — the
 *     reserve just covers more of the top-up. See tests/SeedFarmClosed.t.sol.
 *   - EVERYTHING ELSE is byte-for-byte the gen-8 process: same VRF wiring, same
 *     consumer-add step, same reserve seeding-by-plain-transfer, same role
 *     footguns. PoolLedger / VRFEntropy / UnderwriteReserve bytecode is
 *     unchanged, but they are REDEPLOYED fresh per generation (immutable board
 *     pointer). SeedRegistry and DDJackpot are the deploy-once cross-generation
 *     pieces and are reused.
 *
 * Usage:
 *   forge script scripts/DeploySegmentBoardVRF9.s.sol \
 *     --rpc-url $ARB_SEPOLIA_RPC --broadcast --verify --verifier sourcify -vvvv
 *
 * Required (.env — never commit):
 *   DEPLOYER_PRIVATE_KEY, TIMBS_ADDRESS, TIMB_PRIZE_ADDRESS, TREASURY_ADDRESS
 *   VRF_COORDINATOR   — Chainlink VRF v2.5 coordinator on Arbitrum Sepolia
 *   VRF_KEY_HASH      — the gas lane
 *   VRF_SUB_ID        — subscription this module will be a consumer of
 *   VRF_EXTRA_ARGS    — v2.5 extraArgs blob, hex. Build it with
 *                       VRFV2PlusClient._argsToBytes(ExtraArgsV1({nativePayment:false}))
 *                       and paste the result. It is NOT reconstructed in
 *                       source: the tag is a Chainlink constant, and a wrong
 *                       guess produces requests the coordinator rejects.
 *
 * Every VRF value above is a NETWORK FACT. Read them off Chainlink's published
 * supported-networks table at deploy time. Do not carry them from memory and do
 * not copy them from an older runbook.
 *
 * Optional:
 *   SEED_REGISTRY_ADDRESS  — the long-lived registry (ALWAYS set this; gen-9 is
 *                            NOT generation 1, so this must already exist)
 *   GUARDIAN_ADDRESS, SEED_FUNDER_ADDRESS
 *   VRF_CONFIRMATIONS (default 3), VRF_CALLBACK_GAS (default 200000)
 *   ENTRY_MAX_SECONDS / PLACE_WINDOW_SECONDS / BETS_CLOSE_SECONDS /
 *   SIT_QUIET_SECONDS / SOLO_WAIT_SECONDS
 */
contract DeploySegmentBoardVRF9 is Script {
    PoolLedger        public ledger;
    SeedRegistry      public seedRegistry;
    VRFEntropy        public entropy;
    UnderwriteReserve public reserve;
    SegmentBoardVRF9  public board;

    function run() external {
        uint256 pk        = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address timbs     = vm.envAddress("TIMBS_ADDRESS");
        address timbPrize = vm.envAddress("TIMB_PRIZE_ADDRESS");
        address treasury  = vm.envAddress("TREASURY_ADDRESS");
        address seedFunder = vm.envOr("SEED_FUNDER_ADDRESS", treasury);
        address guardian  = vm.envOr("GUARDIAN_ADDRESS", address(0));

        address coordinator = vm.envAddress("VRF_COORDINATOR");
        bytes32 keyHash     = vm.envBytes32("VRF_KEY_HASH");
        uint256 subId       = vm.envUint("VRF_SUB_ID");
        bytes memory extra  = vm.envBytes("VRF_EXTRA_ARGS");
        uint16  confs       = uint16(vm.envOr("VRF_CONFIRMATIONS", uint256(3)));
        uint32  cbGas       = uint32(vm.envOr("VRF_CALLBACK_GAS", uint256(200_000)));

        uint64 entryMax      = uint64(vm.envOr("ENTRY_MAX_SECONDS",    uint256(40 minutes)));
        uint64 placeWindow   = uint64(vm.envOr("PLACE_WINDOW_SECONDS", uint256(5 minutes)));
        uint64 betsCloseLead = uint64(vm.envOr("BETS_CLOSE_SECONDS",   uint256(2 minutes)));
        uint64 sitQuiet      = uint64(vm.envOr("SIT_QUIET_SECONDS",    uint256(5 minutes)));
        uint64 soloWait      = uint64(vm.envOr("SOLO_WAIT_SECONDS",    uint256(15 minutes)));

        address existingRegistry = vm.envOr("SEED_REGISTRY_ADDRESS", address(0));

        vm.startBroadcast(pk);

        ledger = new PoolLedger(timbs, treasury);
        console.log("PoolLedger          :", address(ledger));

        if (existingRegistry == address(0)) {
            seedRegistry = new SeedRegistry();
            console.log("SeedRegistry (NEW)  :", address(seedRegistry));
            console.log("  ^ gen-9 should REUSE the existing registry - a NEW one");
            console.log("    here means SEED_REGISTRY_ADDRESS was not set. Double-check.");
        } else {
            seedRegistry = SeedRegistry(existingRegistry);
            console.log("SeedRegistry (reuse):", address(seedRegistry));
        }

        entropy = new VRFEntropy(coordinator, keyHash, subId, confs, cbGas, extra);
        console.log("VRFEntropy          :", address(entropy));

        reserve = new UnderwriteReserve(timbs, treasury, guardian);
        console.log("UnderwriteReserve   :", address(reserve));

        board = new SegmentBoardVRF9(
            address(ledger), address(seedRegistry), address(entropy), timbPrize,
            address(reserve), treasury, seedFunder, guardian,
            entryMax, placeWindow, betsCloseLead, sitQuiet, soloWait
        );
        console.log("SegmentBoardVRF9    :", address(board));

        ledger.setBoard(address(board));
        reserve.setBoard(address(board));
        reserve.approveLedger(address(ledger));
        entropy.setBoard(address(board));   // without this, nothing arms

        bool registryWired;
        if (seedRegistry.owner() == vm.addr(pk)) {
            seedRegistry.addWriter(address(board));
            registryWired = true;
        }

        vm.stopBroadcast();

        console.log("");
        console.log("--- generation 9 (seed reroute) deployed ---");
        console.log("coordinator     :", coordinator);
        console.log("subscription    :", subId);
        console.log("confirmations   :", confs);
        console.log("callback gas    :", cbGas);
        // ── the two roles that are silently wrong until something reverts ──
        // Both default to values that look harmless and are not. Print who
        // actually holds them, loudly, while the terminal is still open.
        console.log("seed funder     :", seedFunder);
        console.log("guardian        :", guardian);
        console.log("deployer        :", vm.addr(pk));
        if (seedFunder != vm.addr(pk)) {
            console.log("");
            console.log(" !! SEED FUNDER IS NOT THE DEPLOYER.");
            console.log("    openTable pulls the 100 TIMBS seed from the seed funder,");
            console.log("    so the approve in step 4 must be signed by the address");
            console.log("    printed above - NOT by this deployer. Approving from the");
            console.log("    wrong wallet is what made gen-7's first openTable revert");
            console.log("    ERC20InsufficientAllowance. Either approve from it, or");
            console.log("    call board.setSeedFunder(<the wallet holding the budget>).");
        }
        if (guardian == address(0)) {
            console.log("");
            console.log(" !! GUARDIAN IS ZERO. Nobody can halt this reserve, and");
            console.log("    nobody can drainToTreasury() it at generation end - its");
            console.log("    whole float would be stranded when gen-10 arrives.");
            console.log("    Fix now with reserve.setGuardian(...) and");
            console.log("    board.setGuardian(...), or redeploy with GUARDIAN_ADDRESS");
            console.log("    set. Only deliberate for a zero-privilege generation.");
        }

        console.log("");
        console.log("REQUIRED next steps, in this order:");
        console.log(" 0. Drain the OLD (gen-8) reserve BEFORE abandoning it:");
        console.log("    oldReserve.drainToTreasury() from its guardian. Skip this");
        console.log("    and gen-8's float is stranded. NOTE: gen-9 routes the WHOLE");
        console.log("    seed into this reserve, so its float grows faster than gen-8's.");
        console.log(" 1. ADD VRFEntropy AS A CONSUMER on the VRF subscription");
        console.log("    (vrf.chain.link) - until then every armSegment reverts");
        console.log("    inside the coordinator, whatever the LINK balance says.");
        console.log(" 2. FUND the subscription with LINK. 6 requests per round.");
        console.log(" 3. TIMBS.setTransferWhitelist(poolLedger, true) and");
        console.log("    TIMBS.setTransferWhitelist(reserve, true) - large payouts");
        console.log("    and reserve pulls both trip maxTransferAmount without it.");
        console.log(" 4. From the SEED FUNDER printed above:");
        console.log("    TIMBS.approve(poolLedger, seedBudget)");
        console.log(" 5. Seed the reserve by PLAIN TRANSFER. NOT fundBudgeted -");
        console.log("    it reverts on a fresh reserve, whose earned counter is 0.");
        console.log(" 6. DDJackpot.setBoard(newBoard, true) - an untrusted board");
        console.log("    reverts BoardNotTrusted at the strike.");
        console.log(" 7. Arm ONE segment and watch it fulfil before opening to");
        console.log("    anyone. Measure the latency: it sets the reveal gap.");
        console.log(" 8. Record addresses in config.js + onchain/addresses.js, and");
        console.log("    the ADDR block of all four pages");
        if (!registryWired) {
            console.log(" !! registry owner must call seedRegistry.addWriter(board)");
            console.log("    - this board CANNOT open tables until they do.");
        }
    }
}
