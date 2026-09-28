// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../contracts/GameRegistry.sol";

contract MockTimbsBeta is ERC20 {
    constructor() ERC20("TIMBS", "TIMBS") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/**
 * @title GameRegistry — capped-beta switches (dev-docs/BETA_ETH_ONLY.md §3)
 * @notice timbsEntryEnabled (default off), extraRoundCostTimbs (default 0) and
 *         maxExtraRounds (default 6, capped by MAX_EXTRA_ROUNDS).
 */
contract GameRegistryBetaSwitchesTest is Test {
    MockTimbsBeta timbs;
    GameRegistry reg;

    address constant SINK   = address(0xFEE);
    address constant PLAYER = address(0xA11CE);
    bytes6  constant S1     = bytes6("ABC123");
    bytes6  constant S2     = bytes6("DEF456");
    uint256 constant ETH_FLOOR = 0.001 ether;

    function setUp() public {
        timbs = new MockTimbsBeta();
        reg = new GameRegistry(address(timbs), SINK, address(this), 2e18, 1e18);
        vm.deal(PLAYER, 1 ether);
    }

    function _ethEntry(uint256 extra) internal returns (uint256 id) {
        vm.prank(PLAYER);
        reg.submitEntry{value: ETH_FLOOR}(S1, true, extra);
        id = reg.activeTicketOf(PLAYER);
    }

    function test_DefaultsAreBetaValues() public view {
        assertFalse(reg.timbsEntryEnabled());
        assertEq(reg.extraRoundCostTimbs(), 0);
        assertEq(reg.maxExtraRounds(), 6);
    }

    function test_TimbsEntryRevertsWhileDisabled() public {
        timbs.mint(PLAYER, 100e18);
        vm.startPrank(PLAYER);
        timbs.approve(address(reg), type(uint256).max);
        vm.expectRevert(GameRegistry.TimbsEntryDisabled.selector);
        reg.submitEntry(S1, false, 0);
        vm.stopPrank();
        assertEq(timbs.balanceOf(address(reg)), 0);
    }

    function test_TimbsEntryWorksOnceEnabled() public {
        reg.setTimbsEntryEnabled(true);
        timbs.mint(PLAYER, 100e18);
        vm.startPrank(PLAYER);
        timbs.approve(address(reg), type(uint256).max);
        reg.submitEntry(S1, false, 0);
        vm.stopPrank();
        assertEq(timbs.balanceOf(address(reg)), 2e18, "floor escrowed");
    }

    function test_FreeExtraRoundsUpToSix_NoTimbsNeeded() public {
        uint256 id = _ethEntry(6);
        (GameRegistry.Ticket memory t,) = reg.getTicket(id);
        assertEq(t.lastEligibleRound, t.playRound + 6, "six extra rounds granted");
        assertEq(timbs.balanceOf(SINK), 0, "nothing sunk");
    }

    function test_SevenExtraRoundsRevertAtBetaCap() public {
        vm.prank(PLAYER);
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.TooManyExtraRounds.selector, 7, 6));
        reg.submitEntry{value: ETH_FLOOR}(S1, true, 7);
    }

    function test_ReplaceEntry_FreeExtraRounds() public {
        _ethEntry(0);
        vm.prank(PLAYER);
        reg.replaceEntry(S2, 6);
        (GameRegistry.Ticket memory t,) = reg.getTicket(reg.activeTicketOf(PLAYER));
        assertEq(t.lastEligibleRound, t.playRound + 6);
    }

    function test_PricedExtraRoundsSinkTimbs() public {
        reg.setExtraRoundCostTimbs(5e18);
        timbs.mint(PLAYER, 100e18);
        vm.prank(PLAYER);
        timbs.approve(address(reg), type(uint256).max);
        _ethEntry(3);
        assertEq(timbs.balanceOf(SINK), 15e18, "3 x 5 TIMBS sunk");
    }

    function test_SetMaxExtraRoundsBounded() public {
        reg.setMaxExtraRounds(12);
        assertEq(reg.maxExtraRounds(), 12);
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.TooManyExtraRounds.selector, 13, 12));
        reg.setMaxExtraRounds(13);
    }

    function test_SettersAreOwnerOnly() public {
        vm.startPrank(PLAYER);
        vm.expectRevert();
        reg.setTimbsEntryEnabled(true);
        vm.expectRevert();
        reg.setExtraRoundCostTimbs(1);
        vm.expectRevert();
        reg.setMaxExtraRounds(1);
        vm.stopPrank();
    }

    // ── Same-string entrant cap (bounds TimbPrize._findVerifiedWinners) ──

    function test_StringFullAtCap() public {
        reg.setMaxEntrantsPerString(3);
        for (uint160 i = 1; i <= 3; i++) {
            address w = address(0x1000 + i);
            vm.deal(w, 1 ether);
            vm.prank(w);
            reg.submitEntry{value: ETH_FLOOR}(S1, true, 0);
        }
        address late = address(0x2000);
        vm.deal(late, 1 ether);
        uint256 nextRound = reg.currentRound() + 1; // read before prank (a call would consume it)
        vm.prank(late);
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.StringFull.selector, S1, nextRound));
        reg.submitEntry{value: ETH_FLOOR}(S1, true, 0);

        // Other strings are unaffected.
        vm.prank(late);
        reg.submitEntry{value: ETH_FLOOR}(S2, true, 0);
    }

    function test_EntrantCapBounds() public {
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.InvalidEntrantCap.selector, 0));
        reg.setMaxEntrantsPerString(0);
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.InvalidEntrantCap.selector, 501));
        reg.setMaxEntrantsPerString(501);
        assertEq(reg.maxEntrantsPerString(), 100, "default");
    }
}
