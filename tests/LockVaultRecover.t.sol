// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/TimbLockVault.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract VaultMockToken is ERC20 {
    constructor(string memory n) ERC20(n, n) {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// Takes 1% of every transfer, so the vault receives less than `amount`.
contract VaultFeeToken is ERC20 {
    constructor() ERC20("FEE", "FEE") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xFEE), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// TS-061: tokens sent to the vault without lock() had no exit. The owner
/// can now recover them, bounded by the per-token locked principal.
contract LockVaultRecoverTest is Test {
    TimbLockVault vault;
    VaultMockToken timbs;
    VaultMockToken weth;
    address alice = address(0xA11CE);
    address bob   = address(0xB0B);
    address rescue = address(0x5AFE);
    uint256 constant DAY = 1 days;

    function setUp() public {
        timbs = new VaultMockToken("TIMBS");
        weth  = new VaultMockToken("WETH");
        vault = new TimbLockVault(address(timbs));
        vault.addToWhitelist(address(weth));
        weth.mint(alice, 100 ether);
        weth.mint(bob, 100 ether);
        vm.prank(alice); weth.approve(address(vault), type(uint256).max);
        vm.prank(bob);   weth.approve(address(vault), type(uint256).max);
    }

    function test_TS061_StrayTransferRecoverable() public {
        vm.prank(alice);
        vault.lock(address(weth), 10 ether, DAY);
        vm.prank(bob);
        weth.transfer(address(vault), 50 ether); // the mistaken transfer

        vault.recoverERC20(address(weth), rescue, 50 ether);
        assertEq(weth.balanceOf(rescue), 50 ether, "stray returned");
        assertEq(weth.balanceOf(address(vault)), 10 ether, "lock untouched");
    }

    function test_TS061_LockedPrincipalUnreachable() public {
        vm.prank(alice);
        vault.lock(address(weth), 10 ether, DAY);
        vm.prank(bob);
        vault.lock(address(weth), 20 ether, DAY);
        assertEq(vault.totalLocked(address(weth)), 30 ether);

        vm.expectRevert(abi.encodeWithSelector(TimbLockVault.ExceedsRecoverable.selector, 1, 0));
        vault.recoverERC20(address(weth), rescue, 1);

        vm.prank(alice);
        weth.transfer(address(vault), 5 ether);
        vm.expectRevert(abi.encodeWithSelector(TimbLockVault.ExceedsRecoverable.selector, 5 ether + 1, 5 ether));
        vault.recoverERC20(address(weth), rescue, 5 ether + 1);
        vault.recoverERC20(address(weth), rescue, 5 ether);

        // Both lockers still withdraw in full after the recovery.
        vm.warp(block.timestamp + DAY);
        vm.prank(alice); vault.withdraw(1);
        vm.prank(bob);   vault.withdraw(2);
        assertEq(weth.balanceOf(alice), 95 ether, "alice: 100 - 10 lock - 5 stray + 10 back");
        assertEq(weth.balanceOf(bob), 100 ether, "bob whole");
        assertEq(vault.totalLocked(address(weth)), 0, "nothing locked");
    }

    function test_TS061_WithdrawReleasesLockedTotal() public {
        vm.prank(alice);
        uint256 id = vault.lock(address(weth), 10 ether, DAY);
        vm.warp(block.timestamp + DAY);
        vm.prank(alice);
        vault.withdraw(id);
        assertEq(vault.totalLocked(address(weth)), 0);
    }

    /// Fee-on-transfer: the locked total is what the vault actually got.
    function test_TS061_FeeTokenTracksReceivedAmount() public {
        VaultFeeToken fee = new VaultFeeToken();
        vault.addToWhitelist(address(fee));
        fee.mint(alice, 100 ether);
        vm.startPrank(alice);
        fee.approve(address(vault), type(uint256).max);
        vault.lock(address(fee), 10 ether, DAY);
        vm.stopPrank();
        assertEq(vault.totalLocked(address(fee)), 9.9 ether, "received, not sent");
        assertEq(fee.balanceOf(address(vault)), 9.9 ether);
        vm.expectRevert(abi.encodeWithSelector(TimbLockVault.ExceedsRecoverable.selector, 1, 0));
        vault.recoverERC20(address(fee), rescue, 1);
    }

    /// Any token, whitelisted or not, can be recovered when nothing is locked.
    function test_TS061_UnlistedTokenRecoverable() public {
        VaultMockToken junk = new VaultMockToken("JUNK");
        junk.mint(address(vault), 3 ether);
        vault.recoverERC20(address(junk), rescue, 3 ether);
        assertEq(junk.balanceOf(rescue), 3 ether);
    }

    function test_TS061_OwnerOnlyAndArgs() public {
        weth.mint(address(vault), 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.recoverERC20(address(weth), alice, 1 ether);
        vm.expectRevert(TimbLockVault.ZeroAddress.selector);
        vault.recoverERC20(address(weth), address(0), 1 ether);
        vm.expectRevert(TimbLockVault.ZeroAmount.selector);
        vault.recoverERC20(address(weth), rescue, 0);
    }
}
