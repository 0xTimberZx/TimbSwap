// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/TimbYieldVault.sol";
import "../contracts/GameRegistry.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockTIMBS is ERC20 {
    constructor() ERC20("TIMBS", "TIMBS") {}
}

/// @dev Records newEpoch() calls so the registry's generation-bump hook can be
///      asserted without wiring the whole prize game.
contract RecordingVault {
    uint256 public epochs;
    function register(uint256, address, uint256) external {}
    function remove(uint256) external {}
    function newEpoch() external { epochs += 1; }
}

/**
 * TS-014 — yield-vault weight must not outlive the game it was registered in.
 *
 *   • registry swap:   setGameRegistry retires every weight the old registry
 *                      registered, so an unreclaimed ticket stops drawing yield
 *                      and the new registry's ticket #1 cannot alias the old #1.
 *   • generation bump: onGameStarted calls vault.newEpoch(), retiring the
 *                      prior generation's abandoned tickets in one step.
 *
 * Run: forge test --match-contract YieldVaultEpochTest -vvv
 */
contract StrayToken is ERC20 {
    constructor() ERC20("STRAY", "STRAY") { _mint(msg.sender, 1 ether); }
}

contract YieldVaultEpochTest is Test {
    TimbYieldVault vault;
    address registryA = address(0xA1);
    address registryB = address(0xB2);

    function setUp() public {
        vault = new TimbYieldVault();
        vault.setGameRegistry(registryA);
        vault.setTimbPrize(address(this));      // we harvest
        vault.setYieldAPRBps(1000);             // 10% APR
        vault.fund{value: 5 ether}();
    }

    function _accruedOverYear() internal returns (uint256) {
        vm.warp(block.timestamp + 365 days);
        return vault.harvest();
    }

    receive() external payable {}

    // Stale weight from a retired registry stops accruing the moment the
    // registry is swapped, and the new registry's same-numbered ticket does
    // not collide with it.
    function test_TS014_RegistrySwapRetiresWeight() public {
        vm.prank(registryA);
        vault.register(1, address(0), 1 ether);
        assertEq(vault.totalWeight(), 1 ether);

        // Old registry can no longer remove (it is not the registry) — exactly
        // the reclaimFromPastGame path that used to strand weight.
        vault.setGameRegistry(registryB);
        vm.prank(registryA);
        vm.expectRevert(TimbYieldVault.NotGameRegistry.selector);
        vault.remove(1);

        // ...but the weight is already retired: nothing accrues on it.
        assertEq(vault.totalWeight(), 0, "swap retires weight");
        assertEq(vault.weightOf(1), 0, "old #1 invisible in new epoch");
        assertEq(_accruedOverYear(), 0, "no yield drawn for dead ticket");

        // New registry's ticket #1 registers fresh — no alias, no skipped weight.
        vm.prank(registryB);
        vault.register(1, address(0), 2 ether);
        assertEq(vault.weightOf(1), 2 ether);
        assertEq(vault.totalWeight(), 2 ether);
        assertGt(_accruedOverYear(), 0, "live ticket still earns");
    }

    // Accrual up to the epoch boundary is kept; only the future is cut off.
    function test_TS014_NewEpochAccruesThenRetires() public {
        vm.prank(registryA);
        vault.register(7, address(0), 1 ether);
        vm.warp(block.timestamp + 100 days);
        uint256 before = vault.previewAccrued();
        assertGt(before, 0);

        vm.prank(registryA);
        vault.newEpoch();
        assertEq(vault.epoch(), 1);
        assertEq(vault.totalWeight(), 0);
        assertEq(vault.previewAccrued(), before, "accrued-so-far kept");

        vm.warp(block.timestamp + 100 days);
        assertEq(vault.previewAccrued(), before, "nothing more after the epoch");
    }

    // Only the registry or the owner may start an epoch.
    function test_TS014_NewEpochGated() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(TimbYieldVault.NotGameRegistry.selector);
        vault.newEpoch();
        vault.newEpoch(); // owner ok
        assertEq(vault.epoch(), 1);
    }

    // The registry retires the vault's weight when a new generation starts.
    function test_TS014_GenerationBumpStartsEpoch() public {
        MockTIMBS timbs = new MockTIMBS();
        address prize = address(0xB1DE);
        GameRegistry reg = new GameRegistry(address(timbs), address(this), prize, 1 ether, 1 ether);
        RecordingVault rv = new RecordingVault();
        reg.setYieldVault(address(rv));

        uint256 g0 = reg.generation();
        vm.prank(prize);
        reg.onGameStarted();   // first game
        vm.prank(prize);
        reg.onGameStarted();   // generation bump
        assertEq(reg.generation(), g0 + 1, "second start bumps the generation");
        assertEq(rv.epochs(), 2, "each game start retires the prior weight");
    }

    // ─── Stray ERC-20 recovery (fix-list 61) ──────────────────────────────────

    function test_recoverERC20_sweepsStrayToken_leavesEthReserveAlone() public {
        StrayToken tok = new StrayToken();
        tok.transfer(address(vault), 1 ether);           // the WETH-by-mistake case
        uint256 reserveBefore = vault.reserve();
        address sink = address(0x5EEF);
        vault.recoverERC20(address(tok), sink, 1 ether);
        assertEq(tok.balanceOf(sink), 1 ether, "stray token swept");
        assertEq(tok.balanceOf(address(vault)), 0, "nothing left");
        assertEq(vault.reserve(), reserveBefore, "ETH reserve untouched");
        assertEq(address(vault).balance, 5 ether, "ETH balance untouched");
    }

    function test_recoverERC20_ownerOnlyAndChecked() public {
        StrayToken tok = new StrayToken();
        tok.transfer(address(vault), 1 ether);
        vm.prank(address(0xBAD));
        vm.expectRevert();
        vault.recoverERC20(address(tok), address(0xBAD), 1 ether);
        vm.expectRevert(TimbYieldVault.ZeroAddress.selector);
        vault.recoverERC20(address(tok), address(0), 1 ether);
        vm.expectRevert(TimbYieldVault.ZeroAmount.selector);
        vault.recoverERC20(address(tok), address(0x5EEF), 0);
        vm.expectRevert();                                 // more than held: SafeERC20 bubbles the revert
        vault.recoverERC20(address(tok), address(0x5EEF), 2 ether);
    }
}
