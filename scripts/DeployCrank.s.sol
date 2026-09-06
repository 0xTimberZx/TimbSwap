// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "../contracts/SegmentCrank.sol";

/**
 * @title DeployCrank
 * @notice Deploys the stateless SegmentCrank batcher. No constructor args, no
 *         wiring, no ownership — it works against any board generation with
 *         the same signatures, so it survives redeploys that the board itself
 *         does not.
 *
 *   forge script scripts/DeployCrank.s.sol --rpc-url "$ARB_SEPOLIA_RPC" --broadcast
 *
 * Afterwards record the address in SwapTables/onchain/addresses.js and the two
 * table pages (console + play) as CRANK.
 */
contract DeployCrank is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);
        SegmentCrank crank = new SegmentCrank();
        vm.stopBroadcast();
        console.log("SegmentCrank:", address(crank));
        console.log("Stateless + permissionless: nothing to wire, nothing to whitelist.");
    }
}
