// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import "../contracts/PoolLedger.sol";
import "../contracts/SeedRegistry.sol";
import "../contracts/VRFEntropy.sol";
import "../contracts/UnderwriteReserve.sol";
import "../contracts/SegmentBoardVRF.sol";

/**
 * @title DeploySegmentBoardVRF
 * @notice Deploys GENERATION 8 — the VRF board (SwapTables/docs/GEN8_VRF.md).
 *
 * What is different from DeploySegmentBoard.s.sol:
 *   - the entropy module is `VRFEntropy`, not `CommitRevealEntropy`;
 *   - it needs Chainlink coordinator wiring, and the module has to be ADDED AS
 *     A CONSUMER on the VRF subscription by hand afterwards — the subscription
 *     is not ours to modify from here;
 *   - `ent.setBoard(board)` is a new one-time wire, without which no table can
 *     ever be armed.
 *
 * Usage:
 *   forge script scripts/DeploySegmentBoardVRF.s.sol \
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
 *   SEED_REGISTRY_ADDRESS  — the long-lived registry (ALWAYS set this after gen-1)
 *   GUARDIAN_ADDRESS, SEED_FUNDER_ADDRESS
 *   VRF_CONFIRMATIONS (default 3), VRF_CALLBACK_GAS (default 200000)
 *   ENTRY_MAX_SECONDS / PLACE_WINDOW_SECONDS / BETS_CLOSE_SECONDS /
 *   SIT_QUIET_SECONDS / SOLO_WAIT_SECONDS
 */
contract DeploySegmentBoardVRF is Script {
    PoolLedger        public ledger;
    SeedRegistry      public seedRegistry;
    VRFEntropy        public entropy;
    UnderwriteReserve public reserve;
    SegmentBoardVRF   public board;

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
            console.log("  ^ generation 1 only - reuse it from here on");
        } else {
            seedRegistry = SeedRegistry(existingRegistry);
            console.log("SeedRegistry (reuse):", address(seedRegistry));
        }

        entropy = new VRFEntropy(coordinator, keyHash, subId, confs, cbGas, extra);
        console.log("VRFEntropy          :", address(entropy));

        reserve = new UnderwriteReserve(timbs, treasury, guardian);
        console.log("UnderwriteReserve   :", address(reserve));

        board = new SegmentBoardVRF(
            address(ledger), address(seedRegistry), address(entropy), timbPrize,
            address(reserve), treasury, seedFunder, guardian,
            entryMax, placeWindow, betsCloseLead, sitQuiet, soloWait
        );
        console.log("SegmentBoardVRF     :", address(board));

        ledger.setBoard(address(board));
        reserve.setBoard(address(board));
        reserve.approveLedger(address(ledger));
        entropy.setBoard(address(board));   // gen-8: without this, nothing arms

        bool registryWired;
        if (seedRegistry.owner() == vm.addr(pk)) {
            seedRegistry.addWriter(address(board));
            registryWired = true;
        }

        vm.stopBroadcast();

        console.log("");
        console.log("--- generation 8 (VRF) deployed ---");
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
            console.log("    whole float would be stranded when gen-9 arrives.");
            console.log("    Fix now with reserve.setGuardian(...) and");
            console.log("    board.setGuardian(...), or redeploy with GUARDIAN_ADDRESS");
            console.log("    set. Only deliberate for a zero-privilege generation.");
        }

        console.log("");
        console.log("REQUIRED next steps, in this order:");
        console.log(" 0. Drain the OLD reserve BEFORE abandoning it:");
        console.log("    oldReserve.drainToTreasury() from its guardian. Skip this");
        console.log("    and the previous generation's float is stranded.");
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
