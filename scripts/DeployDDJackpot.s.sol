// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import "../contracts/DDJackpot.sol";

/**
 * @title DeployDDJackpot
 * @notice Deploys the Rolling Double-Digit Jackpot (M2) — ONCE. It is
 *         cross-generation like SeedRegistry and SegmentCrank: never redeploy
 *         it; on each new board generation call setBoard(newBoard, true) and
 *         setBoard(oldBoard, false).
 *
 * Environment (.env — never commit):
 *   DEPLOYER_PRIVATE_KEY — deployer wallet (becomes owner)
 *   TIMBS_ADDRESS        — TIMBS token
 *   TREASURY_ADDRESS     — drain destination
 *   GUARDIAN_ADDRESS     — halt/drain role (0 for none)
 *   BOARD_ADDRESS        — the current SegmentBoard generation to trust
 *
 * Usage:
 *   forge script scripts/DeployDDJackpot.s.sol \
 *     --rpc-url $ARB_SEPOLIA_RPC --broadcast --verify --verifier sourcify -vvvv
 *
 * Post-deploy (MANUAL):
 *   1. TIMBS.setTransferWhitelist(jackpot, true) — it pushes slices straight
 *      to winner wallets, so it must clear the transfer cap.
 *   2. Fund it: plain TIMBS transfer or donate() — budgeted from earnings
 *      only (GAME_ECONOMY solvency rule; recycled, never minted).
 *   3. Record the address in SwapTables/onchain/addresses.js + app ADDR.
 */
contract DeployDDJackpot is Script {
    DDJackpot public jackpot;

    function run() external {
        uint256 pk       = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address timbs    = vm.envAddress("TIMBS_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address guardian = vm.envOr("GUARDIAN_ADDRESS", address(0));
        address boardA   = vm.envAddress("BOARD_ADDRESS");

        vm.startBroadcast(pk);
        jackpot = new DDJackpot(timbs, treasury, guardian);
        jackpot.setBoard(boardA, true);
        vm.stopBroadcast();

        console.log("DDJackpot        :", address(jackpot));
        console.log("trusted board    :", boardA);
        console.log("guardian         :", guardian);
        console.log("meter            : 20% of balance, floor 50 TIMBS (owner-tunable)");
        console.log("");
        console.log("REQUIRED next steps:");
        console.log(" 1. TIMBS.setTransferWhitelist(jackpot, true)");
        console.log(" 2. Fund it (plain transfer or donate) - recycled earnings only");
        console.log(" 3. Record the address in SwapTables/onchain/addresses.js + app ADDR");
    }
}
