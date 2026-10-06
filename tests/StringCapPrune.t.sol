// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../contracts/GameRegistry.sol";

contract SCPToken is ERC20 {
    constructor() ERC20("T", "T") {}
}

/// TS-039: a mint-and-cancel loop must not fill `maxEntrantsPerString`.
contract StringCapPruneTest is Test {
    GameRegistry reg;
    bytes6 constant S  = bytes6("ABC123");
    bytes6 constant S2 = bytes6("DEF456");
    uint256 constant FLOOR = 0.001 ether;

    function setUp() public {
        reg = new GameRegistry(address(new SCPToken()), address(0xFEE), address(this), 2e18, 1e18);
    }

    function _enter(address who, bytes6 s) internal {
        vm.deal(who, 1 ether);
        vm.prank(who);
        reg.submitEntry{value: FLOOR}(s, true, 0);
    }

    function test_TS039_MintCancelLoopDoesNotFillCap() public {
        address attacker = makeAddr("attacker");
        uint256 cap = reg.maxEntrantsPerString();
        for (uint256 i = 0; i < cap; i++) {
            _enter(attacker, S);
            vm.prank(attacker);
            reg.cancelEntry();
        }
        assertEq(reg.getIdenticalCount(S), 0, "cancelled rows pruned");
        address victim = makeAddr("victim");
        _enter(victim, S);
        assertEq(reg.getIdenticalCount(S), 1, "victim seated");
    }

    function test_TS039_SybilMintCancelDoesNotFillCap() public {
        uint256 cap = reg.maxEntrantsPerString();
        for (uint256 i = 0; i < cap; i++) {
            address a = makeAddr(string(abi.encodePacked("sybil", i)));
            _enter(a, S);
            vm.prank(a);
            reg.cancelEntry();
        }
        _enter(makeAddr("victim"), S);
        assertEq(reg.getIdenticalCount(S), 1, "victim seated after sybil churn");
    }

    function test_TS039_ReplacePrunesOldStringRow() public {
        address a = makeAddr("a");
        address b = makeAddr("b");
        _enter(a, S);
        _enter(b, S);
        vm.prank(a);
        reg.replaceEntry(S2, 0);
        address[] memory row = reg.getStringEntrants(reg.currentRound() + 1, S);
        assertEq(row.length, 1, "conceded row pruned");
        assertEq(row[0], b, "swap-remove kept the other entrant");
        assertEq(reg.getIdenticalCount(S2), 1, "replacement seated on new string");
    }

    function test_CapStillBindsLiveEntries() public {
        uint256 cap = reg.maxEntrantsPerString();
        for (uint256 i = 0; i < cap; i++) {
            _enter(makeAddr(string(abi.encodePacked("live", i))), S);
        }
        address late = makeAddr("late");
        vm.deal(late, 1 ether);
        vm.prank(late);
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.StringFull.selector, S, 1));
        reg.submitEntry{value: FLOOR}(S, true, 0);
    }
}
