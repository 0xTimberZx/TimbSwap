// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../contracts/PrizeEscrow.sol";
import "../contracts/TimbPrize.sol";
import "../contracts/VRFEntropy.sol";
import {MockPrizeVRF} from "./PrizeWindows.t.sol";

/// A registry stand-in whose candidate list and verification answers are
/// scripted per wallet. The answers are relative to the round's winning
/// string, read from the prize: when settlement verifies candidates, all six
/// segment chars are locked, so getCurrentWindow() is the winning string.
contract ScriptedRegistry {
    enum Mode { NotExisted, ExistedWrongString, NotValid, ValidWrongString, Match }

    TimbPrize public prize;
    address[] public candidates;
    mapping(address => Mode) public mode;
    address[] public recorded;
    uint256 public currentRound;

    bytes6 constant OTHER = bytes6("000000"); // digits: never a letter-class winning string

    function setPrize(TimbPrize p) external { prize = p; }
    function add(address who, Mode m) external { candidates.push(who); mode[who] = m; }

    function getStringEntrants(uint256, bytes6) external view returns (address[] memory) { return candidates; }
    function roundEntrantsLength(uint256) external view returns (uint256) { return candidates.length; }
    function allowRepeatedChars() external pure returns (bool) { return false; }

    // A "no" answer still carries the winning string, so the prize must check
    // each layer's flag on its own, not rely on the string comparison.
    function verifyEntryExisted(address who, uint256) external view returns (bool, bytes6) {
        Mode m = mode[who];
        if (m == Mode.NotExisted) return (false, prize.getCurrentWindow());
        if (m == Mode.ExistedWrongString) return (true, OTHER);
        return (true, prize.getCurrentWindow());
    }

    function verifyEntryValid(address who, uint256) external view returns (bool, bytes6) {
        Mode m = mode[who];
        if (m == Mode.NotValid) return (false, prize.getCurrentWindow());
        if (m == Mode.ValidWrongString) return (true, OTHER);
        return (true, prize.getCurrentWindow());
    }

    function recordWinners(uint256, address[] calldata w) external {
        for (uint256 i = 0; i < w.length; i++) recorded.push(w[i]);
    }
    function recordedLength() external view returns (uint256) { return recorded.length; }
    function activateRoundEntries(uint256, address[] calldata) external {}
    function setCurrentRound(uint256 r) external { currentRound = r; }
    function onGameStarted() external { currentRound = 1; }
}

contract RevertingHarvestVault {
    function harvest() external pure returns (uint256) { revert("vault down"); }
}

contract StrayToken is ERC20 {
    constructor() ERC20("WETH", "WETH") { _mint(msg.sender, 1e24); }
}

/**
 * Branch coverage for TimbPrize: the dual-layer winner filter (who gets paid),
 * pot funding and the protocol cut, the yield-harvest fence, the lazy
 * settlement in nudgeScroll (an armed segment's class stays frozen), the
 * settlement pause, and the config guards. Payouts are checked end to end
 * through PrizeEscrow. Tests only; no contract change.
 *
 * The test contract is the owner and the router.
 */
contract TimbPrizeMoneyPathsTest is Test {
    PrizeEscrow      escrow;
    ScriptedRegistry registry;
    TimbPrize        prize;
    MockPrizeVRF     coord;
    VRFEntropy       entropy;

    address constant W1 = address(0x1001);
    address constant W2 = address(0x1002);
    address constant NE = address(0x2001); // not existed
    address constant EW = address(0x2002); // existed, other string
    address constant NV = address(0x2003); // not valid
    address constant VW = address(0x2004); // valid, other string

    function setUp() public {
        escrow   = new PrizeEscrow();
        registry = new ScriptedRegistry();
        prize    = new TimbPrize(address(escrow), address(registry), address(this));
        registry.setPrize(prize);
        coord   = new MockPrizeVRF();
        entropy = new VRFEntropy(address(coord), bytes32(uint256(0xABC)), 42, 3, 200_000, hex"1234");
        entropy.setBoard(address(prize));
        prize.setEntropy(address(entropy));
        escrow.setTimbPrize(address(prize));
        prize.startGame();
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    function _settleOneSegment() internal {
        uint256 r = prize.currentRound();
        uint256 s = prize.currentSegment();
        vm.warp(prize.segmentStartTime() + prize.INTERACTION_WINDOW() + 1);
        prize.settleSegment();                                   // arm
        (uint256 reqId,,, bool ready) = entropy.draws(prize.saltFor(r, s));
        if (!ready) coord.fulfil(address(entropy), reqId, uint256(keccak256(abi.encode(r, s))));
        prize.settleSegment();                                   // lock (+ settle on segment 6)
    }

    function _settleRound() internal {
        uint256 r = prize.currentRound();
        while (prize.currentRound() == r) _settleOneSegment();
    }

    // ─── Winner filter ──────────────────────────────────────────────────────

    /// Only candidates that pass both layers with the winning string are paid,
    /// and a wallet listed twice is counted once.
    function test_WinnerFilter_PaysOnlyFullyVerifiedWalletsOnce() public {
        registry.add(NE, ScriptedRegistry.Mode.NotExisted);
        registry.add(W1, ScriptedRegistry.Mode.Match);
        registry.add(EW, ScriptedRegistry.Mode.ExistedWrongString);
        registry.add(NV, ScriptedRegistry.Mode.NotValid);
        registry.add(W1, ScriptedRegistry.Mode.Match);            // listed twice
        registry.add(VW, ScriptedRegistry.Mode.ValidWrongString);
        registry.add(W2, ScriptedRegistry.Mode.Match);

        prize.fundPot{value: 1 ether}();
        _settleRound();

        (, uint256 pot, address[] memory winners, uint256 perWinner, uint256 remainder) = prize.getRoundResult(1);
        assertEq(winners.length, 2, "two verified winners");
        assertEq(winners[0], W1);
        assertEq(winners[1], W2);
        assertEq(registry.recordedLength(), 2, "registry told the same two");
        assertEq(pot, 0.98 ether, "2% protocol cut taken");
        assertEq(perWinner, 0.49 ether);
        assertEq(remainder, 0);
        assertEq(prize.protocolCutAccrued(), 0.02 ether);
        assertEq(prize.gameUnclaimed_winningsPool(), 0.98 ether);

        vm.prank(W1); prize.claimWinnings(1);
        vm.prank(W2); prize.claimWinnings(1);
        assertEq(W1.balance, 0.49 ether);
        assertEq(W2.balance, 0.49 ether);

        address[4] memory losers = [NE, EW, NV, VW];
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(losers[i]);
            vm.expectRevert(abi.encodeWithSelector(TimbPrize.NotAWinner.selector, losers[i], 1));
            prize.claimWinnings(1);
        }
        assertEq(address(escrow).balance, 0.02 ether, "only the protocol cut remains");

        address rev = address(0xCAFE);
        prize.withdrawProtocolCut(rev);
        assertEq(rev.balance, 0.02 ether);
        assertEq(address(escrow).balance, 0, "escrow fully accounted");
        assertEq(prize.protocolCutAccrued(), 0, "cut cannot be withdrawn twice");
        vm.expectRevert(TimbPrize.ZeroAmount.selector);
        prize.withdrawProtocolCut(rev);
    }

    /// No verified winner: the whole post-cut pot rolls to the next round.
    function test_WinnerFilter_NoVerifiedWinnerCarriesThePot() public {
        registry.add(NV, ScriptedRegistry.Mode.NotValid);
        prize.fundPot{value: 1 ether}();
        _settleRound();
        (,, address[] memory winners,, uint256 remainder) = prize.getRoundResult(1);
        assertEq(winners.length, 0);
        assertEq(remainder, 0.98 ether);
        assertEq(prize.currentAccumulatedRewards(), 0.98 ether, "carried");
        assertEq(registry.recordedLength(), 0, "recordWinners not called");
    }

    // ─── Pot funding, cut, harvest ──────────────────────────────────────────

    function test_PotFunding_RejectsZero() public {
        vm.expectRevert(TimbPrize.ZeroAmount.selector);
        prize.fundPot{value: 0}();
        vm.expectRevert(TimbPrize.ZeroAmount.selector);
        prize.addToPot{value: 0}();

        vm.deal(W1, 1 ether);
        vm.prank(W1);
        prize.addToPot{value: 0.1 ether}();
        assertEq(prize.currentAccumulatedRewards(), 0.1 ether);
        assertEq(address(escrow).balance, 0.1 ether, "held in escrow, not the prize");
        assertEq(address(prize).balance, 0);
    }

    function test_ProtocolCut_Guards() public {
        vm.expectRevert(TimbPrize.ZeroAddress.selector);
        prize.withdrawProtocolCut(address(0));
        vm.expectRevert(TimbPrize.ZeroAmount.selector);
        prize.withdrawProtocolCut(address(0xCAFE));
        vm.expectRevert(TimbPrize.ZeroAmount.selector);
        prize.setProtocolCutBps(1001);
        prize.setProtocolCutBps(1000);
        assertEq(prize.protocolCutBps(), 1000, "10% is the ceiling");
    }

    function test_Receive_OnlyFromTheYieldVault() public {
        (bool ok,) = address(prize).call{value: 1}("");
        assertFalse(ok, "stray ETH refused");
    }

    function test_HarvestFailure_NeverBlocksSettlement() public {
        prize.setYieldVault(address(new RevertingHarvestVault()));
        prize.fundPot{value: 1 ether}();
        vm.recordLogs();
        _settleRound();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool failedEmitted;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(prize)
                && logs[i].topics[0] == TimbPrize.YieldHarvestFailed.selector
                && uint256(logs[i].topics[1]) == 1) failedEmitted = true;
        }
        assertTrue(failedEmitted, "harvest failure surfaced");
        assertEq(prize.currentRound(), 2, "round settled despite the vault");
        assertEq(prize.currentAccumulatedRewards(), 0.98 ether, "pot unchanged apart from the cut");
    }

    function test_RecoverERC20_GuardsAndSweep() public {
        StrayToken t = new StrayToken();
        t.transfer(address(prize), 5e18);
        vm.expectRevert(TimbPrize.ZeroAddress.selector);
        prize.recoverERC20(address(0), W1, 1);
        vm.expectRevert(TimbPrize.ZeroAddress.selector);
        prize.recoverERC20(address(t), address(0), 1);
        vm.expectRevert(TimbPrize.ZeroAmount.selector);
        prize.recoverERC20(address(t), W1, 0);
        prize.recoverERC20(address(t), W1, 5e18);
        assertEq(t.balanceOf(W1), 5e18);
    }

    // ─── Lazy settlement and pauses ─────────────────────────────────────────

    /// A nudge after the window arms the segment and stops: while the VRF word
    /// is pending, nudges change nothing (the class is frozen). Once the word
    /// lands, the next nudge locks, advances and then counts.
    function test_LazySettle_ArmedSegmentIgnoresNudgesUntilLocked() public {
        uint256 pos = prize.positionCounter();
        vm.warp(prize.segmentStartTime() + prize.INTERACTION_WINDOW() + 1);

        prize.nudgeScroll();                                     // arms only
        bytes32 salt = prize.saltFor(1, 1);
        assertTrue(entropy.isRequested(salt));
        assertEq(prize.positionCounter(), pos, "no nudge while arming");

        prize.nudgeScroll();                                     // word pending
        assertEq(prize.positionCounter(), pos, "no nudge while awaiting VRF");
        assertEq(prize.currentSegment(), 1);

        (uint256 reqId,,,) = entropy.draws(salt);
        coord.fulfil(address(entropy), reqId, 123);
        prize.nudgeScroll();                                     // lock, advance, nudge
        assertEq(prize.currentSegment(), 2);
        assertEq(prize.positionCounter(), pos + 1, "nudge lands on the new segment");
        assertTrue(prize.getSegmentDigit(1) != 0x00, "segment 1 locked");
        assertEq(prize.getSegmentDigit(3), bytes1(0x00), "future segment blank");
    }

    function test_SettlementPause_BlocksBothPaths() public {
        prize.pauseSettlement();
        vm.warp(prize.segmentStartTime() + prize.INTERACTION_WINDOW() + 1);
        vm.expectRevert(TimbPrize.InSettlementWindow.selector);
        prize.nudgeScroll();
        vm.expectRevert(TimbPrize.SettlementPaused.selector);
        prize.settleSegment();
        assertEq(prize.timeRemainingInSegment(), 0);

        prize.unpauseSettlement();
        prize.settleSegment();
        assertTrue(entropy.isRequested(prize.saltFor(1, 1)), "settles once unpaused");
    }

    function test_Settle_RefusedInsideTheWindow() public {
        vm.expectRevert();
        prize.settleSegment();
        assertGt(prize.timeRemainingInSegment(), 0);
    }

    // ─── Lifecycle and config guards ────────────────────────────────────────

    function test_Nudge_OnlyRouterAndOnlyOnceStarted() public {
        vm.prank(W1);
        vm.expectRevert(TimbPrize.NotRouter.selector);
        prize.nudgeScroll();

        TimbPrize fresh = new TimbPrize(address(escrow), address(registry), address(this));
        vm.expectRevert(TimbPrize.GameNotStarted.selector);
        fresh.nudgeScroll();
        assertFalse(fresh.isSettlementWindow(), "no window before start");
        vm.expectRevert(TimbPrize.EntropyNotSet.selector);
        fresh.startGame();
        vm.expectRevert(TimbPrize.GameAlreadyStarted.selector);
        prize.startGame();
    }

    function test_Config_RejectsZeroAddresses() public {
        vm.expectRevert(TimbPrize.ZeroAddress.selector);
        new TimbPrize(address(0), address(registry), address(this));
        vm.expectRevert(TimbPrize.ZeroAddress.selector);
        new TimbPrize(address(escrow), address(0), address(this));
        vm.expectRevert(TimbPrize.ZeroAddress.selector);
        new TimbPrize(address(escrow), address(registry), address(0));
        vm.expectRevert(TimbPrize.ZeroAddress.selector);
        prize.setSettler(address(0));
        vm.expectRevert(TimbPrize.ZeroAddress.selector);
        prize.setRouter(address(0));
        vm.expectRevert(TimbPrize.ZeroAddress.selector);
        prize.setGameRegistry(address(0));
        vm.expectRevert(TimbPrize.ZeroAddress.selector);
        prize.setEntropy(address(0));
        vm.expectRevert(TimbPrize.ZeroAddress.selector);
        prize.setPrizeEscrow(address(0));
    }
}
