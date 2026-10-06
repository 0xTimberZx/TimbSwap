// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract TimbGovernance is Ownable2Step, ReentrancyGuard {
    enum ProposalStatus {
        Pending,
        Active,
        Passed,
        Failed,
        Executed,
        Expired
    }

    struct Proposal {
        uint256 id;
        string title;
        string description;
        address proposer;
        uint256 createdAt;
        uint256 votingStartsAt;
        uint256 votingEndsAt;
        uint256 executionDeadline;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 totalVotingPower;
        ProposalStatus status;
        bool executed;
    }

    uint256 public constant MAX_VOTING_PERIOD = 30 days;
    uint256 public constant MIN_VOTING_PERIOD = 1 days;
    uint256 public constant EXECUTION_WINDOW = 7 days;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    IERC20 public immutable timbsToken;
    uint256 public proposalThreshold;
    uint256 public quorumBps;
    uint256 public votingPeriod;
    uint256 public votingDelay;
    uint256 public proposalCount;

    mapping(uint256 => Proposal) public proposals;
    /// @notice Cap on proposals whose voting window is still open (TS-021).
    ///         Keeps withdrawVotingPower's quorum ratchet bounded.
    uint256 public constant MAX_OPEN_PROPOSALS = 16;
    /// @dev Ids of proposals created and not yet past votingEndsAt.
    uint256[] internal _openProposals;
    mapping(address => uint256) public votingPowerDeposited;
    uint256 public totalVotingPower;
    /// @dev TS-034: per-voter deposit history so a vote is weighed by the power
    ///      held when the proposal was CREATED, never by a deposit made after
    ///      it existed. One entry per deposit/withdraw; same-second updates
    ///      overwrite the last entry.
    struct Checkpoint { uint64 at; uint192 power; }
    mapping(address => Checkpoint[]) internal _powerHistory;
    /// @dev TS-040: the second the latest proposal was created in. Any power
    ///      change landing in that same second is checkpointed one second
    ///      later, so a deposit backrun into the creation second cannot read
    ///      as "held at creation".
    uint64 internal _lastProposalAt;
    mapping(address => mapping(uint256 => bool)) public hasVoted;
    /// @notice Append-only history of proposals a voter has voted on. Kept for
    ///         off-chain history; NO LONGER iterated on-chain (M6).
    mapping(address => uint256[]) public voterParticipation;
    /// @notice Per-voter lock high-water (M6): the latest executionDeadline among
    ///         proposals this voter has voted on. withdrawVotingPower checks this
    ///         one value instead of looping over voterParticipation (which grows
    ///         unbounded and could OOG-lock a deposit forever). Conservative: a
    ///         vote on a proposal that later fails still locks until that
    ///         proposal's executionDeadline (at most EXECUTION_WINDOW longer than
    ///         the exact per-proposal check), never less.
    mapping(address => uint256) public votingLockUntil;

    event ProposalCreated(
        uint256 indexed id,
        address indexed proposer,
        string title,
        uint256 votingStartsAt,
        uint256 votingEndsAt
    );
    event VoteCast(
        address indexed voter,
        uint256 indexed proposalId,
        bool support,
        uint256 votingPower
    );
    event ProposalStatusUpdated(uint256 indexed id, ProposalStatus status);
    event ProposalExecuted(uint256 indexed id, address indexed executor);
    event VotingPowerDeposited(address indexed voter, uint256 amount);
    event VotingPowerWithdrawn(address indexed voter, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error BelowThreshold();
    error ProposalNotFound();
    error ProposalNotPassed();
    error AlreadyVoted();
    error VotingNotStarted(uint256 startsAt);
    error VotingEnded(uint256 endedAt);
    error InsufficientVotingPower();
    error VotingPowerLocked(uint256 lockedUntil);
    error ExecutionWindowExpired();
    error AlreadyExecuted();
    error InvalidPeriod();
    error InvalidBps();
    error TooManyOpenProposals();

    constructor(
        address _timbsToken,
        uint256 _proposalThreshold,
        uint256 _quorumBps,
        uint256 _votingPeriod,
        uint256 _votingDelay
    ) Ownable(msg.sender) {
        if (_timbsToken == address(0)) revert ZeroAddress();
        if (_votingPeriod < MIN_VOTING_PERIOD || _votingPeriod > MAX_VOTING_PERIOD) {
            revert InvalidPeriod();
        }
        if (_quorumBps > BPS_DENOMINATOR) revert InvalidBps();

        timbsToken = IERC20(_timbsToken);
        proposalThreshold = _proposalThreshold;
        quorumBps = _quorumBps;
        votingPeriod = _votingPeriod;
        votingDelay = _votingDelay;
    }

    function depositVotingPower(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        timbsToken.transferFrom(msg.sender, address(this), amount);
        votingPowerDeposited[msg.sender] += amount;
        totalVotingPower += amount;
        _checkpoint(msg.sender);
        emit VotingPowerDeposited(msg.sender, amount);
    }

    function withdrawVotingPower(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        address voter = msg.sender;
        if (amount > votingPowerDeposited[voter]) revert InsufficientVotingPower();

        // M6: O(1) lock check. Previously this looped over voterParticipation
        // (append-only, one entry per vote), so a voter with many votes could
        // permanently OOG here and never withdraw. votingLockUntil is the latest
        // executionDeadline among their votes — the point past which none of
        // their proposals can still be locked — so one comparison suffices.
        uint256 lockedUntil = votingLockUntil[voter];
        if (block.timestamp < lockedUntil) revert VotingPowerLocked(lockedUntil);

        votingPowerDeposited[voter] -= amount;
        totalVotingPower -= amount;
        _checkpoint(voter);
        _sweepOpenProposals(true); // TS-021: departed power stops propping quorum
        timbsToken.transfer(voter, amount);
        emit VotingPowerWithdrawn(voter, amount);
    }

    function createProposal(
        string calldata title,
        string calldata description
    ) external onlyOwner returns (uint256 proposalId) {
        if (timbsToken.balanceOf(msg.sender) < proposalThreshold) revert BelowThreshold();

        proposalId = ++proposalCount;
        uint256 votingStartsAt = block.timestamp + votingDelay;
        uint256 votingEndsAt = votingStartsAt + votingPeriod;

        proposals[proposalId] = Proposal({
            id: proposalId,
            title: title,
            description: description,
            proposer: msg.sender,
            createdAt: block.timestamp,
            votingStartsAt: votingStartsAt,
            votingEndsAt: votingEndsAt,
            executionDeadline: votingEndsAt + EXECUTION_WINDOW,
            forVotes: 0,
            againstVotes: 0,
            totalVotingPower: totalVotingPower,
            status: ProposalStatus.Pending,
            executed: false
        });

        _sweepOpenProposals(false);
        if (_openProposals.length >= MAX_OPEN_PROPOSALS) revert TooManyOpenProposals();
        _openProposals.push(proposalId);
        _lastProposalAt = uint64(block.timestamp); // TS-040

        emit ProposalCreated(proposalId, msg.sender, title, votingStartsAt, votingEndsAt);
    }

    /// @dev TS-021: a proposal's quorum base is the LOWEST total voting power
    ///      seen between its creation and the end of its voting window. Power
    ///      that is withdrawn mid-vote no longer props the bar up (a parked
    ///      deposit could otherwise inflate quorum, leave, and still veto), and
    ///      nothing can move the base once voting has ended. Proposals past
    ///      votingEndsAt are dropped from the open list as it is walked.
    function _sweepOpenProposals(bool ratchet) internal {
        uint256 live = totalVotingPower;
        uint256 i = 0;
        while (i < _openProposals.length) {
            Proposal storage p = proposals[_openProposals[i]];
            if (block.timestamp > p.votingEndsAt) {
                _openProposals[i] = _openProposals[_openProposals.length - 1];
                _openProposals.pop();
                continue;
            }
            if (ratchet && live < p.totalVotingPower) p.totalVotingPower = live;
            i++;
        }
    }

    /// @notice Voting power `voter` held at `timestamp` (TS-034). Deposits
    ///         and withdrawals are checkpointed, so this is a binary search.
    function votingPowerAt(address voter, uint256 timestamp) public view returns (uint256) {
        Checkpoint[] storage h = _powerHistory[voter];
        uint256 n = h.length;
        if (n == 0 || h[0].at > timestamp) return 0;
        uint256 lo = 0;
        uint256 hi = n - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (h[mid].at <= timestamp) lo = mid; else hi = mid - 1;
        }
        return h[lo].power;
    }

    function _checkpoint(address voter) internal {
        Checkpoint[] storage h = _powerHistory[voter];
        uint192 power = uint192(votingPowerDeposited[voter]);
        uint256 n = h.length;
        uint64 at = uint64(block.timestamp);
        // TS-040: checkpoints have one-second granularity, so a change mined in
        // the same second as createProposal (a strictly later tx) would
        // otherwise overwrite the creation-second entry and be weighed as
        // held at creation. Seal that second: the change takes effect at the
        // next one. Changes mined before the proposal in the same second
        // still land at `at` and still count, as they should.
        if (at == _lastProposalAt) at += 1;
        if (n > 0 && h[n - 1].at >= at) {
            h[n - 1].power = power;
        } else {
            h.push(Checkpoint({ at: at, power: power }));
        }
    }

    /// @notice Number of proposals currently tracked as open (TS-021).
    function openProposalCount() external view returns (uint256) {
        return _openProposals.length;
    }

    function castVote(uint256 proposalId, bool support) external nonReentrant {
        Proposal storage p = proposals[proposalId];
        if (p.id == 0) revert ProposalNotFound();
        if (block.timestamp < p.votingStartsAt) revert VotingNotStarted(p.votingStartsAt);
        if (block.timestamp > p.votingEndsAt) revert VotingEnded(p.votingEndsAt);
        if (hasVoted[msg.sender][proposalId]) revert AlreadyVoted();

        // TS-034: weigh the vote by the power held at proposal creation. A
        // deposit made after the proposal existed cannot vote on it (the
        // mirror of TS-021, which stops withdrawn power propping quorum).
        uint256 power = votingPowerAt(msg.sender, p.createdAt);
        if (power == 0) revert InsufficientVotingPower();

        if (support) p.forVotes += power;
        else p.againstVotes += power;

        hasVoted[msg.sender][proposalId] = true;
        voterParticipation[msg.sender].push(proposalId);
        // M6: raise the voter's lock high-water to this proposal's execution
        // deadline — the latest time it could still be locked (see _isLocked's
        // old logic: past executionDeadline nothing is locked). One SSTORE per
        // vote replaces the unbounded withdraw-time loop.
        if (p.executionDeadline > votingLockUntil[msg.sender]) {
            votingLockUntil[msg.sender] = p.executionDeadline;
        }

        if (p.status == ProposalStatus.Pending) {
            p.status = ProposalStatus.Active;
            emit ProposalStatusUpdated(proposalId, ProposalStatus.Active);
        }

        emit VoteCast(msg.sender, proposalId, support, power);
    }

    function resolveProposal(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (p.id == 0) revert ProposalNotFound();
        if (block.timestamp <= p.votingEndsAt) revert VotingEnded(p.votingEndsAt);

        ProposalStatus currentStatus = p.status;
        if (currentStatus == ProposalStatus.Executed ||
            currentStatus == ProposalStatus.Failed ||
            currentStatus == ProposalStatus.Expired) {
            return;
        }

        p.status = _computeOutcome(p);
        emit ProposalStatusUpdated(proposalId, p.status);
    }

    function executeProposal(uint256 proposalId) external nonReentrant onlyOwner {
        Proposal storage p = proposals[proposalId];
        if (p.id == 0) revert ProposalNotFound();
        if (p.executed) revert AlreadyExecuted();

        ProposalStatus current = _resolvedStatus(p);
        if (current != ProposalStatus.Passed) revert ProposalNotPassed();
        if (block.timestamp > p.executionDeadline) {
            p.status = ProposalStatus.Expired;
            emit ProposalStatusUpdated(proposalId, ProposalStatus.Expired);
            revert ExecutionWindowExpired();
        }

        p.executed = true;
        p.status = ProposalStatus.Executed;
        emit ProposalExecuted(proposalId, msg.sender);
        emit ProposalStatusUpdated(proposalId, ProposalStatus.Executed);
    }

    function _computeOutcome(Proposal memory p) internal view returns (ProposalStatus) {
        uint256 totalVotes = p.forVotes + p.againstVotes;
        // Low: a proposal whose creation-time voting-power snapshot was zero has
        // no meaningful quorum. The old guard SKIPPED the quorum check in that
        // case, so such a proposal could pass on a trickle of votes deposited
        // after creation. Zero snapshot ⇒ quorum can never be met ⇒ fail.
        if (p.totalVotingPower == 0) return ProposalStatus.Failed;
        uint256 quorumRequired = (p.totalVotingPower * quorumBps) / BPS_DENOMINATOR;
        if (totalVotes < quorumRequired) {
            return ProposalStatus.Failed;
        }
        return p.forVotes > p.againstVotes ? ProposalStatus.Passed : ProposalStatus.Failed;
    }

    function _resolvedStatus(Proposal memory p) internal view returns (ProposalStatus) {
        ProposalStatus currentStatus = p.status;
        if (currentStatus == ProposalStatus.Executed ||
            currentStatus == ProposalStatus.Failed ||
            currentStatus == ProposalStatus.Expired) {
            return currentStatus;
        }
        if (block.timestamp <= p.votingEndsAt) return currentStatus;

        ProposalStatus computed = _computeOutcome(p);
        if (computed == ProposalStatus.Passed && block.timestamp > p.executionDeadline) {
            return ProposalStatus.Expired;
        }
        return computed;
    }

    function setProposalThreshold(uint256 _threshold) external onlyOwner {
        proposalThreshold = _threshold;
    }

    function setQuorumBps(uint256 _bps) external onlyOwner {
        if (_bps > BPS_DENOMINATOR) revert InvalidBps();
        quorumBps = _bps;
    }

    function setVotingPeriod(uint256 _period) external onlyOwner {
        if (_period < MIN_VOTING_PERIOD || _period > MAX_VOTING_PERIOD) revert InvalidPeriod();
        votingPeriod = _period;
    }

    function setVotingDelay(uint256 _delay) external onlyOwner {
        votingDelay = _delay;
    }

    function getProposal(uint256 proposalId)
        external view returns (Proposal memory p, ProposalStatus liveStatus)
    {
        p = proposals[proposalId];
        if (p.id == 0) revert ProposalNotFound();
        liveStatus = _resolvedStatus(p);
    }

    function getVotingPower(address voter) external view returns (uint256) {
        return votingPowerDeposited[voter];
    }

    function quorumReached(uint256 proposalId) external view returns (bool) {
        Proposal storage p = proposals[proposalId];
        if (p.id == 0) return false;
        uint256 totalVotes = p.forVotes + p.againstVotes;
        uint256 quorumRequired = (p.totalVotingPower * quorumBps) / BPS_DENOMINATOR;
        return totalVotes >= quorumRequired;
    }
}
