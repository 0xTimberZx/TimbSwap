// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title BoostRewarder
 * @notice Secondary emission stream for a TimbBoostFarm pool — pays ANY
 *         ERC-20 (e.g. WETH) on top of the farm's TIMBS emission.
 *
 * How it plugs in (see TimbBoostFarm's hook system):
 *   - Deploy one rewarder per (pool, token): BoostRewarder(farm, weth, window)
 *   - farm.addPoolHook(pid, rewarder) — the farm now mirrors every
 *     deposit/withdraw/claim/emergency into this contract.
 *   - Fund with notifyRewardAmount(amount); emission self-targets over
 *     emissionWindow, exactly like the farm's TIMBS stream.
 *   - REPLACE the emitted token by removing this hook and adding another
 *     rewarder; ADD another token by attaching a second rewarder (the farm
 *     allows up to MAX_HOOKS_PER_POOL).
 *
 * Mirroring model:
 *   The farm passes `stakedAfter` — the user's authoritative pool balance
 *   after each action — so shares are SYNCED, not delta-tracked. A staker
 *   who was already in the pool before this rewarder attached starts
 *   earning after their next farm interaction (their first sync).
 *
 * Trust model:
 *   Only the farm can sync shares (onlyFarm). The farm's hook calls are
 *   try/catch-guarded on its side, so this contract can never block farm
 *   withdrawals even if misconfigured.
 */
contract BoostRewarder is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── State ───────────────────────────────────────────────────────────────

    /// @notice The TimbBoostFarm allowed to sync shares.
    address public immutable farm;

    /// @notice The secondary reward token (e.g. WETH).
    IERC20 public immutable rewardToken;

    /// @notice Seconds the reserve is aimed over; retargets on claim/top-up.
    uint256 public emissionWindow;

    uint256 public rewardRatePerSecond;
    uint256 public periodFinish;
    uint256 public lastUpdateTime;
    uint256 public accRewardPerShare; // 1e18 fixed point

    /// @notice Reward reserve — received minus paid (stray transfers inert).
    uint256 public rewardReserve;

    /// @notice Accrued-but-unclaimed rewards across all stakers. Emission
    ///         streams against the FREE reserve (reserve − owed); at 99%
    ///         owed the rate retargets to zero and accrual stops until the
    ///         next top-up — accrued rewards always stay payable.
    uint256 public totalOwed;

    /// @notice Accrual halts when totalOwed ≥ 99% of rewardReserve.
    uint256 public constant SOLVENCY_STOP_BPS = 9_900;

    /// @notice Mirrored LP shares. Keyed (pid, user); attach ONE rewarder per
    ///         pool so totalShares stays a single pool's LP units.
    mapping(uint256 => mapping(address => uint256)) public shares;
    uint256 public totalShares;

    mapping(uint256 => mapping(address => uint256)) public rewardDebt;
    mapping(uint256 => mapping(address => uint256)) public pending;

    /// @notice Authorised funders (owner + epoch keeper).
    mapping(address => bool) public rewardNotifiers;

    // ─── Events ──────────────────────────────────────────────────────────────

    event Synced(uint256 indexed pid, address indexed user, uint256 sharesAfter);
    event Claimed(uint256 indexed pid, address indexed user, uint256 amount);
    event RewardNotified(address indexed notifier, uint256 amount, uint256 newRate);
    event RateRetargeted(uint256 reserve, uint256 newRate, uint256 periodFinish);
    event EmissionWindowSet(uint256 windowSeconds);
    event RewardNotifierSet(address indexed notifier, bool authorised);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAmount();
    error ZeroAddress();
    error OnlyFarm();
    error NotAuthorised();
    error NoPendingRewards();
    error InsufficientRewardBalance(uint256 required, uint256 available);

    modifier onlyFarm() {
        if (msg.sender != farm) revert OnlyFarm();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(address _farm, address _rewardToken, uint256 _emissionWindow)
        Ownable(msg.sender)
    {
        if (_farm == address(0) || _rewardToken == address(0)) revert ZeroAddress();
        if (_emissionWindow == 0) revert ZeroAmount();
        farm           = _farm;
        rewardToken    = IERC20(_rewardToken);
        emissionWindow = _emissionWindow;
        rewardNotifiers[msg.sender] = true;
    }

    // ─── Accumulator ─────────────────────────────────────────────────────────

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function _updateAcc() internal {
        uint256 applicable = lastTimeRewardApplicable();
        if (applicable > lastUpdateTime) {
            if (totalShares > 0) {
                uint256 elapsed = applicable - lastUpdateTime;
                uint256 accrued = elapsed * rewardRatePerSecond;
                accRewardPerShare += accrued * 1e18 / totalShares;
                totalOwed += accrued;
            }
            lastUpdateTime = applicable;
        }
    }

    function _snapshot(uint256 pid, address user) internal {
        uint256 s = shares[pid][user];
        if (s > 0) {
            pending[pid][user] += (s * accRewardPerShare / 1e18) - rewardDebt[pid][user];
        }
    }

    // Streams the FREE reserve (reserve − owed); zero rate at ≥99% owed —
    // same solvency rule as TimbBoostFarm, accrued rewards stay payable.
    function _retarget() internal {
        uint256 owedCap = rewardReserve * SOLVENCY_STOP_BPS / 10_000;
        uint256 free    = totalOwed < owedCap ? rewardReserve - totalOwed : 0;
        rewardRatePerSecond = free / emissionWindow;
        periodFinish        = block.timestamp + emissionWindow;
        lastUpdateTime      = block.timestamp;
        emit RateRetargeted(free, rewardRatePerSecond, periodFinish);
    }

    /**
     * @notice Pending secondary rewards for (pid, user) — view.
     */
    function pendingReward(uint256 pid, address user) external view returns (uint256) {
        uint256 acc = accRewardPerShare;
        if (totalShares > 0 && lastTimeRewardApplicable() > lastUpdateTime) {
            uint256 elapsed = lastTimeRewardApplicable() - lastUpdateTime;
            acc += elapsed * rewardRatePerSecond * 1e18 / totalShares;
        }
        return pending[pid][user] + (shares[pid][user] * acc / 1e18) - rewardDebt[pid][user];
    }

    // ─── Farm hook (share sync) ──────────────────────────────────────────────

    /**
     * @notice TimbBoostFarm callback — syncs the user's mirrored shares to
     *         their authoritative post-action balance. Action code unused
     *         here (sync semantics cover all actions uniformly).
     */
    function onBoostAction(
        uint8   /* action */,
        uint256 pid,
        address user,
        uint256 /* amount */,
        uint256 stakedAfter
    ) external onlyFarm {
        _updateAcc();
        _snapshot(pid, user);

        uint256 before = shares[pid][user];
        if (stakedAfter != before) {
            totalShares = totalShares - before + stakedAfter;
            shares[pid][user] = stakedAfter;
        }
        rewardDebt[pid][user] = stakedAfter * accRewardPerShare / 1e18;
        emit Synced(pid, user, stakedAfter);
    }

    // ─── Claim ───────────────────────────────────────────────────────────────

    /**
     * @notice Claim accrued secondary rewards for pool `pid`. Retargets the
     *         emission to the post-claim reserve (same rule as the farm).
     */
    function claim(uint256 pid) external nonReentrant {
        _updateAcc();
        _snapshot(pid, msg.sender);

        uint256 reward = pending[pid][msg.sender];
        if (reward == 0) revert NoPendingRewards();
        if (reward > rewardReserve) {
            revert InsufficientRewardBalance(reward, rewardReserve);
        }

        pending[pid][msg.sender]    = 0;
        rewardDebt[pid][msg.sender] = shares[pid][msg.sender] * accRewardPerShare / 1e18;
        rewardReserve              -= reward;
        totalOwed = totalOwed > reward ? totalOwed - reward : 0;

        _retarget();

        rewardToken.safeTransfer(msg.sender, reward);
        emit Claimed(pid, msg.sender, reward);
    }

    // ─── Funding / config ────────────────────────────────────────────────────

    /**
     * @notice Top up the secondary reward reserve; retargets the rate.
     */
    function notifyRewardAmount(uint256 amount) external nonReentrant {
        if (!rewardNotifiers[msg.sender] && msg.sender != owner()) {
            revert NotAuthorised();
        }
        if (amount == 0) revert ZeroAmount();

        _updateAcc();
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        rewardReserve += amount;
        _retarget();

        emit RewardNotified(msg.sender, amount, rewardRatePerSecond);
    }

    // Re-aims the rate over the new window immediately (see TimbBoostFarm note).
    function setEmissionWindow(uint256 windowSeconds) external onlyOwner {
        if (windowSeconds == 0) revert ZeroAmount();
        _updateAcc();
        emissionWindow = windowSeconds;
        _retarget();
        emit EmissionWindowSet(windowSeconds);
    }

    function setRewardNotifier(address notifier, bool authorised) external onlyOwner {
        if (notifier == address(0)) revert ZeroAddress();
        rewardNotifiers[notifier] = authorised;
        emit RewardNotifierSet(notifier, authorised);
    }

    /**
     * @notice Owner recovers stray tokens; the reward token only above the
     *         tracked reserve.
     */
    function recoverERC20(address token, uint256 amount) external onlyOwner {
        if (token == address(rewardToken)) {
            uint256 recoverable = rewardToken.balanceOf(address(this)) - rewardReserve;
            if (amount > recoverable) {
                revert InsufficientRewardBalance(amount, recoverable);
            }
        }
        IERC20(token).safeTransfer(owner(), amount);
    }
}
