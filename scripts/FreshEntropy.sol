// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Script.sol";

import {TimbPrize} from "../contracts/TimbPrize.sol";
import {VRFEntropy} from "../contracts/VRFEntropy.sol";

/**
 * @title FreshEntropy
 * @notice A prize must draw from a VRFEntropy module that has never served
 *         another prize. Salts are keccak(round, segment), so a new prize
 *         pointed at a used module would find its round-1 salts already
 *         requested, skip the request and lock from the old prize's words,
 *         which are public: its outcomes would be known in advance. The
 *         scripts deploy a fresh module per prize; this read-back keeps any
 *         later edit to them (an env-supplied module, a reused address) from
 *         broadcasting a reused one. DeployBeta asserts the same in its
 *         post-flight.
 */
abstract contract FreshEntropy is Script {
    function _assertFreshEntropy(TimbPrize prize, VRFEntropy entropy) internal view {
        require(address(prize.entropy()) == address(entropy), "ENTROPY: prize must draw from the new module");
        require(entropy.board() == address(prize), "ENTROPY: module must serve this prize (a reused module's board is its old prize)");
        require(!entropy.isRequested(prize.saltFor(1, 1)), "ENTROPY: module has already drawn round 1 (reused module)");
    }
}
