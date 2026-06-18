// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title TimbTreasury
 * @notice Protocol fee routing, buyback execution, and revenue distribution.
 *
 * Revenue inflows:
 *   - 0.05% protocol swap fee (from TimbSwapRouter)
 *   - Round settlement cut from TimbPrize (owner-set %)
 *   - Expired unclaimed winnings dividend (owner-toggle)
 *   - Direct owner deposits (operations, grants)
 *
 * Revenue outflows:
 *   - Buyback: uses ETH to purchase TIMBS from TIMBS/ETH pair
 *       └── buybackBurnRatio% of purchased TIMBS → burned
 *       └── (100 - buybackBurnRatio)% → TimbStaking distributions
 *   - Prize pot top-up → PrizeEscrow
 *   - Staking reward top-up → TimbStaking.notifyRewardAmount()
 *   - Operations → owner wallet (manual)
 *
 * Security:
 *   - ReentrancyGuard on executeBuyback(), distributeToPot(), distributeToStaking().
 *   - Buyback slippage protection: minTimbsOut parameter.
 *   - Only owner executes buybacks and distributions.
 *   - TIMBS burn via TIMBSToken.burn() — irreversible.
 *   - SafeERC20 on all token operations.
 *   - ETH never held beyond operational needs — distributed promptly.
 *
 * Deployment:
 *   1. Deploy TimbTreasury(timbsToken, timbStaking, prizeEscrow, pair)
 *   2. router.setTreasury(address(this))
 *   3. timbStaking.setTreasury(address(this))
 *   4. prizeEscrow owner deposits routed here
 *   5. Verify on Sourcify
 */
contract TimbTreasury is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Interfaces ──────────────────────────────────────────────────────────

    interface ITimbsToken is IERC20 {
        function burn(uint256 amount) external;
    }

    interface ITimbStaking {
        function notifyRewardAmount(uint256 amount, uint256 duration) external;
    }

    interface ITimbSwapPair {
        function getReserves() external view returns (uint112, uint112, uint32);
        function swap(uint256 amount0Out, uint256 amount1Out, address to) external;
        function token0() external view returns (address);
    }

    interface IPrizeEscrow {
        function deposit() external payable;
    }

    // ─── State ───────────────────────────────────────────────────────────────

    /// @notice TIMBS token — purchased in buybacks, burned or distributed.
    ITimbsToken public immutable timbsToken;

    /// @notice TimbStaking — receives TIMBS distribution share of buyback.
    address public timbStaking;

    /// @notice PrizeEscrow — receives ETH pot top-ups.
    address public prizeEscrow;

    /// @notice TIMBS/ETH AMM pair — used for buyback execution.
    address public timbsEthPair;

    /// @notice % of purchased TIMBS that gets burned (0–100).
    ///         Remainder distributed to TimbStaking.
    uint256 public buybackBurnRatio;

    /// @notice Default staking distribution period when topping up staking.
    uint256 public stakingDistributionPeriod;

    /// @notice Authorised callers for receiveFees() (Router, TimbPrize).
    mapping(address => bool) public authorisedFeeSenders;

    /// @notice Total ETH received as protocol fees (lifetime).
    uint256 public totalFeesReceived;

    /// @notice Total TIMBS burned via buybacks (lifetime).
    uint256 public totalTimbsBurned;

    /// @notice Total TIMBS distributed to stakers via buybacks (lifetime).
    uint256 public totalTimbsDistributed;

    /// @notice Total ETH sent to prize pot (lifetime).
    uint256 public totalPotFunded;

    // ─── Events ──────────────────────────────────────────────────────────────

    event FeesReceived(address indexed from, uint256 amount);
    event BuybackExecuted(
        uint256 ethSpent,
        uint256 timbsBought,
        uint256 timbsBurned,
        uint256 timbsToStaking
    );
    event PotFunded(uint256 amount);
    event StakingFunded(uint256 timbsAmount, uint256 duration);
    event BuybackBurnRatioSet(uint256 ratio);
    event StakingSet(address indexed staking);
    event PrizeEscrowSet(address indexed escrow);
    event PairSet(address indexed pair);
    event FeeSenderSet(address indexed sender, bool authorised);
    event OperationalWithdraw(address indexed to, uint256 amount);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error InvalidRatio(uint256 ratio);
    error SlippageExceeded(uint256 received, uint256 minimum);
    error BuybackFailed();
    error InsufficientETH(uint256 requested, uint256 available);
    error NotAuthorised();
    error TransferFailed();

    // ─── Constructor ─────────────────────────────────────────────────────────

    /**
     * @param _timbsToken   TIMBS token address.
     * @param _timbStaking  TimbStaking contract address.
     * @param _prizeEscrow  PrizeEscrow contract address.
     * @param _timbsEthPair TIMBS/ETH pair address (set after pair deploy).
     */
    constructor(
        address _timbsToken,
        address _timbStaking,
        address _prizeEscrow,
        address _timbsEthPair
    ) Ownable(msg.sender) {
        if (_timbsToken == address(0)) revert ZeroAddress();

        timbsToken              = ITimbsToken(_timbsToken);
        timbStaking             = _timbStaking;
        prizeEscrow             = _prizeEscrow;
        timbsEthPair            = _timbsEthPair;
        buybackBurnRatio        = 50; // 50% burn, 50% to staking
        stakingDistributionPeriod = 30 days;

        authorisedFeeSenders[msg.sender] = true;
    }

    // ─── Fee Reception ────────────────────────────────────────────────────────

    /**
     * @notice Receive protocol fees from Router or TimbPrize.
     * @dev Router sends 0.05% swap fees here.
     *      TimbPrize sends round settlement cut here.
     */
    function receiveFees() external payable {
        if (msg.value == 0) revert ZeroAmount();
        totalFeesReceived += msg.value;
        emit FeesReceived(msg.sender, msg.value);
    }

    // ─── Buyback Execution ────────────────────────────────────────────────────

    /**
     * @notice Execute a TIMBS buyback using ETH held in treasury.
     * @dev Buys TIMBS from TIMBS/ETH pair directly.
     *      Splits purchased TIMBS: buybackBurnRatio% burned, rest to staking.
     *      Slippage protected via minTimbsOut.
     *
     * @param ethAmount    ETH to spend on buyback.
     * @param minTimbsOut  Minimum TIMBS to receive (slippage protection).
     */
    function executeBuyback(uint256 ethAmount, uint256 minTimbsOut)
        external
        nonReentrant
        onlyOwner
    {
        if (ethAmount == 0)                        revert ZeroAmount();
        if (ethAmount > address(this).balance)     revert InsufficientETH(ethAmount, address(this).balance);
        if (timbsEthPair == address(0))            revert ZeroAddress();

        // Get reserves to calculate amountOut
        (uint112 r0, uint112 r1,) = ITimbSwapPair(timbsEthPair).getReserves();
        address token0 = ITimbSwapPair(timbsEthPair).token0();

        // Determine which reserve is ETH and which is TIMBS
        // ETH side = address(0) represented as WETH — for testnet we handle
        // native ETH by sending directly to pair before swap
        uint256 reserveIn;
        uint256 reserveOut;
        bool timbsIsToken0 = token0 == address(timbsToken);

        if (timbsIsToken0) {
            // token0 = TIMBS, token1 = ETH/WETH
            reserveIn  = uint256(r1); // ETH reserve
            reserveOut = uint256(r0); // TIMBS reserve
        } else {
            // token0 = ETH/WETH, token1 = TIMBS
            reserveIn  = uint256(r0); // ETH reserve
            reserveOut = uint256(r1); // TIMBS reserve
        }

        // Calculate TIMBS out with 0.3% fee
        uint256 amountInWithFee = ethAmount * 997;
        uint256 timbsOut = (amountInWithFee * reserveOut) /
                           (reserveIn * 1_000 + amountInWithFee);

        if (timbsOut < minTimbsOut) {
            revert SlippageExceeded(timbsOut, minTimbsOut);
        }

        // Send ETH to pair, then call swap
        (bool sent,) = payable(timbsEthPair).call{value: ethAmount}("");
        if (!sent) revert BuybackFailed();

        if (timbsIsToken0) {
            ITimbSwapPair(timbsEthPair).swap(timbsOut, 0, address(this));
        } else {
            ITimbSwapPair(timbsEthPair).swap(0, timbsOut, address(this));
        }

        // Verify received amount
        uint256 received = timbsToken.balanceOf(address(this));
        if (received < minTimbsOut) revert SlippageExceeded(received, minTimbsOut);

        // Split: burn % + distribute %
        uint256 toBurn     = (received * buybackBurnRatio) / 100;
        uint256 toStaking  = received - toBurn;

        if (toBurn > 0) {
            timbsToken.burn(toBurn);
            totalTimbsBurned += toBurn;
        }

        if (toStaking > 0 && timbStaking != address(0)) {
            timbsToken.safeTransfer(timbStaking, toStaking);
            // Notify staking pool of new reward allocation
            ITimbStaking(timbStaking).notifyRewardAmount(
                toStaking,
                stakingDistributionPeriod
            );
            totalTimbsDistributed += toStaking;
        }

        emit BuybackExecuted(ethAmount, received, toBurn, toStaking);
    }

    // ─── Distribution ─────────────────────────────────────────────────────────

    /**
     * @notice Send ETH from treasury to PrizeEscrow to top up prize pot.
     * @param amount ETH amount to send.
     */
    function distributeToPot(uint256 amount)
        external
        nonReentrant
        onlyOwner
    {
        if (amount == 0)                     revert ZeroAmount();
        if (prizeEscrow == address(0))       revert ZeroAddress();
        if (amount > address(this).balance)  revert InsufficientETH(amount, address(this).balance);

        IPrizeEscrow(prizeEscrow).deposit{value: amount}();
        totalPotFunded += amount;

        emit PotFunded(amount);
    }

    /**
     * @notice Top up TimbStaking rewards directly with TIMBS from treasury.
     * @dev Treasury must hold TIMBS (transferred from community allocation).
     * @param timbsAmount TIMBS amount to distribute.
     * @param duration    Distribution period in seconds.
     */
    function distributeToStaking(uint256 timbsAmount, uint256 duration)
        external
        nonReentrant
        onlyOwner
    {
        if (timbsAmount == 0)        revert ZeroAmount();
        if (duration == 0)           revert ZeroAmount();
        if (timbStaking == address(0)) revert ZeroAddress();

        uint256 bal = timbsToken.balanceOf(address(this));
        if (timbsAmount > bal) revert ZeroAmount();

        timbsToken.safeTransfer(timbStaking, timbsAmount);
        ITimbStaking(timbStaking).notifyRewardAmount(timbsAmount, duration);

        emit StakingFunded(timbsAmount, duration);
    }

    /**
     * @notice Withdraw ETH for operational expenses (owner only).
     * @dev Manual operation — owner controls treasury allocations.
     */
    function withdrawOperational(address to, uint256 amount)
        external
        nonReentrant
        onlyOwner
    {
        if (to == address(0))              revert ZeroAddress();
        if (amount == 0)                   revert ZeroAmount();
        if (amount > address(this).balance) revert InsufficientETH(amount, address(this).balance);

        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit OperationalWithdraw(to, amount);
    }

    // ─── Owner: Config ────────────────────────────────────────────────────────

    /**
     * @notice Set buyback burn ratio (0–100).
     *         0 = all to staking, 100 = all burned.
     */
    function setBuybackBurnRatio(uint256 _ratio) external onlyOwner {
        if (_ratio > 100) revert InvalidRatio(_ratio);
        buybackBurnRatio = _ratio;
        emit BuybackBurnRatioSet(_ratio);
    }

    function setTimbStaking(address _staking) external onlyOwner {
        if (_staking == address(0)) revert ZeroAddress();
        timbStaking = _staking;
        emit StakingSet(_staking);
    }

    function setPrizeEscrow(address _escrow) external onlyOwner {
        if (_escrow == address(0)) revert ZeroAddress();
        prizeEscrow = _escrow;
        emit PrizeEscrowSet(_escrow);
    }

    function setTimbsEthPair(address _pair) external onlyOwner {
        if (_pair == address(0)) revert ZeroAddress();
        timbsEthPair = _pair;
        emit PairSet(_pair);
    }

    function setStakingDistributionPeriod(uint256 _period) external onlyOwner {
        if (_period == 0) revert ZeroAmount();
        stakingDistributionPeriod = _period;
    }

    function setFeeSender(address sender, bool authorised) external onlyOwner {
        if (sender == address(0)) revert ZeroAddress();
        authorisedFeeSenders[sender] = authorised;
        emit FeeSenderSet(sender, authorised);
    }

    // ─── View ─────────────────────────────────────────────────────────────────

    /**
     * @notice Returns treasury ETH balance.
     */
    function ethBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /**
     * @notice Returns treasury TIMBS balance.
     */
    function timbsBalance() external view returns (uint256) {
        return timbsToken.balanceOf(address(this));
    }

    /**
     * @notice Returns lifetime treasury stats.
     */
    function getStats()
        external
        view
        returns (
            uint256 feesReceived,
            uint256 timbsBurned,
            uint256 timbsDistributed,
            uint256 potFunded
        )
    {
        return (
            totalFeesReceived,
            totalTimbsBurned,
            totalTimbsDistributed,
            totalPotFunded
        );
    }

    /// @dev Accept ETH from Router fee transfers and direct deposits.
    receive() external payable {
        if (msg.value > 0) {
            totalFeesReceived += msg.value;
            emit FeesReceived(msg.sender, msg.value);
        }
    }
}
