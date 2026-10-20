// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../contracts/EligibleTokenRegistry.sol";

/**
 * @title EligibleTokenRegistry — token list, consumers, views, owner gating
 */
contract EligibleTokenRegistryTest is Test {
    EligibleTokenRegistry reg;

    address constant T1 = address(0x7101);
    address constant T2 = address(0x7102);
    address constant T3 = address(0x7103);
    address constant STRANGER = address(0x5747);

    function setUp() public {
        address[] memory init = new address[](3);
        init[0] = T1;
        init[1] = address(0); // skipped, not a revert
        init[2] = T2;
        reg = new EligibleTokenRegistry(init);
    }

    function test_ConstructorSkipsZeroAddress() public view {
        assertTrue(reg.isEligible(T1));
        assertTrue(reg.isEligible(T2));
        assertFalse(reg.isEligible(address(0)));
        assertEq(reg.totalTokensAdded(), 2);
    }

    function test_AddToken() public {
        reg.addToken(T3);
        assertTrue(reg.isEligible(T3));
        assertEq(reg.eligibleTokenList(2), T3);
    }

    function test_AddTokenRejectsZeroAndDuplicate() public {
        vm.expectRevert(EligibleTokenRegistry.ZeroAddress.selector);
        reg.addToken(address(0));
        vm.expectRevert(abi.encodeWithSelector(EligibleTokenRegistry.AlreadyEligible.selector, T1));
        reg.addToken(T1);
    }

    function test_AddTokensSkipsAlreadyEligible() public {
        address[] memory ts = new address[](2);
        ts[0] = T1; // already eligible: skipped, not duplicated
        ts[1] = T3;
        reg.addTokens(ts);
        assertEq(reg.totalTokensAdded(), 3);
        assertTrue(reg.isEligible(T3));
    }

    function test_AddTokensRejectsZero() public {
        address[] memory ts = new address[](2);
        ts[0] = T3;
        ts[1] = address(0);
        vm.expectRevert(EligibleTokenRegistry.ZeroAddress.selector);
        reg.addTokens(ts);
    }

    function test_RemoveTokenKeepsHistory() public {
        reg.removeToken(T1);
        assertFalse(reg.isEligible(T1));
        assertEq(reg.totalTokensAdded(), 2, "history kept");
        address[] memory live = reg.getEligibleTokens();
        assertEq(live.length, 1);
        assertEq(live[0], T2);
    }

    function test_RemoveTokenRejectsZeroAndIneligible() public {
        vm.expectRevert(EligibleTokenRegistry.ZeroAddress.selector);
        reg.removeToken(address(0));
        vm.expectRevert(abi.encodeWithSelector(EligibleTokenRegistry.NotEligible.selector, T3));
        reg.removeToken(T3);
    }

    /// A removed token can be re-added; it appears in the history twice but
    /// in the live list once.
    function test_ReAddAfterRemove() public {
        reg.removeToken(T1);
        reg.addToken(T1);
        assertTrue(reg.isEligible(T1));
        assertEq(reg.totalTokensAdded(), 3);
        // getEligibleTokens counts by isEligible over the history, so a re-added
        // token shows up once per history entry.
        address[] memory live = reg.getEligibleTokens();
        assertEq(live.length, 3);
    }

    function test_AreEligible() public {
        reg.removeToken(T2);
        address[] memory q = new address[](3);
        q[0] = T1; q[1] = T2; q[2] = T3;
        bool[] memory r = reg.areEligible(q);
        assertTrue(r[0]);
        assertFalse(r[1]);
        assertFalse(r[2]);
    }

    function test_ConsumerRegistry() public {
        reg.registerConsumer(address(0xC0));
        assertTrue(reg.registeredConsumers(address(0xC0)));
        assertEq(reg.getConsumers().length, 1);

        vm.expectRevert(EligibleTokenRegistry.ZeroAddress.selector);
        reg.registerConsumer(address(0));
        vm.expectRevert(abi.encodeWithSelector(EligibleTokenRegistry.AlreadyRegistered.selector, address(0xC0)));
        reg.registerConsumer(address(0xC0));

        reg.removeConsumer(address(0xC0));
        assertFalse(reg.registeredConsumers(address(0xC0)));
        vm.expectRevert(abi.encodeWithSelector(EligibleTokenRegistry.NotRegistered.selector, address(0xC0)));
        reg.removeConsumer(address(0xC0));
    }

    function test_WritesAreOwnerOnly() public {
        address[] memory ts = new address[](1);
        ts[0] = T3;
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, STRANGER);
        vm.startPrank(STRANGER);
        vm.expectRevert(err); reg.addToken(T3);
        vm.expectRevert(err); reg.addTokens(ts);
        vm.expectRevert(err); reg.removeToken(T1);
        vm.expectRevert(err); reg.registerConsumer(address(0xC0));
        vm.expectRevert(err); reg.removeConsumer(address(0xC0));
        vm.stopPrank();
    }
}
