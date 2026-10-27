// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../contracts/GameRegistry.sol";

contract PausableLapseTIMBS is ERC20 {
    bool public paused;
    constructor() ERC20("TIMBS", "TIMBS") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
    function setPaused(bool p) external { paused = p; }
    function _update(address f, address t, uint256 v) internal override {
        require(!paused, "TransferPaused");
        super._update(f, t, v);
    }
}

contract OtherStray is ERC20 {
    constructor() ERC20("USDC", "USDC") { _mint(msg.sender, 1e30); }
}

/// A protocol sink that can be switched to refuse ETH.
contract SwitchableSink {
    bool public refuse;
    function setRefuse(bool r) external { refuse = r; }
    receive() external payable { require(!refuse, "refused"); }
}

/**
 * TS-076: a lapse whose transfer failed at the forfeiture sweep (TIMBS paused
 * or capped, or the sink refusing ETH) stayed on a ticket already marked
 * Ineligible, with no retry, and adminRefundStuck could only return it to the
 * player who forfeited it. Such a lapse is now marked pending and
 * retryLapse (permissionless) sends it to the sink; adminRefundStuck refuses it.
 *
 * TS-077: an ERC-20 sent to the registry by plain transfer had no exit. The
 * registry now tracks the TIMBS escrow it holds for tickets, and an owner
 * recoverERC20 reaches only the TIMBS above it (other tokens in full, never ETH).
 *
 * The test contract stands in as timbPrize (drives rounds, receives addToPot).
 */
contract RegistryLapseRetryTest is Test {
    PausableLapseTIMBS timbs;
    GameRegistry reg;

    address constant SINK    = address(0xFEE);
    address constant PLAYER  = address(0xB1);
    address constant PLAYER2 = address(0xB2);
    address constant PLAYER3 = address(0xB3);
    bytes6  constant S1      = bytes6("ABC123");

    function addToPot() external payable {}
    receive() external payable {}

    function setUp() public {
        timbs = new PausableLapseTIMBS();
        reg = new GameRegistry(address(timbs), SINK, address(this), 2e18, 1e18);
        reg.setTimbsEntryEnabled(true);
    }

    function _one(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    function _enterTimbs(address who) internal returns (uint256 id, uint256 stake) {
        timbs.mint(who, 100e18);
        vm.startPrank(who);
        timbs.approve(address(reg), type(uint256).max);
        reg.submitEntry(S1, false, 0); // plays round 1, LER 1, forfeit at 5
        vm.stopPrank();
        id = reg.activeTicketOf(who);
        (GameRegistry.Ticket memory t,) = reg.getTicket(id);
        stake = t.escrowAmount;
    }

    function _sweepRound5(address who) internal {
        reg.setCurrentRound(1);
        reg.activateRoundEntries(1, _one(who));
        reg.setCurrentRound(6);
        reg.onRoundSettled(5, 0);
    }

    function _escrowOf(uint256 id) internal view returns (uint256) {
        (GameRegistry.Ticket memory t,) = reg.getTicket(id);
        return t.escrowAmount;
    }

    // ─── TS-076 ─────────────────────────────────────────────────────────────

    /// The reported case: the sweep runs while TIMBS is paused. The lapse is
    /// now pending, a retry while still paused changes nothing, and after the
    /// pause anyone can send it to the sink.
    function test_TS076_PausedTimbsLapseRetriesToSink() public {
        (uint256 id, uint256 stake) = _enterTimbs(PLAYER);
        timbs.setPaused(true);
        _sweepRound5(PLAYER);
        timbs.setPaused(false);

        assertTrue(reg.lapsePending(id), "marked pending");
        assertEq(_escrowOf(id), stake, "stake still on the ticket");
        assertEq(timbs.balanceOf(SINK), 0, "sink got nothing yet");

        timbs.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.LapseRetryFailed.selector, id));
        reg.retryLapse(id);
        timbs.setPaused(false);
        assertTrue(reg.lapsePending(id), "a failed retry changes nothing");

        vm.prank(address(0xC0FFEE)); // permissionless
        reg.retryLapse(id);
        assertEq(timbs.balanceOf(SINK), stake, "lapse reached the sink");
        assertFalse(reg.lapsePending(id));
        assertEq(_escrowOf(id), 0);
        assertEq(reg.timbsEscrowHeld(), 0, "escrow ledger released");

        vm.expectRevert(abi.encodeWithSelector(GameRegistry.NoPendingLapse.selector, id));
        reg.retryLapse(id);
    }

    /// The forfeited stake is no longer refundable to the forfeiter.
    function test_TS076_AdminRefundRefusesPendingLapse() public {
        (uint256 id,) = _enterTimbs(PLAYER);
        timbs.setPaused(true);
        _sweepRound5(PLAYER);
        timbs.setPaused(false);

        vm.expectRevert(abi.encodeWithSelector(GameRegistry.LapseStillPending.selector, id));
        reg.adminRefundStuck(id);
        vm.prank(PLAYER);
        vm.expectRevert();
        reg.claimRefund(id);
    }

    /// ETH: the pot leg succeeds, the sink refuses its share. The share is
    /// pending and reaches the sink once it accepts again.
    function test_TS076_EthSinkRefusalRetries() public {
        SwitchableSink sink = new SwitchableSink();
        GameRegistry r2 = new GameRegistry(address(timbs), address(sink), address(this), 2e18, 1e18);
        vm.deal(PLAYER, 1 ether);
        vm.prank(PLAYER);
        r2.submitEntry{value: 0.001 ether}(S1, true, 0);
        uint256 id = r2.activeTicketOf(PLAYER);
        (GameRegistry.Ticket memory t0,) = r2.getTicket(id);
        uint256 stake = t0.escrowAmount;

        sink.setRefuse(true);
        r2.setCurrentRound(1);
        r2.activateRoundEntries(1, _one(PLAYER));
        r2.setCurrentRound(6);
        r2.onRoundSettled(5, 0);

        uint256 sinkShare = stake - (stake * r2.lapsePotBps()) / 10_000;
        assertTrue(r2.lapsePending(id));
        (GameRegistry.Ticket memory t1,) = r2.getTicket(id);
        assertEq(t1.escrowAmount, sinkShare, "only the refused sink share stays");

        sink.setRefuse(false);
        r2.retryLapse(id);
        assertEq(address(sink).balance, sinkShare, "sink share delivered");
        assertFalse(r2.lapsePending(id));
    }

    /// Control: a sweep that succeeds leaves nothing pending.
    function test_TS076_Control_CleanSweepNotPending() public {
        (uint256 id, uint256 stake) = _enterTimbs(PLAYER);
        _sweepRound5(PLAYER);
        assertFalse(reg.lapsePending(id));
        assertEq(timbs.balanceOf(SINK), stake);
        assertEq(reg.timbsEscrowHeld(), 0);
    }

    // ─── TS-077 ─────────────────────────────────────────────────────────────

    /// A stray TIMBS transfer is recoverable; live escrow is not.
    function test_TS077_StrayTimbsRecoverableEscrowNot() public {
        (uint256 id, uint256 stake) = _enterTimbs(PLAYER);
        timbs.mint(address(0xF00), 5e18);
        vm.prank(address(0xF00));
        timbs.transfer(address(reg), 5e18); // fat-fingered, credited to no ticket

        assertEq(reg.timbsEscrowHeld(), stake);
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.ExceedsRecoverable.selector, 5e18 + 1, 5e18));
        reg.recoverERC20(address(timbs), address(0xF00), 5e18 + 1);
        reg.recoverERC20(address(timbs), address(0xF00), 5e18);
        assertEq(timbs.balanceOf(address(0xF00)), 5e18, "stray returned");

        vm.prank(PLAYER);
        reg.cancelEntry(); // still Pending: full principal back
        assertEq(timbs.balanceOf(PLAYER), 100e18, "escrow untouched by the recovery");
        assertEq(reg.timbsEscrowHeld(), 0);
        id;
    }

    function test_TS077_OtherTokensInFullNeverEthOwnerOnly() public {
        OtherStray usdc = new OtherStray();
        usdc.transfer(address(reg), 7e6);
        reg.recoverERC20(address(usdc), address(0xF00), 7e6);
        assertEq(usdc.balanceOf(address(0xF00)), 7e6);

        vm.expectRevert(GameRegistry.ZeroAddress.selector);
        reg.recoverERC20(address(0), address(0xF00), 1);

        vm.prank(PLAYER);
        vm.expectRevert();
        reg.recoverERC20(address(usdc), PLAYER, 1);
    }

    /// The escrow ledger equals the registry's TIMBS balance through entry,
    /// replacement, cancellation, forfeiture, retirement and reclaim.
    function test_TS077_LedgerMatchesBalanceOnEveryPath() public {
        (uint256 a,) = _enterTimbs(PLAYER);
        (uint256 b,) = _enterTimbs(PLAYER2);
        (uint256 c,) = _enterTimbs(PLAYER3);
        assertEq(reg.timbsEscrowHeld(), timbs.balanceOf(address(reg)), "after entries");

        vm.prank(PLAYER);
        reg.replaceEntry(bytes6("XYZ789"), 0);
        assertEq(reg.timbsEscrowHeld(), timbs.balanceOf(address(reg)), "after replace");

        vm.prank(PLAYER2);
        reg.cancelEntry();
        assertEq(reg.timbsEscrowHeld(), timbs.balanceOf(address(reg)), "after cancel");

        reg.setCurrentRound(1);
        reg.activateRoundEntries(1, _one(PLAYER3));
        reg.setCurrentRound(6);
        reg.onRoundSettled(5, 0); // PLAYER3 forfeits
        assertEq(reg.timbsEscrowHeld(), timbs.balanceOf(address(reg)), "after forfeit");

        a; b; c;
    }

    /// Retirement: an old-game ticket reclaims its stake and the ledger follows.
    function test_TS077_LedgerFollowsReclaimAfterRetire() public {
        (uint256 id, uint256 stake) = _enterTimbs(PLAYER);
        reg.retireGame();
        vm.prank(PLAYER);
        reg.reclaimFromPastGame(id);
        assertEq(timbs.balanceOf(PLAYER), 100e18, "stake reclaimed");
        assertEq(reg.timbsEscrowHeld(), 0);
        assertEq(timbs.balanceOf(address(reg)), 0);
        stake;
    }
}
