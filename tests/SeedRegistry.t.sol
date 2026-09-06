// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

// Run: forge test --match-contract SeedRegistryTest -vvv

import "forge-std/Test.sol";
import "../contracts/SeedRegistry.sol";

contract SeedRegistryTest is Test {
    SeedRegistry reg;

    address genA = address(0x6E11); // board generation 1
    address genB = address(0x6E12); // board generation 2

    function setUp() public {
        reg = new SeedRegistry();
    }

    function test_AddWriterAndMarkUsed() public {
        reg.addWriter(genA);
        assertTrue(reg.isWriter(genA));

        vm.prank(genA);
        reg.markUsed(7);
        assertTrue(reg.isUsed(7));
        assertEq(reg.totalUsed(), 1);
    }

    function test_NonWriterCannotMark() public {
        vm.prank(genA);
        vm.expectRevert(SeedRegistry.NotWriter.selector);
        reg.markUsed(1);
    }

    function test_RoundCannotBeReused_SameWriter() public {
        reg.addWriter(genA);
        vm.startPrank(genA);
        reg.markUsed(3);
        vm.expectRevert(abi.encodeWithSelector(SeedRegistry.SeedAlreadyUsed.selector, 3));
        reg.markUsed(3);
        vm.stopPrank();
    }

    function test_RoundCannotBeReused_AcrossGenerations() public {
        reg.addWriter(genA);
        reg.addWriter(genB);

        vm.prank(genA);
        reg.markUsed(42); // gen A consumes round 42

        // gen B (a later generation) cannot reuse the same round as a seed
        vm.prank(genB);
        vm.expectRevert(abi.encodeWithSelector(SeedRegistry.SeedAlreadyUsed.selector, 42));
        reg.markUsed(42);

        // but a fresh round is fine
        vm.prank(genB);
        reg.markUsed(43);
        assertEq(reg.totalUsed(), 2);
    }

    function test_OnlyOwnerManagesWriters() public {
        vm.prank(genA);
        vm.expectRevert();
        reg.addWriter(genB);
    }

    function test_AddWriterGuards() public {
        vm.expectRevert(SeedRegistry.ZeroAddress.selector);
        reg.addWriter(address(0));
        reg.addWriter(genA);
        vm.expectRevert(SeedRegistry.AlreadyWriter.selector);
        reg.addWriter(genA);
    }

    function test_RemoveWriterRevokesAccess() public {
        reg.addWriter(genA);
        reg.removeWriter(genA);
        assertFalse(reg.isWriter(genA));
        vm.prank(genA);
        vm.expectRevert(SeedRegistry.NotWriter.selector);
        reg.markUsed(1);

        vm.expectRevert(SeedRegistry.UnknownWriter.selector);
        reg.removeWriter(genB);
    }

    /// @dev Append-only: there is no path that clears a used mark, and a removed
    ///      writer's marks persist.
    function test_MarksPersistAfterWriterRemoved() public {
        reg.addWriter(genA);
        vm.prank(genA);
        reg.markUsed(9);
        reg.removeWriter(genA);
        assertTrue(reg.isUsed(9)); // still used forever
    }
}
