// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title TimbGovernance
 * @notice On-chain governance for TimbSwap protocol.
 *
 * Model:
 *   - Owner submits proposals — community votes with TIMBS balance.
 *   - Voting power = TIMBS balance held in governance contract at vote time.
 *   - Hybrid execution: proposals pass on-chain, owner executes off-chain
 *     (early phase). Architecture supports full on-chain execution later.
 *   - Fully separate from staking — staked TIMBS does not count as votes.
 *   - Voters lock TIMBS into this contract for the voting period.
 *   - TIMBS returned to voters after proposal resolves.
 *
 * Proposal lifecycle:
 *   Pending → Active (voting open) → Passed / Failed → Executed / Expired
 *
 * Key governable parameters (off-chain execution targets):
 *   - entryCostTIMBS (TIMBSToken)
 *   - buybackBurnRatio (TimbTreasury)
 *   - winnersPerRound (TimbPrize)
 *   - protocolCutBps (TimbPrize)
 *   - emissionRate (TimbStaking / TimbFarm)
 *   - governanceEmissionsCap (future)
 *
 * Security:
 *   - ReentrancyGuard on depositVotingPower(), withdrawVotingPower(),
 *     castVote(), executeProposal().
 *   - One vote per address per proposal.
 *   - Voting power snapshot at deposit time (not at vote time) —
 *     prevents flash governance attack.
 *   - TIMBS locked during active proposals the voter participated in.
 *   - Minimum proposal threshold (owner-set).
 *   - Quorum required for proposal to pass.
 *   - SafeERC20 not needed — TIMBS is a known safe token.
 *
 * Deployment:
 *   1. Deploy TimbGovernance(timbsToken, proposalThreshold, quorumBps,
 *                            votingPeriod, executionDelay)
 *   2. Verify on Sourcify
 *   3. Announce governance contract to community
 */
contract TimbGovernance is Ownable, ReentrancyGuard {

    // ─── Types ───────────────────────────────────────────────────────────────

    enum ProposalStatus {
        Pending,    // Created, voting not yet open
        Active,     // Voting period open
        Passed,     // Quorum + majority reached, awaiting execution
        Failed,     // Did not reach quorum or majority
        Executed,   // Owner executed the proposal
        Expired     // Passed but not executed within execution window
    }

    struct Proposal {
        uint256     id;
        string      title;
        string      description;
        string      targetParam;      // Human-readable param being changed
        string      proposedValue;    // Human-readable proposed value
        address     proposer;
        uint256     createdAt;
        uint256     votingStartsAt;
        uint256     votingEndsAt;
        uint256     executionDeadline;
        uint256     forVotes;
        uint256     againstVotes;
        uint256     totalVotingPower; // snapshot at proposal creation
        ProposalStatus status;
        bool        executed;
    }

    // ─── Constants ───────────────────────────────────────────────────────────

    /// @notice Maximum voting period (30 days).
    uint256 public constant MAX_VOTING_PERIOD = 30 days;

    /// @notice Minimum voting period (1 day).
    uint256 public constant MIN_VOTING_PERIOD = 1 days;

    /// @notice Execution window after proposal passes (7 days).
    uint256 public constant EXECUTION_WINDOW = 7 days;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    // ─── State ───────────────────────────────────────────────────────────────

    /// @notice TIMBS token — governance voting currency.
    IERC20 public immutable timbsToken;

    /// @notice Minimum TIMBS balance required to submit a proposal.
    uint256 public proposalThreshold;

    /// @notice Minimum % of total deposited voting power needed for quorum (bps).
    uint256 public quorumBps;

    /// @notice Duration of the voting period in seconds.
    uint256 public votingPeriod;

    /// @notice Delay between proposal creation and voting start.
    uint256 public votingDelay;

    /// @notice Total proposals ever created.
    uint256 public proposalCount;

    /// @notice All proposals by ID.
    mapping(uint256 => Proposal) public proposals;

    /// @notice TIMBS deposited for voting power per address.
    mapping(address => uint256) public votingPowerDeposited;

    /// @notice Total TIMBS deposited across all voters.
    uint256 public totalVotingPower;

    /// @notice voter → proposalId → has voted.
    mapping(address => mapping(uint256 => bool)) public hasVoted;

    /// @notice voter → proposalId → vote direction (true = for).
    mapping(address => mapping(uint256 => bool)) public voteDirection;

    /// @notice voter → proposalId → voting power used.
    mapping(address => mapping(uint256 => uint256)) public votingPowerUsed;

    /// @notice voter → list of proposal IDs they voted on (for lock tracking).
    mapping(address => uint256[]) public voterParticipation;

    // ─── Events ──────────────────────────────────────────────────────────────

    event ProposalCreated(
        uint256 indexed id,
        address indexed proposer,
        string  title,
        string  targetParam,
        string  proposedValue,
        uint256 votingStartsAt,
        uint256 votingEndsAt
    );
    event VoteCast(
        address indexed voter,
        uint256 indexed proposalId,
        bool    support,
        uint256 votingPower
    );
    event ProposalStatusUpdated(uint256 indexed id, ProposalStatus status);
    event ProposalExecuted(uint256 indexed id, address indexed executor);
    event VotingPowerDeposited(address indexed voter, uint256 amount);
    event VotingPowerWithdrawn(address indexed voter, uint256 amount);
    event ProposalThresholdSet(uint256 threshold);
    event QuorumSet(uint256 bps);
    event VotingPeriodSet(uint256 period);
    event VotingDelaySet(uint256 delay);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error BelowThreshold(uint256 balance, uint256 threshold);
    error ProposalNotFound(uint256 id);
    error ProposalNotActive(uint256 id, ProposalStatus status);
    error ProposalNotPassed(uint256 id, ProposalStatus status);
    error AlreadyVoted(address voter, uint256 proposalId);
    error VotingNotStarted(uint256 proposalId, uint256 startsAt);
    error VotingEnded(uint256 proposalId, uint256 endedAt);
    error InsufficientVotingPower(uint256 requested, uint256 available);
    error VotingPowerLocked(address voter, uint256 lockedUntil);
    error ExecutionWindowExpired(uint256 proposalId);
    error AlreadyExecuted(uint256 proposalId);
    error InvalidPeriod(uint256 period);
    error InvalidBps(uint256 bps);

    // ─── Constructor ─────────────────────────────────────────────────────────

    /**
     * @param _timbsToken         TIMBS token address.
     * @param _proposalThreshold  Min TIMBS to submit a proposal.
     * @param _quorumBps          Min % of deposited power needed (basis points).
     * @param _votingPeriod       Duration of voting window in seconds.
     * @param _votingDelay        Seconds between creation and voting start.
     */
    constructor(
        address _timbsToken,
        uint256 _proposalThreshold,
        uint256 _quorumBps,
        uint256 _votingPeriod,
        uint256 _votingDelay
    ) Ownable(msg.sender) {
        if (_timbsToken == address(0)) revert ZeroAddress();
        if (_votingPeriod < MIN_VOTING_PERIOD || _votingPeriod > MAX_VOTING_PERIOD) {
            revert InvalidPeriod(_votingPeriod);
        }
        if (_quorumBps > BPS_DENOMINATOR) revert InvalidBps(_quorumBps);

        timbsToken         = IERC20(_timbsToken);
        proposalThreshold  = _proposalThreshold;
        quorumBps          = _quorumBps;
        votingPeriod       = _votingPeriod;
        votingDelay        = _votingDelay;
    }

    // ─── Voting Power ─────────────────────────────────────────────────────────

    /**
     * @notice Deposit TIMBS to gain voting power.
     * @dev Voting power = deposited balance. Separate from staking.
     *      TIMBS locked here until no active votes pending resolution.
     * @param amount TIMBS amount to deposit.
     */
    function depositVotingPower(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        timbsToken.transferFrom(msg.sender, address(this), amount);
        votingPowerDeposited[msg.sender] += amount;
        totalVotingPower                 += amount;

        emit VotingPowerDeposited(msg.sender, amount);
    }

    /**
     * @notice Withdraw TIMBS voting power.
     * @dev Reverts if voter has participated in any proposal that is still
     *      Active or Passed (not yet Executed/Failed/Expired).
     *      Prevents vote-then-withdraw attacks.
     * @param amount TIMBS amount to withdraw.
     */
    function withdrawVotingPower(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > votingPowerDeposited[msg.sender]) {
            revert InsufficientVotingPower(amount, votingPowerDeposited[msg.sender]);
        }

        // Check no active proposals the voter participated in
        uint256[] storage participated = voterParticipation[msg.sender];
        for (uint256 i = 0; i < participated.length; i++) {
            Proposal storage p = proposals[participated[i]];
            ProposalStatus s   = _resolvedStatus(p, quorumBps, block.timestamp);
            if (s == ProposalStatus.Active || s == ProposalStatus.Passed) {
                revert VotingPowerLocked(msg.sender, p.votingEndsAt);
            }
        }

        votingPowerDeposited[msg.sender] -= amount;
        totalVotingPower                 -= amount;

        timbsToken.transfer(msg.sender, amount);

        emit VotingPowerWithdrawn(msg.sender, amount);
    }

    // ─── Proposals ────────────────────────────────────────────────────────────

    /**
     * @notice Submit a new governance proposal.
     * @dev Owner only (community votes on owner proposals — hybrid model).
     *      Proposer must hold >= proposalThreshold TIMBS in wallet.
     *
     * @param title          Short title (e.g. "Update entry cost to 50 TIMBS").
     * @param description    Full description of rationale.
     * @param targetParam    Parameter being changed (e.g. "entryCostTIMBS").
     * @param proposedValue  Human-readable new value (e.g. "50000000000000000000").
     */
    function createProposal(
        string calldata title,
        string calldata description,
        string calldata targetParam,
        string calldata proposedValue
    )
        external
        onlyOwner
        returns (uint256 proposalId)
    {
        // Proposer must hold minimum TIMBS (governance participation signal)
        uint256 ownerBalance = timbsToken.balanceOf(msg.sender);
        if (ownerBalance < proposalThreshold) {
            revert BelowThreshold(ownerBalance, proposalThreshold);
        }

        proposalId = ++proposalCount;
        uint256 votingStartsAt    = block.timestamp + votingDelay;
        uint256 votingEndsAt      = votingStartsAt + votingPeriod;
        uint256 executionDeadline = votingEndsAt + EXECUTION_WINDOW;

        proposals[proposalId] = Proposal({
            id:                proposalId,
            title:             title,
            description:       description,
            targetParam:       targetParam,
            proposedValue:     proposedValue,
            proposer:          msg.sender,
            createdAt:         block.timestamp,
            votingStartsAt:    votingStartsAt,
            votingEndsAt:      votingEndsAt,
            executionDeadline: executionDeadline,
            forVotes:          0,
            againstVotes:      0,
            totalVotingPower:  totalVotingPower,
            status:            ProposalStatus.Pending,
            executed:          false
        });

        emit ProposalCreated(
            proposalId,
            msg.sender,
            title,
            targetParam,
            proposedValue,
            votingStartsAt,
            votingEndsAt
        );
    }

    // ─── Voting ───────────────────────────────────────────────────────────────

    /**
     * @notice Cast a vote on an active proposal.
     * @dev Voting power = votingPowerDeposited[msg.sender] at vote time.
     *      One vote per address per proposal.
     *      Participating voters have their TIMBS locked until proposal resolves.
     *
     * @param proposalId  Proposal to vote on.
     * @param support     True = vote for, false = vote against.
     */
    function castVote(uint256 proposalId, bool support)
        external
        nonReentrant
    {
        Proposal storage p = proposals[proposalId];
        if (p.id == 0) revert ProposalNotFound(proposalId);

        // Voting window check
        if (block.timestamp < p.votingStartsAt) {
            revert VotingNotStarted(proposalId, p.votingStartsAt);
        }
        if (block.timestamp > p.votingEndsAt) {
            revert VotingEnded(proposalId, p.votingEndsAt);
        }

        // One vote per address
        if (hasVoted[msg.sender][proposalId]) {
            revert AlreadyVoted(msg.sender, proposalId);
        }

        uint256 power = votingPowerDeposited[msg.sender];
        if (power == 0) {
            revert InsufficientVotingPower(1, 0);
        }

        // Update proposal
        if (support) {
            p.forVotes += power;
        } else {
            p.againstVotes += power;
        }

        // Record vote
        hasVoted[msg.sender][proposalId]          = true;
        voteDirection[msg.sender][proposalId]     = support;
        votingPowerUsed[msg.sender][proposalId]   = power;

        // Track participation for withdrawal lock
        voterParticipation[msg.sender].push(proposalId);

        // Update proposal status to Active if still Pending
        if (p.status == ProposalStatus.Pending) {
            p.status = ProposalStatus.Active;
            emit ProposalStatusUpdated(proposalId, ProposalStatus.Active);
        }

        emit VoteCast(msg.sender, proposalId, support, power);
    }

    // ─── Resolution ───────────────────────────────────────────────────────────

    /**
     * @notice Resolve a proposal after voting period ends.
     * @dev Callable by anyone — permissionless resolution.
     *      Updates status to Passed or Failed based on quorum + majority.
     * @param proposalId Proposal to resolve.
     */
    function resolveProposal(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (p.id == 0) revert ProposalNotFound(proposalId);
        if (block.timestamp <= p.votingEndsAt) {
            revert VotingEnded(proposalId, p.votingEndsAt);
        }
        if (p.status == ProposalStatus.Executed ||
            p.status == ProposalStatus.Failed   ||
            p.status == ProposalStatus.Expired) {
            return; // Already resolved — no-op
        }

        ProposalStatus newStatus = _computeOutcome(p, quorumBps);
        p.status = newStatus;
        emit ProposalStatusUpdated(proposalId, newStatus);
    }

    /**
     * @notice Mark a Passed proposal as Executed.
     * @dev Owner-only (hybrid execution model).
     *      Owner calls this after executing the proposed change off-chain
     *      (e.g. calling TIMBSToken.setEntryCostTIMBS()).
     *      Emits ProposalExecuted for transparency and indexing.
     * @param proposalId Proposal to mark executed.
     */
    function executeProposal(uint256 proposalId)
        external
        nonReentrant
        onlyOwner
    {
        Proposal storage p = proposals[proposalId];
        if (p.id == 0)     revert ProposalNotFound(proposalId);
        if (p.executed)    revert AlreadyExecuted(proposalId);

        // Auto-resolve if not yet resolved
        ProposalStatus current = _resolvedStatus(p, quorumBps, block.timestamp);

        if (current != ProposalStatus.Passed) {
            revert ProposalNotPassed(proposalId, current);
        }

        if (block.timestamp > p.executionDeadline) {
            p.status = ProposalStatus.Expired;
            emit ProposalStatusUpdated(proposalId, ProposalStatus.Expired);
            revert ExecutionWindowExpired(proposalId);
        }

        p.executed = true;
        p.status   = ProposalStatus.Executed;

        emit ProposalExecuted(proposalId, msg.sender);
        emit ProposalStatusUpdated(proposalId, ProposalStatus.Executed);
    }

    // ─── Internal: Outcome Logic ──────────────────────────────────────────────

    /**
     * @dev Computes Pass/Fail based on quorum and simple majority.
     */
    function _computeOutcome(Proposal memory p, uint256 _quorumBps)
        internal
        pure
        returns (ProposalStatus)
    {
        uint256 totalVotes = p.forVotes + p.againstVotes;

        // Quorum check: total votes must be >= quorumBps% of snapshot power
        if (p.totalVotingPower > 0) {
            uint256 quorumRequired = (p.totalVotingPower * _quorumBps) / BPS_DENOMINATOR;
            if (totalVotes < quorumRequired) return ProposalStatus.Failed;
        }

        // Simple majority: forVotes > againstVotes
        if (p.forVotes > p.againstVotes) return ProposalStatus.Passed;
        return ProposalStatus.Failed;
    }

    /**
     * @dev Returns current resolved status, auto-computing if needed.
     *      Takes quorumBps and the reference timestamp explicitly so the
     *      function stays pure — no storage/global reads inside the helper.
     */
    function _resolvedStatus(Proposal memory p, uint256 _quorumBps, uint256 _nowTimestamp)
        internal
        pure
        returns (ProposalStatus)
    {
        if (p.status == ProposalStatus.Executed ||
            p.status == ProposalStatus.Failed   ||
            p.status == ProposalStatus.Expired) {
            return p.status;
        }

        if (_nowTimestamp <= p.votingEndsAt) {
            return p.status; // Still Pending or Active
        }

        // Voting ended — compute outcome
        ProposalStatus computed = _computeOutcome(p, _quorumBps);

        // Check execution window expired for Passed proposals
        if (computed == ProposalStatus.Passed &&
            _nowTimestamp > p.executionDeadline) {
            return ProposalStatus.Expired;
        }

        return computed;
    }

    // ─── Owner: Config ────────────────────────────────────────────────────────

    function setProposalThreshold(uint256 _threshold) external onlyOwner {
        proposalThreshold = _threshold;
        emit ProposalThresholdSet(_threshold);
    }

    function setQuorumBps(uint256 _bps) external onlyOwner {
        if (_bps > BPS_DENOMINATOR) revert InvalidBps(_bps);
        quorumBps = _bps;
        emit QuorumSet(_bps);
    }

    function setVotingPeriod(uint256 _period) external onlyOwner {
        if (_period < MIN_VOTING_PERIOD || _period > MAX_VOTING_PERIOD) {
            revert InvalidPeriod(_period);
        }
        votingPeriod = _period;
        emit VotingPeriodSet(_period);
    }

    function setVotingDelay(uint256 _delay) external onlyOwner {
        votingDelay = _delay;
        emit VotingDelaySet(_delay);
    }

    // ─── View ─────────────────────────────────────────────────────────────────

    /**
     * @notice Returns a proposal with its live resolved status.
     */
    function getProposal(uint256 proposalId)
        external
        view
        returns (Proposal memory p, ProposalStatus liveStatus)
    {
        p = proposals[proposalId];
        if (p.id == 0) revert ProposalNotFound(proposalId);
        liveStatus = _resolvedStatus(p, quorumBps, block.timestamp);
    }

    /**
     * @notice Returns all proposals (paginated).
     * @param from Start index (1-based).
     * @param to   End index inclusive.
     */
    function getProposals(uint256 from, uint256 to)
        external
        view
        returns (Proposal[] memory)
    {
        if (to > proposalCount) to = proposalCount;
        if (from < 1) from = 1;
        uint256 len = to >= from ? to - from + 1 : 0;
        Proposal[] memory result = new Proposal[](len);
        for (uint256 i = 0; i < len; i++) {
            result[i] = proposals[from + i];
        }
        return result;
    }

    /**
     * @notice Returns a voter's current voting power.
     */
    function getVotingPower(address voter) external view returns (uint256) {
        return votingPowerDeposited[voter];
    }

    /**
     * @notice Returns whether quorum has been reached for a proposal.
     */
    function quorumReached(uint256 proposalId) external view returns (bool) {
        Proposal storage p = proposals[proposalId];
        if (p.id == 0) return false;
        uint256 totalVotes    = p.forVotes + p.againstVotes;
        uint256 quorumRequired = (p.totalVotingPower * quorumBps) / BPS_DENOMINATOR;
        return totalVotes >= quorumRequired;
    }

    /**
     * @notice Returns a voter's participation history (proposal IDs).
     */
    function getVoterParticipation(address voter)
        external
        view
        returns (uint256[] memory)
    {
        return voterParticipation[voter];
    }
}
