// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../contracts/TimbGovernance.sol";

contract GovMockTIMBS is ERC20 {
    constructor() ERC20("TIMBS", "TIMBS") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/**
 * @notice Minimal coverage for TimbGovernance: the deposit/withdraw voting-power
 *         flow, the audit **M6** O(1) withdrawal lock (replacing the old
 *         unbounded loop), the **Low** zero-snapshot quorum guard, a below-quorum
 *         failure, and the pass→execute happy path.
 *
 *         Governance is off-chain SIGNALING for beta (audit H3): executeProposal
 *         is owner-gated and real authority is the timelock/multisig. These tests
 *         fix the module's intended behavior — not a claim that it self-executes
 *         protocol changes.
 */
contract TimbGovernanceTest is Test {
    GovMockTIMBS   timbs;
    TimbGovernance gov;

    address alice = address(0xA11CE);
    address bob   = address(0xB0B);
    address rando = address(0xF00D);

    uint256 constant THRESHOLD     = 1_000e18;
    uint256 constant QUORUM_BPS    = 400;    // 4%
    uint256 constant VOTING_PERIOD = 3 days;
    uint256 constant VOTING_DELAY  = 1 days;

    function setUp() public {
        timbs = new GovMockTIMBS();
        // This contract deploys gov, so it is the owner; give it the proposal
        // threshold so createProposal()'s balance gate passes.
        timbs.mint(address(this), THRESHOLD);
        gov = new TimbGovernance(address(timbs), THRESHOLD, QUORUM_BPS, VOTING_PERIOD, VOTING_DELAY);
        _fund(alice);
        _fund(bob);
        // Move off timestamp 0 so votingLockUntil (0 == unlocked) is unambiguous.
        vm.warp(1_000_000);
    }

    function _fund(address who) internal {
        timbs.mint(who, 1_000_000e18);
        vm.prank(who);
        timbs.approve(address(gov), type(uint256).max);
    }

    function _deposit(address who, uint256 amt) internal {
        vm.prank(who);
        gov.depositVotingPower(amt);
    }

    // ─── Voting power ────────────────────────────────────────────────────────

    function test_DepositWithdraw_Roundtrip() public {
        uint256 bal = timbs.balanceOf(alice);
        _deposit(alice, 100e18);
        assertEq(gov.votingPowerDeposited(alice), 100e18, "deposited");
        assertEq(gov.totalVotingPower(), 100e18, "total");
        vm.prank(alice);
        gov.withdrawVotingPower(100e18);
        assertEq(gov.votingPowerDeposited(alice), 0, "withdrawn");
        assertEq(timbs.balanceOf(alice), bal, "tokens returned");
    }

    function test_CreateProposal_OnlyOwner() public {
        vm.prank(rando);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        gov.createProposal("t", "d");
    }

    // ─── M6: O(1) withdrawal lock (replaces the unbounded loop) ───────────────

    function test_M6_VotingPowerLockedUntilExecutionDeadline() public {
        _deposit(alice, 100e18);
        uint256 pid = gov.createProposal("m6", "lock");
        vm.warp(block.timestamp + VOTING_DELAY + 1); // enter the voting window
        vm.prank(alice);
        gov.castVote(pid, true);

        uint256 lockedUntil = gov.votingLockUntil(alice);
        assertGt(lockedUntil, block.timestamp, "lock set to a future deadline");

        // Cannot withdraw while a voted proposal can still execute.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TimbGovernance.VotingPowerLocked.selector, lockedUntil));
        gov.withdrawVotingPower(100e18);

        // Past the execution deadline, the lock lifts.
        vm.warp(lockedUntil + 1);
        vm.prank(alice);
        gov.withdrawVotingPower(100e18);
        assertEq(gov.votingPowerDeposited(alice), 0, "unlocked after deadline");
    }

    // ─── Low fix: a zero creation-snapshot can never meet quorum ──────────────

    function test_Quorum_ZeroSnapshotFails() public {
        // Snapshot totalVotingPower == 0 at creation (nothing deposited yet).
        uint256 pid = gov.createProposal("zero", "snapshot");
        // Deposit + vote FOR *after* creation — must not rescue quorum.
        // (Since TS-034/TS-040 the vote itself is refused: no power at creation.)
        _deposit(alice, 100e18);
        vm.warp(block.timestamp + VOTING_DELAY + 1);
        vm.prank(alice);
        vm.expectRevert(TimbGovernance.InsufficientVotingPower.selector);
        gov.castVote(pid, true);
        // After voting ends the outcome is Failed → not executable.
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        vm.expectRevert(TimbGovernance.ProposalNotPassed.selector);
        gov.executeProposal(pid);
    }

    // ─── Quorum: votes below the snapshot quorum fail ─────────────────────────

    function test_BelowQuorum_Fails() public {
        _deposit(alice, 100e18); // large snapshot holder — will NOT vote
        _deposit(bob, 1e18);
        uint256 pid = gov.createProposal("quorum", "check"); // snapshot 101e18 → quorum ~4.04e18
        vm.warp(block.timestamp + VOTING_DELAY + 1);
        vm.prank(bob);
        gov.castVote(pid, true); // only 1e18 votes, well under quorum
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        vm.expectRevert(TimbGovernance.ProposalNotPassed.selector);
        gov.executeProposal(pid);
    }

    // ─── TS-021: quorum base ratchets down while voting is open ───────────────

    function test_TS021_WithdrawnParkedPowerNoLongerVetoes() public {
        _deposit(alice, 100e18);                 // parks, never votes
        _deposit(bob, 1e18);
        uint256 pid = gov.createProposal("veto", "attempt"); // snapshot 101e18
        vm.prank(alice);
        gov.withdrawVotingPower(100e18);         // leaves right after creation
        vm.warp(block.timestamp + VOTING_DELAY + 1);
        vm.prank(bob);
        gov.castVote(pid, true);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        gov.executeProposal(pid);                // quorum now on 1e18 → passes
    }

    function test_TS021_BaseFrozenAfterVotingEnds() public {
        _deposit(alice, 100e18);
        _deposit(bob, 1e18);
        uint256 pid = gov.createProposal("late", "withdraw");
        vm.warp(block.timestamp + VOTING_DELAY + 1);
        vm.prank(bob);
        gov.castVote(pid, true);
        vm.warp(block.timestamp + VOTING_PERIOD + 1); // voting over: failed quorum
        vm.prank(alice);
        gov.withdrawVotingPower(100e18);         // must not flip the result now
        vm.expectRevert(TimbGovernance.ProposalNotPassed.selector);
        gov.executeProposal(pid);
    }

    function test_TS021_OpenProposalCapAndPrune() public {
        uint256 cap = gov.MAX_OPEN_PROPOSALS();
        for (uint256 i = 0; i < cap; i++) gov.createProposal("p", "d");
        vm.expectRevert(TimbGovernance.TooManyOpenProposals.selector);
        gov.createProposal("one", "too many");
        vm.warp(block.timestamp + VOTING_DELAY + VOTING_PERIOD + 1);
        gov.createProposal("after", "prune");    // ended ones are swept out
        assertEq(gov.openProposalCount(), 1);
    }

    // ─── Happy path: quorum met, FOR wins → passes and executes ───────────────

    function test_HappyPath_PassesAndExecutes() public {
        _deposit(alice, 100e18);
        uint256 pid = gov.createProposal("pass", "me"); // snapshot 100e18, quorum 4e18
        vm.warp(block.timestamp + VOTING_DELAY + 1);
        vm.prank(alice);
        gov.castVote(pid, true); // 100e18 FOR >> quorum, for > against
        vm.warp(block.timestamp + VOTING_PERIOD + 1); // voting ended, inside execution window
        gov.executeProposal(pid); // owner (this contract) executes → succeeds
        // Idempotency: a second execute reverts AlreadyExecuted.
        vm.expectRevert(TimbGovernance.AlreadyExecuted.selector);
        gov.executeProposal(pid);
    }

    // ─── TS-034: votes weigh the power held at proposal creation ────────────

    function test_TS034_PostCreationDepositCannotVote() public {
        _deposit(alice, 100e18);
        uint256 pid = gov.createProposal("capture", "me"); // base 100e18
        vm.warp(block.timestamp + VOTING_DELAY + 1);
        _deposit(bob, 50_000e18);                           // after creation
        vm.prank(bob);
        vm.expectRevert(TimbGovernance.InsufficientVotingPower.selector);
        gov.castVote(pid, true);
        // alice's pre-creation power still votes at full weight
        vm.prank(alice);
        gov.castVote(pid, false);
        (, , , , , , , , uint256 forV, uint256 againstV, , ,) = gov.proposals(pid);
        assertEq(forV, 0);
        assertEq(againstV, 100e18);
    }

    function test_TS034_TopUpAfterCreationIsNotCounted() public {
        _deposit(alice, 100e18);
        uint256 pid = gov.createProposal("topup", "me");
        vm.warp(block.timestamp + VOTING_DELAY + 1);
        _deposit(alice, 900e18);                            // top-up after creation
        vm.prank(alice);
        gov.castVote(pid, true);
        (, , , , , , , , uint256 forV, , , ,) = gov.proposals(pid);
        assertEq(forV, 100e18, "only the creation-time power counts");
    }

    function test_TS034_SnapshotFollowsLaterProposals() public {
        _deposit(alice, 100e18);
        uint256 p1 = gov.createProposal("one", "");
        vm.warp(block.timestamp + 10);
        _deposit(alice, 400e18);
        vm.warp(block.timestamp + 10);
        uint256 p2 = gov.createProposal("two", "");
        vm.warp(block.timestamp + VOTING_DELAY + 1);
        assertEq(gov.votingPowerAt(alice, _createdAt(p1)), 100e18);
        assertEq(gov.votingPowerAt(alice, _createdAt(p2)), 500e18);
    }

    function _createdAt(uint256 pid) internal view returns (uint256 c) {
        (, , , , c, , , , , , , ,) = gov.proposals(pid);
    }

    // ─── TS-040: the creation second is sealed against backrun deposits ──────

    function test_TS040_SameSecondDepositAfterCreationCannotVote() public {
        uint256 pid = gov.createProposal("ts040", "seal");
        _deposit(alice, 100e18);                       // same second, later tx
        assertEq(gov.votingPowerAt(alice, block.timestamp), 0, "not held at creation");
        assertEq(gov.votingPowerAt(alice, block.timestamp + 1), 100e18, "visible next second");
        vm.warp(block.timestamp + VOTING_DELAY + 1);
        vm.prank(alice);
        vm.expectRevert(TimbGovernance.InsufficientVotingPower.selector);
        gov.castVote(pid, true);
    }

    function test_TS040_SameSecondDepositBeforeCreationStillVotes() public {
        _deposit(alice, 100e18);                       // same second, earlier tx
        uint256 pid = gov.createProposal("ts040", "before");
        vm.warp(block.timestamp + VOTING_DELAY + 1);
        vm.prank(alice);
        gov.castVote(pid, true);
        (, , , , , , , , uint256 forVotes, , , , ) = gov.proposals(pid);
        assertEq(forVotes, 100e18, "pre-creation deposit weighs in full");
    }

    function test_TS040_SealedHistoryStaysMonotonic() public {
        vm.warp(2_000_000);
        gov.createProposal("ts040", "mono");
        _deposit(alice, 10e18);                        // sealed to 2_000_001
        _deposit(alice, 5e18);                         // same second again: overwrite sealed entry
        assertEq(gov.votingPowerAt(alice, 2_000_001), 15e18, "sealed entry updated");
        vm.warp(2_000_001);
        _deposit(alice, 1e18);                         // real checkpoint overwrites, no dup
        assertEq(gov.votingPowerAt(alice, 2_000_001), 16e18, "reflects all deposits");
        vm.warp(2_000_002);
        _deposit(alice, 1e18);
        assertEq(gov.votingPowerAt(alice, 2_000_000), 0,     "nothing at creation second");
        assertEq(gov.votingPowerAt(alice, 2_000_001), 16e18, "history preserved");
        assertEq(gov.votingPowerAt(alice, 2_000_002), 17e18, "latest");
    }
}
