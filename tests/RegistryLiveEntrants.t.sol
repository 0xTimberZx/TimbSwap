// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../contracts/GameRegistry.sol";

contract RLEToken is ERC20 {
    constructor() ERC20("T", "T") {}
}

/// The live-entrant count sizes the router's public free-nudge pool
/// (FREE_NUDGE_POOL_SPEC). It must count each wallet with a live ticket once
/// per round, and drop on cancel and concede so churn can't inflate it.
contract RegistryLiveEntrantsTest is Test {
    GameRegistry reg;
    bytes6 constant S  = bytes6("ABC123");
    bytes6 constant S2 = bytes6("DEF456");
    uint256 constant FLOOR = 0.001 ether;

    function setUp() public {
        // timbPrize = this, so the test can move the round.
        reg = new GameRegistry(address(new RLEToken()), address(0xFEE), address(this), 2e18, 1e18);
    }

    function _enter(address who, bytes6 s, uint256 extra) internal {
        vm.deal(who, 1 ether);
        vm.prank(who);
        reg.submitEntry{value: FLOOR}(s, true, extra);
    }

    function test_MintCountsEachRoundOfTheRun() public {
        address a = makeAddr("a");
        _enter(a, S, 2); // plays rounds 1..3
        assertEq(reg.liveEntrantCount(1), 1);
        assertEq(reg.liveEntrantCount(2), 1);
        assertEq(reg.liveEntrantCount(3), 1);
        assertEq(reg.liveEntrantCount(4), 0, "nothing past the run");
        assertEq(reg.liveEntrantCount(0), 0, "nothing before the play round");
    }

    function test_DistinctWalletsAdd() public {
        _enter(makeAddr("a"), S, 0);
        _enter(makeAddr("b"), S2, 0);
        _enter(makeAddr("c"), S, 0);
        assertEq(reg.liveEntrantCount(1), 3);
    }

    function test_CancelDropsTheCount() public {
        address a = makeAddr("a");
        _enter(a, S, 3);
        vm.prank(a);
        reg.cancelEntry();
        for (uint256 r = 1; r <= 4; r++) assertEq(reg.liveEntrantCount(r), 0, "cancelled: not live");
        // The append-only list still holds the wallet, which is why the pool
        // must not be sized from it.
        assertEq(reg.roundEntrantsLength(1), 1, "roundEntrants is append-only");
    }

    function test_SybilMintCancelChurnDoesNotInflate() public {
        for (uint256 i = 0; i < 25; i++) {
            address w = makeAddr(string(abi.encodePacked("sybil", i)));
            _enter(w, S, 0);
            vm.prank(w);
            reg.cancelEntry();
        }
        assertEq(reg.liveEntrantCount(1), 0, "refunded churn adds nothing");
        _enter(makeAddr("real"), S, 0);
        assertEq(reg.liveEntrantCount(1), 1);
    }

    function test_SameWalletRemintAfterCancelCountsOnce() public {
        address a = makeAddr("a");
        _enter(a, S, 0);
        vm.prank(a);
        reg.cancelEntry();
        _enter(a, S2, 0);
        assertEq(reg.liveEntrantCount(1), 1);
    }

    function test_ReplaceBeforePlayCountsWalletOnce() public {
        address a = makeAddr("a");
        _enter(a, S, 1); // rounds 1..2
        vm.prank(a);
        reg.replaceEntry(S2, 0); // new ticket plays round 1 only
        assertEq(reg.liveEntrantCount(1), 1, "one wallet, one count");
        assertEq(reg.liveEntrantCount(2), 0, "conceded run dropped");
    }

    function test_ReplaceInPlayMovesTheCountToTheNewRun() public {
        address a = makeAddr("a");
        _enter(a, S, 0);    // plays round 1
        reg.setCurrentRound(1); // ticket now in play
        vm.prank(a);
        reg.replaceEntry(S2, 0); // concedes the round-1 ticket; new one plays round 2
        assertEq(reg.liveEntrantCount(1), 0, "conceded: no longer live this round");
        assertEq(reg.liveEntrantCount(2), 1, "replacement counted for its round");
        (bool valid,) = reg.verifyEntryValid(a, 1);
        assertFalse(valid, "count and validity agree");
    }
}
