// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

// Run: forge test --match-contract CommitRevealEntropyTest -vvv

import "forge-std/Test.sol";
import "../contracts/CommitRevealEntropy.sol";

contract CommitRevealEntropyTest is Test {
    CommitRevealEntropy ent;

    bytes32 secret = keccak256("segment-3-secret");
    bytes32 salt   = keccak256(abi.encodePacked(uint256(1), uint256(3))); // table 1, seg 3

    function setUp() public {
        ent = new CommitRevealEntropy();
        vm.roll(1000); // give a comfortable block height
    }

    function test_CommitmentIsDeterministic() public view {
        bytes32 c1 = ent.commitmentOf(secret, salt);
        bytes32 c2 = ent.commitmentOf(secret, salt);
        assertEq(c1, c2);
        assertTrue(c1 != ent.commitmentOf(secret, keccak256("other-salt")));
    }

    function test_DeriveHappyPath() public {
        bytes32 commitment = ent.commitmentOf(secret, salt);
        uint256 lockBlock = block.number - 100; // past, within 256
        bytes32 e = ent.deriveEntropy(commitment, secret, lockBlock, salt);
        assertTrue(e != bytes32(0));
        // deterministic given the same inputs + chain state
        assertEq(e, ent.deriveEntropy(commitment, secret, lockBlock, salt));
    }

    function test_BadRevealReverts() public {
        bytes32 commitment = ent.commitmentOf(secret, salt);
        uint256 lockBlock = block.number - 100;
        vm.expectRevert(CommitRevealEntropy.BadReveal.selector);
        ent.deriveEntropy(commitment, keccak256("wrong"), lockBlock, salt);
    }

    function test_LockBlockMustBePast() public {
        bytes32 commitment = ent.commitmentOf(secret, salt);
        vm.expectRevert(
            abi.encodeWithSelector(CommitRevealEntropy.LockBlockNotPast.selector, block.number)
        );
        ent.deriveEntropy(commitment, secret, block.number, salt);
    }

    function test_LockBlockBeyondHorizonReverts() public {
        bytes32 commitment = ent.commitmentOf(secret, salt);
        uint256 lockBlock = block.number - 300; // older than 256 -> blockhash == 0
        vm.expectRevert(
            abi.encodeWithSelector(CommitRevealEntropy.LockBlockUnavailable.selector, lockBlock)
        );
        ent.deriveEntropy(commitment, secret, lockBlock, salt);
    }

    function test_EntropyDependsOnLockBlock() public {
        bytes32 commitment = ent.commitmentOf(secret, salt);
        bytes32 eA = ent.deriveEntropy(commitment, secret, block.number - 100, salt);
        bytes32 eB = ent.deriveEntropy(commitment, secret, block.number - 101, salt);
        // different lock blocks -> different block hashes -> different entropy
        assertTrue(eA != eB);
    }

    function test_FallbackNeedsNoSecretButNeedsPastBlock() public {
        uint256 lockBlock = block.number - 50;
        bytes32 e = ent.fallbackEntropy(lockBlock, salt);
        assertTrue(e != bytes32(0));
        // fallback differs from the full derivation (no secret, tagged)
        bytes32 commitment = ent.commitmentOf(secret, salt);
        assertTrue(e != ent.deriveEntropy(commitment, secret, lockBlock, salt));
        // future block still rejected
        vm.expectRevert(
            abi.encodeWithSelector(CommitRevealEntropy.LockBlockNotPast.selector, block.number + 1)
        );
        ent.fallbackEntropy(block.number + 1, salt);
    }
}
