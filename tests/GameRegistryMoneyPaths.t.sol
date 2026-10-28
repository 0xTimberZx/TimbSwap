// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../contracts/GameRegistry.sol";

contract MoneyPathTIMBS is ERC20 {
    constructor() ERC20("TIMBS", "TIMBS") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// A player contract that can enter, cancel and claim, and can be switched to
/// refuse incoming ETH (a smart wallet with a reverting receive).
contract RefusingPlayer {
    GameRegistry public reg;
    bool public refuse;
    constructor(GameRegistry r) { reg = r; }
    function setRefuse(bool r) external { refuse = r; }
    function enter(bytes6 s, bool useETH) external payable { reg.submitEntry{value: msg.value}(s, useETH, 0); }
    function cancel() external { reg.cancelEntry(); }
    function refund(uint256 id) external { reg.claimRefund(id); }
    function approve(IERC20 t) external { t.approve(address(reg), type(uint256).max); }
    receive() external payable { require(!refuse, "refused"); }
}

/// A sink that can be switched to refuse ETH.
contract RefusingSink {
    bool public refuse;
    function setRefuse(bool r) external { refuse = r; }
    receive() external payable { require(!refuse, "refused"); }
}

/// A yield vault whose weight calls always revert.
contract BrokenVault {
    function register(uint256, address, uint256) external pure { revert("broken"); }
    function remove(uint256) external pure { revert("broken"); }
    function newEpoch() external pure { revert("broken"); }
}

/**
 * Branch coverage for the GameRegistry paths that move or hold player money:
 * entry payment and refunds, replace, cancel, claimRefund and its window,
 * lapse retry, admin refund, settlement pagination, and the fenced vault
 * calls. Each test asserts where the ETH or TIMBS ends up, not only that a
 * branch ran. Tests only; no contract change.
 *
 * The test contract stands in as timbPrize (drives rounds, receives addToPot).
 */
contract GameRegistryMoneyPathsTest is Test {
    MoneyPathTIMBS timbs;
    GameRegistry reg;
    RefusingSink sink;

    address constant ALICE = address(0xA11CE);
    address constant BOB   = address(0xB0B);
    bytes6  constant S1    = bytes6("ABC123");
    bytes6  constant S2    = bytes6("XYZ789");
    uint256 constant FLOOR = 0.001 ether;

    function addToPot() external payable {}
    receive() external payable {}

    function setUp() public {
        timbs = new MoneyPathTIMBS();
        sink = new RefusingSink();
        reg = new GameRegistry(address(timbs), address(sink), address(this), 2e18, 1e18);
        vm.deal(ALICE, 10 ether);
        vm.deal(BOB, 10 ether);
    }

    function _one(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    function _enterEth(address who, bytes6 s) internal returns (uint256 id) {
        vm.prank(who);
        reg.submitEntry{value: FLOOR}(s, true, 0);
        id = reg.activeTicketOf(who);
    }

    function _ticket(uint256 id) internal view returns (GameRegistry.Ticket memory t) {
        (t,) = reg.getTicket(id);
    }

    // ─── Entry payment ──────────────────────────────────────────────────────

    function test_EthEntry_UnderpaymentReverts() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.WrongEscrowAmount.selector, FLOOR - 1, FLOOR));
        reg.submitEntry{value: FLOOR - 1}(S1, true, 0);
        assertEq(address(reg).balance, 0);
    }

    function test_EthEntry_OverpaymentRefundsTheExcess() public {
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        reg.submitEntry{value: 1 ether}(S1, true, 0);
        assertEq(ALICE.balance, before - FLOOR, "only the entry cost is kept");
        assertEq(address(reg).balance, FLOOR);
        assertEq(_ticket(reg.activeTicketOf(ALICE)).escrowAmount, FLOOR);
        assertEq(reg.totalEthEscrow(), FLOOR);
    }

    function test_EthEntry_FailedExcessRefundRevertsTheEntry() public {
        RefusingPlayer p = new RefusingPlayer(reg);
        p.setRefuse(true);
        vm.expectRevert(GameRegistry.EthTransferFailed.selector);
        p.enter{value: 1 ether}(S1, true);
        assertEq(reg.activeTicketOf(address(p)), 0, "no ticket minted");
        assertEq(address(reg).balance, 0);
    }

    function test_TimbsEntry_StrayEthIsReturned() public {
        reg.setTimbsEntryEnabled(true);
        timbs.mint(ALICE, 10e18);
        uint256 before = ALICE.balance;
        vm.startPrank(ALICE);
        timbs.approve(address(reg), type(uint256).max);
        reg.submitEntry{value: 0.5 ether}(S1, false, 0);
        vm.stopPrank();
        assertEq(ALICE.balance, before, "ETH sent with a TIMBS entry comes back");
        assertEq(address(reg).balance, 0);
        assertEq(reg.timbsEscrowHeld(), 2e18);
    }

    function test_TimbsEntry_FailedEthReturnReverts() public {
        reg.setTimbsEntryEnabled(true);
        RefusingPlayer p = new RefusingPlayer(reg);
        timbs.mint(address(p), 10e18);
        p.approve(timbs);
        p.setRefuse(true);
        vm.expectRevert(GameRegistry.EthTransferFailed.selector);
        p.enter{value: 0.5 ether}(S1, false);
        assertEq(timbs.balanceOf(address(reg)), 0);
    }

    function test_Entry_RejectsInvalidAndRepeatedCharacters() public {
        vm.startPrank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.InvalidCharacter.selector, bytes1("a")));
        reg.submitEntry{value: FLOOR}(bytes6("aBC123"), true, 0);
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.RepeatingCharacter.selector, bytes1("A")));
        reg.submitEntry{value: FLOOR}(bytes6("ABA123"), true, 0);
        vm.stopPrank();

        reg.setAllowRepeatedChars(true);
        vm.prank(ALICE);
        reg.submitEntry{value: FLOOR}(bytes6("AAA111"), true, 0);
        assertTrue(reg.activeTicketOf(ALICE) != 0, "repeats accepted once enabled");
    }

    function test_Entry_BlockedWhilePaused() public {
        reg.pause();
        vm.prank(ALICE);
        vm.expectRevert(GameRegistry.ContractPaused.selector);
        reg.submitEntry{value: FLOOR}(S1, true, 0);
    }

    // ─── Replace ────────────────────────────────────────────────────────────

    function test_Replace_CarriesPrincipalAndChecksExtraRoundAllowance() public {
        reg.setTimbsEntryEnabled(true);
        uint256 oldId = _enterEth(ALICE, S1);

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.TooManyExtraRounds.selector, 7, 6));
        reg.replaceEntry(S2, 7);

        reg.setExtraRoundCostTimbs(1e18);
        timbs.mint(ALICE, 10e18);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.InsufficientAllowance.selector, 2e18, 0));
        reg.replaceEntry(S2, 2);

        vm.startPrank(ALICE);
        timbs.approve(address(reg), type(uint256).max);
        reg.replaceEntry(S2, 2);
        vm.stopPrank();

        uint256 newId = reg.activeTicketOf(ALICE);
        assertEq(_ticket(newId).escrowAmount, FLOOR, "principal moved to the replacement");
        assertEq(_ticket(oldId).escrowAmount, 0);
        assertEq(timbs.balanceOf(address(sink)), 2e18, "extra rounds paid to the sink");
        assertEq(address(reg).balance, FLOOR, "no ETH left or created");
        assertEq(reg.totalEthEscrow(), FLOOR, "pricing meter net-neutral");
    }

    function test_Replace_RefusedOnceTheTicketIsNoLongerLive() public {
        _enterEth(ALICE, S1);           // plays round 1, LER 1
        reg.setCurrentRound(2);         // past its last eligible round
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(GameRegistry.TicketNotReplaceable.selector, GameRegistry.TicketStatus.Pending)
        );
        reg.replaceEntry(S2, 0);
    }

    // ─── Cancel ─────────────────────────────────────────────────────────────

    function test_Cancel_RefusedOnceThePlayRoundStarted() public {
        _enterEth(ALICE, S1);
        reg.setCurrentRound(1);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.RoundAlreadyStarted.selector, 1, 1));
        reg.cancelEntry();
    }

    function test_Cancel_FailedPayoutRevertsAndKeepsTheTicket() public {
        RefusingPlayer p = new RefusingPlayer(reg);
        p.enter{value: FLOOR}(S1, true);
        uint256 id = reg.activeTicketOf(address(p));
        p.setRefuse(true);
        vm.expectRevert(GameRegistry.EthTransferFailed.selector);
        p.cancel();
        assertEq(_ticket(id).escrowAmount, FLOOR, "escrow untouched");
        assertEq(uint8(_ticket(id).status), uint8(GameRegistry.TicketStatus.Pending));

        p.setRefuse(false);
        uint256 before = address(p).balance;
        p.cancel();
        assertEq(address(p).balance, before + FLOOR, "paid once the wallet accepts");
    }

    // ─── claimRefund window ─────────────────────────────────────────────────

    function test_ClaimRefund_GuardsAndWindow() public {
        uint256 id = _enterEth(ALICE, S1); // LER 1, forfeitRound 5

        vm.expectRevert(abi.encodeWithSelector(GameRegistry.TicketNotFound.selector, 999));
        reg.claimRefund(999);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.NotTicketOwner.selector, id, BOB));
        reg.claimRefund(id);

        reg.setCurrentRound(6); // past forfeitRound, sweep not yet run
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.ClaimWindowClosed.selector, 1, 6));
        reg.claimRefund(id);
    }

    /// Refund before the settlement sweep ran: the ticket still holds the
    /// wallet's active slot, and claiming frees it.
    function test_ClaimRefund_FreesTheActiveSlotWhenSettlementHasNotRun() public {
        uint256 id = _enterEth(ALICE, S1);
        reg.setCurrentRound(1);
        reg.activateRoundEntries(1, _one(ALICE));
        reg.setCurrentRound(2);
        assertEq(reg.activeTicketOf(ALICE), id, "slot still held");

        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        reg.claimRefund(id);
        assertEq(ALICE.balance, before + FLOOR);
        assertEq(reg.activeTicketOf(ALICE), 0, "slot freed");
        assertEq(reg.totalEthEscrow(), 0);
    }

    /// Refund after the sweep already freed the slot leaves a newer ticket's
    /// slot alone.
    function test_ClaimRefund_LeavesANewerTicketsSlotAlone() public {
        uint256 id = _enterEth(ALICE, S1);
        reg.setCurrentRound(1);
        reg.activateRoundEntries(1, _one(ALICE));
        reg.setCurrentRound(2);
        reg.onRoundSettled(1, 0);       // expiry frees the slot
        uint256 newer = _enterEth(ALICE, S2);

        vm.prank(ALICE);
        reg.claimRefund(id);
        assertEq(reg.activeTicketOf(ALICE), newer, "newer ticket keeps its slot");
        assertEq(address(reg).balance, FLOOR, "only the newer ticket's escrow remains");
    }

    function test_ReclaimFromPastGame_UnknownTicketReverts() public {
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.TicketNotFound.selector, 42));
        reg.reclaimFromPastGame(42);
    }

    // ─── Lapse retry and admin refund ───────────────────────────────────────

    function test_RetryLapse_EthStillRefusedReverts() public {
        uint256 id = _enterEth(ALICE, S1);
        reg.setCurrentRound(1);
        reg.activateRoundEntries(1, _one(ALICE));
        sink.setRefuse(true);
        reg.setCurrentRound(6);
        uint256 potBefore = address(this).balance;
        reg.onRoundSettled(5, 0);
        assertTrue(reg.lapsePending(id));

        // The pot leg went through; only the sink's share is pending.
        uint256 toPot = FLOOR * reg.lapsePotBps() / 10_000;
        uint256 sinkShare = FLOOR - toPot;
        assertEq(address(this).balance, potBefore + toPot, "pot share delivered");
        assertEq(_ticket(id).escrowAmount, sinkShare);

        vm.expectRevert(abi.encodeWithSelector(GameRegistry.LapseRetryFailed.selector, id));
        reg.retryLapse(id);
        assertTrue(reg.lapsePending(id), "still pending after a failed retry");
        assertEq(_ticket(id).escrowAmount, sinkShare);

        sink.setRefuse(false);
        reg.retryLapse(id);
        assertEq(address(sink).balance, sinkShare);
        assertEq(address(reg).balance, 0, "nothing left behind");
    }

    function test_AdminRefundStuck_GuardsAndOwnerOnlyDestination() public {
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.TicketNotFound.selector, 7));
        reg.adminRefundStuck(7);

        uint256 id = _enterEth(ALICE, S1);
        vm.expectRevert(
            abi.encodeWithSelector(GameRegistry.TicketNotRefundable.selector, GameRegistry.TicketStatus.Pending)
        );
        reg.adminRefundStuck(id);

        reg.adminMarkIneligible(id);
        uint256 before = ALICE.balance;
        uint256 ownerBefore = address(this).balance;
        reg.adminRefundStuck(id);
        assertEq(ALICE.balance, before + FLOOR, "refund goes to the ticket owner");
        assertEq(address(this).balance, ownerBefore, "owner gains nothing");

        vm.expectRevert(GameRegistry.ZeroAmount.selector);
        reg.adminRefundStuck(id);
    }

    function test_AdminMarkIneligible_UnknownTicketReverts() public {
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.TicketNotFound.selector, 3));
        reg.adminMarkIneligible(3);
    }

    /// A prior-generation ticket's disposal must not move the current game's
    /// pricing meter.
    function test_PriorGenerationDisposalLeavesTheMeterAlone() public {
        uint256 oldId = _enterEth(ALICE, S1);
        reg.onGameStarted();            // first game: generation 1 kept
        reg.onGameStarted();            // second: generation 2, meters reset
        _enterEth(BOB, S2);
        assertEq(reg.totalEthEscrow(), FLOOR, "only Bob backs the price");

        reg.adminMarkIneligible(oldId);
        assertEq(reg.totalEthEscrow(), FLOOR, "old ticket did not touch the meter");
    }

    function test_RecoverERC20_ZeroAmountReverts() public {
        vm.expectRevert(GameRegistry.ZeroAmount.selector);
        reg.recoverERC20(address(timbs), ALICE, 0);
    }

    // ─── Fenced yield-vault calls ───────────────────────────────────────────

    function test_BrokenVault_NeverBlocksMoneyPaths() public {
        reg.setYieldVault(address(new BrokenVault()));
        uint256 id = _enterEth(ALICE, S1);
        reg.setCurrentRound(1);

        vm.expectEmit(true, false, false, true, address(reg));
        emit GameRegistry.WeightRegisterFailed(id, reg.VAULT_WEIGHT_UNIT());
        reg.activateRoundEntries(1, _one(ALICE));

        reg.setCurrentRound(2);
        vm.expectEmit(true, false, false, false, address(reg));
        emit GameRegistry.WeightRemoveFailed(id);
        vm.prank(ALICE);
        reg.claimRefund(id);
        assertEq(address(reg).balance, 0, "refund paid despite the vault");
    }

    function test_SetYieldVault_SameAddressDoesNotRetireWeight() public {
        address v = address(new BrokenVault());
        reg.setYieldVault(v);
        vm.recordLogs();
        reg.setYieldVault(v);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "only YieldVaultSet, no newEpoch attempt");
    }

    // ─── Settlement ─────────────────────────────────────────────────────────

    function test_Activate_OnlyCurrentRoundAndSkipsNonEntrants() public {
        _enterEth(ALICE, S1);
        vm.expectRevert(bytes("not current round"));
        reg.activateRoundEntries(1, _one(ALICE));

        reg.setCurrentRound(1);
        address[] memory two = new address[](2);
        two[0] = BOB;   // no ticket: skipped
        two[1] = ALICE;
        reg.activateRoundEntries(1, two);
        assertEq(uint8(_ticket(reg.activeTicketOf(ALICE)).status), uint8(GameRegistry.TicketStatus.Active));
    }

    function test_OnRoundSettled_PaginatesAndOnlyAfterSettlement() public {
        _enterEth(ALICE, S1);
        _enterEth(BOB, S2);
        reg.setCurrentRound(1);
        address[] memory both = new address[](2);
        both[0] = ALICE; both[1] = BOB;
        reg.activateRoundEntries(1, both);

        vm.expectRevert(bytes("round not settled"));
        reg.onRoundSettled(1, 0);

        reg.setCurrentRound(2);
        assertFalse(reg.onRoundSettled(1, 1), "one step: not done");
        assertEq(reg.activeTicketOf(ALICE), 0, "first entrant expired");
        assertTrue(reg.activeTicketOf(BOB) != 0, "second not yet");
        assertTrue(reg.onRoundSettled(1, 1), "second step finishes");
        assertEq(reg.activeTicketOf(BOB), 0);
        assertTrue(reg.onRoundSettled(1, 1), "done stays done");
    }

    function test_RecordWinners_OnlyPrizeAndSkipsNonEntrants() public {
        uint256 id = _enterEth(ALICE, S1);
        vm.prank(BOB);
        vm.expectRevert(GameRegistry.NotTimbPrize.selector);
        reg.recordWinners(1, _one(ALICE));

        address[] memory two = new address[](2);
        two[0] = BOB; two[1] = ALICE;
        reg.recordWinners(1, two);
        assertEq(_ticket(id).forfeitRound, 1 + 2 + 4, "winner's window pushed");
    }

    // ─── Views and config guards ────────────────────────────────────────────

    function test_Views_ReportMissingAndOutOfWindowTickets() public {
        assertFalse(reg.isTicketLive(0));
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.TicketNotFound.selector, 1));
        reg.getTicket(1);
        (bool exists,) = reg.verifyEntryExisted(ALICE, 1);
        assertFalse(exists);
        (bool valid,) = reg.verifyEntryValid(ALICE, 1);
        assertFalse(valid);

        uint256 id = _enterEth(ALICE, S1);
        reg.adminMarkIneligible(id);
        (valid,) = reg.verifyEntryValid(ALICE, 1);
        assertFalse(valid, "an Ineligible ticket cannot win");
    }

    function test_ConfigRejectsZeroAddresses() public {
        vm.expectRevert(GameRegistry.ZeroAddress.selector);
        new GameRegistry(address(0), address(sink), address(this), 2e18, 1e18);
        vm.expectRevert(GameRegistry.ZeroAddress.selector);
        new GameRegistry(address(timbs), address(0), address(this), 2e18, 1e18);
        vm.expectRevert(GameRegistry.ZeroAddress.selector);
        reg.setTimbPrize(address(0));
        vm.expectRevert(GameRegistry.ZeroAddress.selector);
        reg.setProtocolSink(address(0));
    }
}
