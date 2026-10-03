// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../contracts/GameRegistry.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockTimbsFG is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") { _mint(msg.sender, 1_000_000e18); }
}

/// TS-028: the first startGame keeps generation 1 (pre-start tickets stay
/// valid) and must therefore keep the pricing meters too.
contract FirstGameMetersTest is Test {
    MockTimbsFG timbs;
    GameRegistry registry;
    address sink = address(0xBEEF);
    address a = address(0xA1);
    address b = address(0xB2);
    address c = address(0xC3);
    uint256 constant ENTRY_ETH = 0.001 ether;

    function setUp() public {
        timbs = new MockTimbsFG();
        registry = new GameRegistry(address(timbs), sink, address(this), 2e18, 1e18);
        _fund(a); _fund(b); _fund(c);
    }

    function _fund(address who) internal { vm.deal(who, 1 ether); }

    function _enter(address who, bytes6 s) internal {
        vm.prank(who);
        registry.submitEntry{value: ENTRY_ETH}(s, true, 0);
    }

    function test_firstGameKeepsPreStartEscrowInMeter() public {
        _enter(a, bytes6("ABCDEF"));
        _enter(b, bytes6("GHIJKL"));
        assertEq(registry.totalEthEscrow(), 2 * ENTRY_ETH, "pre-start escrow metered");

        registry.onGameStarted();                   // first game, generation stays 1
        assertEq(registry.generation(), 1);
        assertEq(registry.totalEthEscrow(), 2 * ENTRY_ETH, "meter survives the first start");

        // A pre-start ticket leaving the game subtracts cleanly (no clamp).
        registry.adminMarkIneligible(registry.activeTicketOf(a));
        assertEq(registry.totalEthEscrow(), ENTRY_ETH, "exact subtraction");

        // A post-start entry adds on top of the surviving meter.
        _enter(c, bytes6("MNOPQR"));
        assertEq(registry.totalEthEscrow(), 2 * ENTRY_ETH);
    }

    function test_secondGameStillClearsMeters() public {
        _enter(a, bytes6("ABCDEF"));
        registry.onGameStarted();                   // gen 1
        assertEq(registry.totalEthEscrow(), ENTRY_ETH);
        registry.onGameStarted();                   // gen 2: prior seats retired
        assertEq(registry.generation(), 2);
        assertEq(registry.totalEthEscrow(), 0, "fresh generation clears the meter");
        assertEq(registry.activeTimbEntries(), 0);
        assertEq(registry.pricedForRound(), 0);
    }
}
