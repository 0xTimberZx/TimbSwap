// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import {IERC20}          from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20}       from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable}         from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step}    from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title  TimbAirdropDistributor
 * @notice The mainnet (Arbitrum One) sink for the cross-chain TIMB airdrop: an
 *         eligible TESTNET faucet claim is bridged off-chain by the dispatcher,
 *         which calls `distribute()` here to send real TIMB from a pre-funded
 *         float. Eligibility is enforced OFF-CHAIN (a testnet ticket cannot be
 *         read from this chain); this contract's job is the on-chain guarantees
 *         a hot dispatcher key alone can't give:
 *
 *           - **Double-send is impossible.** `claimed[round][recipient]` is a
 *             one-way flag; a second `distribute` for the same (round, recipient)
 *             reverts. Even a buggy dispatcher or a wrong DB cannot pay twice.
 *             TS-047: the round is NOT caller-chosen — `distribute` only accepts
 *             the owner-set `currentRound`, which moves forward one step at a
 *             time via `advanceRound()`. A queue row carrying any other label
 *             reverts instead of opening a fresh flag, so "once per round" means
 *             once per campaign the owner has actually opened.
 *           - **Bounded blast radius.** `totalCap` and `perRoundCap` are hard
 *             ceilings; the float is pre-funded and small. A leaked dispatcher key
 *             can drain at most the remaining cap / balance, not mint or exceed it.
 *             Fund the float and set `perRoundCap` per campaign (below the float)
 *             so the per-round ceiling actually binds before the total one.
 *           - **A fast stop.** `paused` (owner or guardian) halts all sends;
 *             only the owner can lift it (TS-054).
 *
 *         Fixed `amountPerClaim` per recipient — the dispatcher chooses WHO, never
 *         HOW MUCH. Reward is TIMB by design (illiquid pre-LP = a free Sybil
 *         brake); see the private dev-docs/MAINNET_AIRDROP_SPEC.md.
 *
 *         DESIGN STUB — UNAUDITED. Custodies a real TIMB float. Audit before use.
 */
contract TimbAirdropDistributor is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable timbs;

    /// @notice TIMB sent to each recipient per claim (owner-settable; e.g. 1e18).
    uint256 public amountPerClaim;
    /// @notice Cumulative max TIMB this contract may ever distribute.
    uint256 public totalCap;
    /// @notice Max TIMB per round.
    uint256 public perRoundCap;

    uint256 public totalDistributed;
    mapping(uint256 => uint256) public roundDistributed;
    /// @notice TS-047: the only round `distribute` accepts. Starts at 1 and only
    ///         ever moves forward via `advanceRound()`.
    uint256 public currentRound = 1;
    /// @notice One-way: (round, recipient) => already paid. The impossibility of a
    ///         double-send lives here.
    mapping(uint256 => mapping(address => bool)) public claimed;

    /// @notice May call `distribute` (the off-chain dispatcher). owner may too.
    address public dispatcher;
    /// @notice May flip `paused` alongside the owner. address(0) = none.
    address public guardian;
    bool public paused;

    event Distributed(uint256 indexed round, address indexed recipient, uint256 amount);
    event AmountPerClaimSet(uint256 amount);
    event TotalCapSet(uint256 cap);
    event PerRoundCapSet(uint256 cap);
    event DispatcherSet(address indexed dispatcher);
    event GuardianSet(address indexed guardian);
    event PausedSet(bool paused);
    event RoundAdvanced(uint256 round);
    event Recovered(address indexed to, uint256 amount);

    error ZeroAddress();
    error NotDispatcher();
    error NotPauser();
    error UnpauseOwnerOnly();
    error Paused();
    error EmptyBatch();
    error ZeroAmountPerClaim();
    error AlreadyClaimed(uint256 round, address recipient);
    error TotalCapExceeded(uint256 requested, uint256 remaining);
    error RoundCapExceeded(uint256 requested, uint256 remaining);
    error WrongRound(uint256 supplied, uint256 current);

    modifier onlyDispatcher() {
        if (msg.sender != dispatcher && msg.sender != owner()) revert NotDispatcher();
        _;
    }
    modifier onlyPauser() {
        if (msg.sender != guardian && msg.sender != owner()) revert NotPauser();
        _;
    }

    constructor(
        address _timbs,
        uint256 _amountPerClaim,
        uint256 _totalCap,
        uint256 _perRoundCap
    ) Ownable(msg.sender) {
        if (_timbs == address(0)) revert ZeroAddress();
        timbs          = IERC20(_timbs);
        amountPerClaim = _amountPerClaim;
        totalCap       = _totalCap;
        perRoundCap    = _perRoundCap;
        emit AmountPerClaimSet(_amountPerClaim);
        emit TotalCapSet(_totalCap);
        emit PerRoundCapSet(_perRoundCap);
    }

    // ─── Core ────────────────────────────────────────────────────────────────────

    /**
     * @notice Send `amountPerClaim` TIMB to each recipient not yet paid in `round`.
     * @dev `round` must equal `currentRound` (TS-047); it is kept as a parameter
     *      so a queue row labelled with a stale or wrong round reverts rather than
     *      being silently paid under the open one.
     *      All-or-nothing: reverts on the first already-claimed recipient or the
     *      first that would breach a cap, so the dispatcher pre-filters against
     *      `claimed()` + remaining cap and a confirmed tx means EVERY recipient in
     *      the batch was paid exactly once. Recipients must be unique within the
     *      batch (a dup trips AlreadyClaimed on its second occurrence).
     */
    function distribute(address[] calldata recipients, uint256 round)
        external
        nonReentrant
        onlyDispatcher
    {
        if (paused) revert Paused();
        if (round != currentRound) revert WrongRound(round, currentRound);
        uint256 n = recipients.length;
        if (n == 0) revert EmptyBatch();
        uint256 amount = amountPerClaim;
        if (amount == 0) revert ZeroAmountPerClaim();

        uint256 batchTotal = amount * n;

        // Cap headroom for the whole batch up front (cheaper than per-item, and
        // exact because amount is fixed and recipients are unique).
        uint256 remainingTotal = totalCap > totalDistributed ? totalCap - totalDistributed : 0;
        if (batchTotal > remainingTotal) revert TotalCapExceeded(batchTotal, remainingTotal);
        uint256 rd = roundDistributed[round];
        uint256 remainingRound = perRoundCap > rd ? perRoundCap - rd : 0;
        if (batchTotal > remainingRound) revert RoundCapExceeded(batchTotal, remainingRound);

        // Effects: mark all claimed (reverts on a dup / already-claimed).
        for (uint256 i = 0; i < n; i++) {
            address r = recipients[i];
            if (r == address(0)) revert ZeroAddress();
            if (claimed[round][r]) revert AlreadyClaimed(round, r);
            claimed[round][r] = true;
        }
        totalDistributed += batchTotal;
        roundDistributed[round] = rd + batchTotal;

        // Interactions.
        for (uint256 i = 0; i < n; i++) {
            timbs.safeTransfer(recipients[i], amount);
            emit Distributed(round, recipients[i], amount);
        }
    }

    // ─── Views ───────────────────────────────────────────────────────────────────

    function isClaimed(uint256 round, address recipient) external view returns (bool) {
        return claimed[round][recipient];
    }

    /// @notice TIMB still distributable overall and for `round` right now — the
    ///         dispatcher uses these to size a batch so `distribute` won't revert.
    function remaining(uint256 round) external view returns (uint256 total, uint256 forRound) {
        total    = totalCap    > totalDistributed          ? totalCap    - totalDistributed          : 0;
        forRound = perRoundCap > roundDistributed[round]   ? perRoundCap - roundDistributed[round]    : 0;
    }

    // ─── Owner / guardian ──────────────────────────────────────────────────────────

    /// @notice TS-054: the guardian may pause; only the owner (the timelock)
    ///         may unpause, so a leaked guardian key cannot undo a stop.
    function setPaused(bool _paused) external onlyPauser {
        if (!_paused && msg.sender != owner()) revert UnpauseOwnerOnly(); // TS-054
        paused = _paused;
        emit PausedSet(_paused);
    }

    function setAmountPerClaim(uint256 _amount) external onlyOwner {
        amountPerClaim = _amount;
        emit AmountPerClaimSet(_amount);
    }

    function setTotalCap(uint256 _cap) external onlyOwner {
        totalCap = _cap;
        emit TotalCapSet(_cap);
    }

    function setPerRoundCap(uint256 _cap) external onlyOwner {
        perRoundCap = _cap;
        emit PerRoundCapSet(_cap);
    }

    /// @notice TS-047: open the next campaign round. Monotonic, owner-only; the
    ///         dispatcher cannot pick or reuse a label. Size `perRoundCap` for the
    ///         new round before (or right after) advancing.
    function advanceRound() external onlyOwner {
        currentRound += 1;
        emit RoundAdvanced(currentRound);
    }

    function setDispatcher(address _dispatcher) external onlyOwner {
        dispatcher = _dispatcher;
        emit DispatcherSet(_dispatcher);
    }

    function setGuardian(address _guardian) external onlyOwner {
        guardian = _guardian;
        emit GuardianSet(_guardian);
    }

    /// @notice Return unused TIMB float (e.g. to the treasury). The custodied
    ///         budget's exit; does not touch the claimed/cap accounting.
    function recover(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        timbs.safeTransfer(to, amount);
        emit Recovered(to, amount);
    }
}
