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
        _deposit(alice, 100e18);
        vm.warp(block.timestamp + VOTING_DELAY + 1);
        vm.prank(alice);
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
}
