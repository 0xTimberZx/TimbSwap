// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract TimbGovernance is Ownable, ReentrancyGuard {
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
    mapping(address => uint256) public votingPowerDeposited;
    uint256 public totalVotingPower;
    mapping(address => mapping(uint256 => bool)) public hasVoted;
    mapping(address => uint256[]) public voterParticipation;

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
        emit VotingPowerDeposited(msg.sender, amount);
    }

    function withdrawVotingPower(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        address voter = msg.sender;
        if (amount > votingPowerDeposited[voter]) revert InsufficientVotingPower();

        uint256[] storage participated = voterParticipation[voter];
        for (uint256 i = 0; i < participated.length; i++) {
            Proposal storage p = proposals[participated[i]];
            if (_isLocked(p)) revert VotingPowerLocked(p.votingEndsAt);
        }

        votingPowerDeposited[voter] -= amount;
        totalVotingPower -= amount;
        timbsToken.transfer(voter, amount);
        emit VotingPowerWithdrawn(voter, amount);
    }

    function _isLocked(Proposal storage p) internal view returns (bool) {
        ProposalStatus s = p.status;
        if (s == ProposalStatus.Executed || s == ProposalStatus.Failed || s == ProposalStatus.Expired) {
            return false;
        }
        if (block.timestamp <= p.votingEndsAt) return s == ProposalStatus.Active;
        s = _computeOutcome(p);
        if (s == ProposalStatus.Passed && block.timestamp > p.executionDeadline) return false;
        return s == ProposalStatus.Active || s == ProposalStatus.Passed;
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

        emit ProposalCreated(proposalId, msg.sender, title, votingStartsAt, votingEndsAt);
    }

    function castVote(uint256 proposalId, bool support) external nonReentrant {
        Proposal storage p = proposals[proposalId];
        if (p.id == 0) revert ProposalNotFound();
        if (block.timestamp < p.votingStartsAt) revert VotingNotStarted(p.votingStartsAt);
        if (block.timestamp > p.votingEndsAt) revert VotingEnded(p.votingEndsAt);
        if (hasVoted[msg.sender][proposalId]) revert AlreadyVoted();

        uint256 power = votingPowerDeposited[msg.sender];
        if (power == 0) revert InsufficientVotingPower();

        if (support) p.forVotes += power;
        else p.againstVotes += power;

        hasVoted[msg.sender][proposalId] = true;
        voterParticipation[msg.sender].push(proposalId);

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
        uint256 quorumRequired = (p.totalVotingPower * quorumBps) / BPS_DENOMINATOR;
        if (p.totalVotingPower > 0 && totalVotes < quorumRequired) {
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
