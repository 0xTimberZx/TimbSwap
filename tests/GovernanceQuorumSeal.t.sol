// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../contracts/TimbGovernance.sol";

contract QSMockTIMBS is ERC20 {
    constructor() ERC20("TIMBS", "TIMBS") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/**
 * TS-069 — departing creation-time power leaves the quorum base even when
 *          deposits made after creation keep the live total up.
 * TS-070 — one proposal per second, so the TS-040 seal cannot be stepped
 *          around by a second proposal in the same second.
 *
 * Run: forge test --match-contract GovernanceQuorumSealTest -vvv
 */
contract GovernanceQuorumSealTest is Test {
    QSMockTIMBS    timbs;
    TimbGovernance gov;
    address alice = address(0xA11CE);
    address bob   = address(0xB0B);
    address carol = address(0xCA201);

    function setUp() public {
        timbs = new QSMockTIMBS();
        timbs.mint(address(this), 1_000e18);
        gov = new TimbGovernance(address(timbs), 1_000e18, 400, 3 days, 1 days);
        _fund(alice); _fund(bob); _fund(carol);
        vm.warp(1_000_000);
    }

    function _fund(address who) internal {
        timbs.mint(who, 1_000_000e18);
        vm.prank(who);
        timbs.approve(address(gov), type(uint256).max);
    }

    function _deposit(address who, uint256 amt) internal { vm.prank(who); gov.depositVotingPower(amt); }
    function _withdraw(address who, uint256 amt) internal { vm.prank(who); gov.withdrawVotingPower(amt); }
    function _base(uint256 id) internal view returns (uint256) {
        (TimbGovernance.Proposal memory p,) = gov.getProposal(id);
        return p.totalVotingPower;
    }

    // ─── TS-069 ─────────────────────────────────────────────────────────────

    /// The reported case: a post-creation deposit offsets a snapshot holder's
    /// withdrawal 1:1 in the live total; the base must still drop.
    function test_TS069_LateDepositDoesNotMaskRatchet() public {
        _deposit(alice, 50e18);
        _deposit(bob,   50e18);
        uint256 id = gov.createProposal("p", "d");
        assertEq(_base(id), 100e18);

        vm.warp(block.timestamp + 1);
        _deposit(carol, 50e18);              // cannot vote on `id` (TS-034)
        _withdraw(alice, 50e18);             // live total stays 100
        assertEq(gov.totalVotingPower(), 100e18);
        assertEq(_base(id), 50e18, "only bob's creation power can still vote");
    }

    /// Without a late deposit the departure is counted once, not twice
    /// (direct subtraction and the live ratchet agree).
    function test_TS069_NoDoubleCount() public {
        _deposit(alice, 50e18);
        _deposit(bob,   50e18);
        uint256 id = gov.createProposal("p", "d");
        vm.warp(block.timestamp + 1);
        _withdraw(alice, 50e18);
        assertEq(_base(id), 50e18);
    }

    /// Power deposited after creation and withdrawn again never was in the
    /// base, so it takes nothing out of it.
    function test_TS069_LateDepositRoundTripLeavesBase() public {
        _deposit(alice, 100e18);
        uint256 id = gov.createProposal("p", "d");
        vm.warp(block.timestamp + 1);
        _deposit(carol, 50e18);
        _withdraw(carol, 50e18);
        assertEq(_base(id), 100e18);
    }

    /// Partial withdrawals add up, and a redeposit-then-withdraw cannot take
    /// out more than the creation-time power that was still left.
    function test_TS069_PartialAndRedeposit() public {
        _deposit(alice, 100e18);
        _deposit(bob,   100e18);
        uint256 id = gov.createProposal("p", "d");
        vm.warp(block.timestamp + 1);
        _withdraw(alice, 30e18);
        _withdraw(alice, 30e18);
        assertEq(_base(id), 140e18);
        _deposit(alice, 100e18);
        _withdraw(alice, 100e18);            // only 40 of alice's creation power was left
        assertEq(_base(id), 100e18, "bob's 100 remains");
    }

    /// Closed proposals keep their final base.
    function test_TS069_ClosedProposalUntouched() public {
        _deposit(alice, 100e18);
        uint256 id = gov.createProposal("p", "d");
        vm.warp(block.timestamp + 1 days + 3 days + 1);
        _withdraw(alice, 100e18);
        assertEq(_base(id), 100e18);
    }

    // ─── TS-070 ─────────────────────────────────────────────────────────────

    function test_TS070_SecondProposalSameSecondReverts() public {
        gov.createProposal("p1", "d");
        vm.expectRevert(TimbGovernance.ProposalSameSecond.selector);
        gov.createProposal("p2", "d");
        vm.warp(block.timestamp + 1);
        gov.createProposal("p2", "d");
        assertEq(gov.proposalCount(), 2);
    }

    /// The reported sequence: P1, a withdraw in the same second, P2 in the
    /// same second. P2 now has to wait a second, and then reads the withdrawal
    /// on both sides, so a redeposit cannot vote above the base.
    function test_TS070_ReportedSequenceClosed() public {
        _deposit(alice, 100e18);
        _deposit(bob,   100e18);
        gov.createProposal("p1", "d");
        _withdraw(alice, 100e18);            // same second as p1 (sealed to t+1)
        vm.expectRevert(TimbGovernance.ProposalSameSecond.selector);
        gov.createProposal("p2", "d");

        vm.warp(block.timestamp + 1);
        uint256 p2 = gov.createProposal("p2", "d");
        assertEq(_base(p2), 100e18);
        assertEq(gov.votingPowerAt(alice, block.timestamp), 0, "alice's withdrawal is in p2's snapshot");

        _deposit(alice, 100e18);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(alice);
        vm.expectRevert(TimbGovernance.InsufficientVotingPower.selector);
        gov.castVote(p2, true);
    }
}
