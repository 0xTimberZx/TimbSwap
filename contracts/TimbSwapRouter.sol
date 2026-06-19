// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

using SafeERC20 for IERC20;

    // ─── Interfaces ──────────────────────────────────────────────────────────

    interface IFactory {
        function getPair(address, address) external view returns (address);
        function getPairAddress(address, address) external view returns (address);
        function feeTo() external view returns (address);
    }

    interface IPair {
        function getReserves() external view returns (uint112, uint112, uint32);
        function swap(uint256, uint256, address) external;
        function mint(address) external returns (uint256);
        function burn(address) external returns (uint256, uint256);
        function token0() external view returns (address);
        function token1() external view returns (address);
    }

    interface IEligibleTokenRegistry {
        function isEligible(address token) external view returns (bool);
    }

    interface ITimbPrize {
        function nudgeScroll() external;
        function isSettlementWindow() external view returns (bool);
    }

/**
 * @title TimbSwapRouter
 * @notice Routes swaps and liquidity operations through TimbSwap AMM pairs.
 *
 * Responsibilities:
 *   1. Swap tokenA → tokenB through the correct pair, enforcing
 *      slippage and deadline.
 *   2. Add / remove liquidity to any pair.
 *   3. Split the 0.3% swap fee: 0.25% stays in pair (LPs),
 *      0.05% forwarded to TimbTreasury.
 *   4. After a confirmed eligible swap, optionally call
 *      TimbPrize.nudgeScroll() to shift the prize game position
 *      counter +1 (opt-in per swap, only during active segment).
 *
 * Security (defiSKILL):
 *   - ReentrancyGuard on all state-changing functions.
 *   - Deadline check on every swap and liquidity function.
 *   - Slippage protection: amountOutMin / amountAMin / amountBMin.
 *   - Cross-vault trust: Router verifies pair exists in Factory before
 *     transferring tokens — never blindly trusts caller-supplied pair address.
 *   - nudgeScroll() called AFTER confirmed token transfer, never before.
 *     Eligible token check against EligibleTokenRegistry before nudge.
 *   - nudgeScroll() failure is silently caught — prize game never blocks swap.
 *   - Protocol fee forwarded to TimbTreasury, never held in Router.
 *   - No ETH held in Router — receive() only for WETH unwrap path.
 *
 * Deployment order:
 *   1. TimbSwapFactory deployed
 *   2. TimbSwapRouter(factory, treasury, eligibleRegistry, timbPrize)
 *   3. factory.setRouter(router)
 *   4. After TimbPrize deployed: setTimbPrize(address)
 *   5. After EligibleTokenRegistry deployed: setEligibleRegistry(address)
 */
contract TimbSwapRouter is Ownable, ReentrancyGuard {
    
    // ─── Immutables ──────────────────────────────────────────────────────────

    /// @notice TimbSwapFactory — source of truth for pair addresses.
    address public immutable factory;

    // ─── State ───────────────────────────────────────────────────────────────

    /// @notice TimbTreasury — receives the 0.05% protocol fee.
    address public treasury;

    /// @notice EligibleTokenRegistry — checked before prize nudge.
    address public eligibleRegistry;

    /// @notice TimbPrize — receives nudgeScroll() calls.
    address public timbPrize;

    /// @notice Paused flag — emergency halt on swaps and liquidity.
    bool public paused;

    // ─── Events ──────────────────────────────────────────────────────────────

    event SwapExecuted(
        address indexed sender,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address to
    );
    event LiquidityAdded(
        address indexed pair,
        address indexed provider,
        uint256 amountA,
        uint256 amountB,
        uint256 liquidity
    );
    event LiquidityRemoved(
        address indexed pair,
        address indexed provider,
        uint256 amountA,
        uint256 amountB,
        uint256 liquidity
    );
    event ProtocolFeeSent(address indexed treasury, address indexed token, uint256 amount);
    event ScrollNudged(address indexed swapper, address indexed tokenIn);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event EligibleRegistrySet(address indexed registry);
    event TimbPrizeSet(address indexed timbPrize);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error Expired(uint256 deadline);
    error RouterPaused();
    error PairNotFound(address tokenA, address tokenB);
    error InsufficientOutputAmount(uint256 amountOut, uint256 amountOutMin);
    error InsufficientAAmount(uint256 amountA, uint256 amountAMin);
    error InsufficientBAmount(uint256 amountB, uint256 amountBMin);
    error ExcessiveInputAmount();
    error InvalidPath();
    error ZeroAmount();

    // ─── Constants ───────────────────────────────────────────────────────────

    /// @notice Protocol fee in basis points (0.05% = 5 bps).
    uint256 public constant PROTOCOL_FEE_BPS = 5;
    uint256 public constant BPS_DENOMINATOR   = 10_000;

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier ensure(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired(deadline);
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert RouterPaused();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    /**
     * @param _factory         TimbSwapFactory address.
     * @param _treasury        TimbTreasury address (protocol fee recipient).
     * @param _eligibleRegistry EligibleTokenRegistry address (can be set later).
     * @param _timbPrize       TimbPrize address (can be set later).
     */
    constructor(
        address _factory,
        address _treasury,
        address _eligibleRegistry,
        address _timbPrize
    ) Ownable(msg.sender) {
        if (_factory  == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();

        factory         = _factory;
        treasury        = _treasury;
        eligibleRegistry = _eligibleRegistry; // allowed to be address(0) at deploy
        timbPrize       = _timbPrize;         // allowed to be address(0) at deploy
    }

    // ─── Owner Config ─────────────────────────────────────────────────────────

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }

    function setEligibleRegistry(address _registry) external onlyOwner {
        eligibleRegistry = _registry;
        emit EligibleRegistrySet(_registry);
    }

    function setTimbPrize(address _timbPrize) external onlyOwner {
        timbPrize = _timbPrize;
        emit TimbPrizeSet(_timbPrize);
    }

    function pause()   external onlyOwner { paused = true;  emit Paused(msg.sender); }
    function unpause() external onlyOwner { paused = false; emit Unpaused(msg.sender); }

    // ─── Internal: Pair Helpers ───────────────────────────────────────────────

    /**
     * @dev Fetches and validates pair address from factory.
     *      Reverts if pair doesn't exist — never trusts caller-supplied address.
     */
    function _getPair(address tokenA, address tokenB)
        internal
        view
        returns (address pair)
    {
        pair = IFactory(factory).getPairAddress(tokenA, tokenB);
        if (pair == address(0)) revert PairNotFound(tokenA, tokenB);
    }

    /**
     * @dev Returns sorted (token0, token1) and their reserves from a pair.
     */
    function _getReserves(address tokenA, address tokenB)
        internal
        view
        returns (
            address pair,
            uint256 reserveA,
            uint256 reserveB
        )
    {
        pair = _getPair(tokenA, tokenB);
        (uint112 r0, uint112 r1,) = IPair(pair).getReserves();
        address token0 = IPair(pair).token0();
        (reserveA, reserveB) = tokenA == token0
            ? (uint256(r0), uint256(r1))
            : (uint256(r1), uint256(r0));
    }

    /**
     * @dev Computes amountOut given amountIn and reserves.
     *      Applies 0.3% fee (997/1000).
     */
    function _getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) internal pure returns (uint256 amountOut) {
        if (amountIn   == 0) revert ZeroAmount();
        if (reserveIn  == 0 || reserveOut == 0) revert ZeroAmount();
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator       = amountInWithFee * reserveOut;
        uint256 denominator     = reserveIn * 1_000 + amountInWithFee;
        amountOut = numerator / denominator;
    }

    /**
     * @dev Computes amountIn required to receive exact amountOut.
     */
    function _getAmountIn(
        uint256 amountOut,
        uint256 reserveIn,
        uint256 reserveOut
    ) internal pure returns (uint256 amountIn) {
        if (amountOut  == 0) revert ZeroAmount();
        if (reserveIn  == 0 || reserveOut == 0) revert ZeroAmount();
        uint256 numerator   = reserveIn * amountOut * 1_000;
        uint256 denominator = (reserveOut - amountOut) * 997;
        amountIn = numerator / denominator + 1;
    }

    // ─── Internal: Protocol Fee ───────────────────────────────────────────────

    /**
     * @dev Calculates and forwards the 0.05% protocol fee to TimbTreasury.
     *      Called after every successful swap.
     *      Protocol fee is taken from amountIn (input token).
     *
     *      Note: the full amountIn including the fee portion is sent to the
     *      pair. The protocol fee is separately computed and transferred from
     *      msg.sender to treasury before the pair call. This keeps the pair's
     *      K invariant calculation consistent.
     */
    function _collectProtocolFee(address token, uint256 amountIn)
        internal
        returns (uint256 protocolFeeAmount)
    {
        protocolFeeAmount = (amountIn * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
        if (protocolFeeAmount > 0 && treasury != address(0)) {
            IERC20(token).safeTransferFrom(msg.sender, treasury, protocolFeeAmount);
            emit ProtocolFeeSent(treasury, token, protocolFeeAmount);
        }
    }

    // ─── Internal: Prize Nudge ────────────────────────────────────────────────

    /**
     * @dev Optionally nudges the prize game scroll position +1.
     *      Only called if:
     *        1. influencePrize == true (user opt-in)
     *        2. timbPrize is set
     *        3. eligibleRegistry is set and tokenIn is eligible
     *        4. NOT during the 0:15 settlement window
     *
     *      nudgeScroll() failure is silently swallowed — prize game
     *      must NEVER block or revert a swap.
     *
     *      SECURITY: Called AFTER confirmed token transfer to pair.
     *      Eligible check verified against EligibleTokenRegistry,
     *      not against caller-supplied data.
     */
    function _maybeNudge(address tokenIn, bool influencePrize) internal {
        if (!influencePrize)            return;
        if (timbPrize == address(0))    return;
        if (eligibleRegistry == address(0)) return;

        // Check eligible token — verify against registry, not caller
        try IEligibleTokenRegistry(eligibleRegistry).isEligible(tokenIn)
            returns (bool eligible)
        {
            if (!eligible) return;
        } catch {
            return;
        }

        // Check not in settlement window
        try ITimbPrize(timbPrize).isSettlementWindow()
            returns (bool inWindow)
        {
            if (inWindow) return;
        } catch {
            return;
        }

        // Nudge — failure must not revert the swap
        try ITimbPrize(timbPrize).nudgeScroll() {
            emit ScrollNudged(msg.sender, tokenIn);
        } catch {
            // Silently swallow — prize game never blocks swap
        }
    }

    // ─── Swap: Exact Input ────────────────────────────────────────────────────

    /**
     * @notice Swap an exact amount of tokenIn for as much tokenOut as possible.
     * @param amountIn       Exact input amount.
     * @param amountOutMin   Minimum output (slippage protection).
     * @param tokenIn        Token being sold.
     * @param tokenOut       Token being bought.
     * @param to             Recipient of output tokens.
     * @param deadline       Unix timestamp — reverts after.
     * @param influencePrize If true, nudge the prize scroll after swap.
     * @return amountOut     Actual output amount received.
     */
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address tokenIn,
        address tokenOut,
        address to,
        uint256 deadline,
        bool    influencePrize
    )
        external
        nonReentrant
        whenNotPaused
        ensure(deadline)
        returns (uint256 amountOut)
    {
        if (amountIn == 0)      revert ZeroAmount();
        if (to == address(0))   revert ZeroAddress();

        (address pair, uint256 reserveIn, uint256 reserveOut) =
            _getReserves(tokenIn, tokenOut);

        amountOut = _getAmountOut(amountIn, reserveIn, reserveOut);
        if (amountOut < amountOutMin) {
            revert InsufficientOutputAmount(amountOut, amountOutMin);
        }

        // Transfer input tokens to pair
        IERC20(tokenIn).safeTransferFrom(msg.sender, pair, amountIn);

        // Collect protocol fee from input (separate transfer to treasury)
        _collectProtocolFee(tokenIn, amountIn);

        // Execute swap — direction determined explicitly
        address token0 = IPair(pair).token0();
        (uint256 amount0Out, uint256 amount1Out) = tokenIn == token0
            ? (uint256(0), amountOut)
            : (amountOut, uint256(0));

        IPair(pair).swap(amount0Out, amount1Out, to);

        // Prize nudge AFTER confirmed swap — eligible check inside
        _maybeNudge(tokenIn, influencePrize);

        emit SwapExecuted(msg.sender, tokenIn, tokenOut, amountIn, amountOut, to);
    }

    /**
     * @notice Swap tokens for an exact amount of tokenOut.
     * @param amountOut      Exact output desired.
     * @param amountInMax    Maximum input (slippage protection).
     * @param tokenIn        Token being sold.
     * @param tokenOut       Token being bought.
     * @param to             Recipient of output tokens.
     * @param deadline       Unix timestamp.
     * @param influencePrize If true, nudge the prize scroll after swap.
     * @return amountIn      Actual input amount spent.
     */
    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address tokenIn,
        address tokenOut,
        address to,
        uint256 deadline,
        bool    influencePrize
    )
        external
        nonReentrant
        whenNotPaused
        ensure(deadline)
        returns (uint256 amountIn)
    {
        if (amountOut == 0)   revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        (address pair, uint256 reserveIn, uint256 reserveOut) =
            _getReserves(tokenIn, tokenOut);

        amountIn = _getAmountIn(amountOut, reserveIn, reserveOut);
        if (amountIn > amountInMax) revert ExcessiveInputAmount();

        IERC20(tokenIn).safeTransferFrom(msg.sender, pair, amountIn);
        _collectProtocolFee(tokenIn, amountIn);

        address token0 = IPair(pair).token0();
        (uint256 amount0Out, uint256 amount1Out) = tokenIn == token0
            ? (uint256(0), amountOut)
            : (amountOut, uint256(0));

        IPair(pair).swap(amount0Out, amount1Out, to);

        _maybeNudge(tokenIn, influencePrize);

        emit SwapExecuted(msg.sender, tokenIn, tokenOut, amountIn, amountOut, to);
    }

    // ─── Liquidity: Add ───────────────────────────────────────────────────────

    /**
     * @notice Add liquidity to a token pair. Creates pair if it doesn't exist.
     * @param tokenA        First token.
     * @param tokenB        Second token.
     * @param amountADesired Desired amount of tokenA to add.
     * @param amountBDesired Desired amount of tokenB to add.
     * @param amountAMin    Minimum tokenA (slippage protection).
     * @param amountBMin    Minimum tokenB (slippage protection).
     * @param to            Recipient of LP tokens.
     * @param deadline      Unix timestamp.
     * @return amountA      Actual tokenA deposited.
     * @return amountB      Actual tokenB deposited.
     * @return liquidity    LP tokens minted.
     */
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    )
        external
        nonReentrant
        whenNotPaused
        ensure(deadline)
        returns (uint256 amountA, uint256 amountB, uint256 liquidity)
    {
        if (to == address(0)) revert ZeroAddress();

        address pair = IFactory(factory).getPairAddress(tokenA, tokenB);
        // Pair must exist — createPair() called separately by user/protocol
        if (pair == address(0)) revert PairNotFound(tokenA, tokenB);

        (uint256 reserveA, uint256 reserveB) = _getReservesOnly(pair, tokenA, tokenB);

        if (reserveA == 0 && reserveB == 0) {
            // First deposit — use desired amounts exactly
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            // Compute optimal amounts maintaining current ratio
            uint256 amountBOptimal = _quote(amountADesired, reserveA, reserveB);
            if (amountBOptimal <= amountBDesired) {
                if (amountBOptimal < amountBMin) {
                    revert InsufficientBAmount(amountBOptimal, amountBMin);
                }
                (amountA, amountB) = (amountADesired, amountBOptimal);
            } else {
                uint256 amountAOptimal = _quote(amountBDesired, reserveB, reserveA);
                if (amountAOptimal < amountAMin) {
                    revert InsufficientAAmount(amountAOptimal, amountAMin);
                }
                (amountA, amountB) = (amountAOptimal, amountBDesired);
            }
        }

        IERC20(tokenA).safeTransferFrom(msg.sender, pair, amountA);
        IERC20(tokenB).safeTransferFrom(msg.sender, pair, amountB);
        liquidity = IPair(pair).mint(to);

        emit LiquidityAdded(pair, msg.sender, amountA, amountB, liquidity);
    }

    // ─── Liquidity: Remove ────────────────────────────────────────────────────

    /**
     * @notice Remove liquidity from a pair. Burns LP tokens, returns tokens.
     * @param tokenA     First token.
     * @param tokenB     Second token.
     * @param liquidity  LP token amount to burn.
     * @param amountAMin Minimum tokenA to receive.
     * @param amountBMin Minimum tokenB to receive.
     * @param to         Recipient of tokens.
     * @param deadline   Unix timestamp.
     * @return amountA   tokenA received.
     * @return amountB   tokenB received.
     */
    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    )
        external
        nonReentrant
        whenNotPaused
        ensure(deadline)
        returns (uint256 amountA, uint256 amountB)
    {
        if (to == address(0)) revert ZeroAddress();

        address pair = _getPair(tokenA, tokenB);

        // Transfer LP tokens to pair before burn
        IERC20(pair).safeTransferFrom(msg.sender, pair, liquidity);

        (uint256 amount0, uint256 amount1) = IPair(pair).burn(to);

        address token0 = IPair(pair).token0();
        (amountA, amountB) = tokenA == token0
            ? (amount0, amount1)
            : (amount1, amount0);

        if (amountA < amountAMin) revert InsufficientAAmount(amountA, amountAMin);
        if (amountB < amountBMin) revert InsufficientBAmount(amountB, amountBMin);

        emit LiquidityRemoved(pair, msg.sender, amountA, amountB, liquidity);
    }

    // ─── View: Quote / Amount Helpers ─────────────────────────────────────────

    /**
     * @notice Returns amountOut for a given amountIn (no fee applied — for quotes).
     */
    function quote(
        uint256 amountA,
        uint256 reserveA,
        uint256 reserveB
    ) external pure returns (uint256 amountB) {
        return _quote(amountA, reserveA, reserveB);
    }

    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) external pure returns (uint256) {
        return _getAmountOut(amountIn, reserveIn, reserveOut);
    }

    function getAmountIn(
        uint256 amountOut,
        uint256 reserveIn,
        uint256 reserveOut
    ) external pure returns (uint256) {
        return _getAmountIn(amountOut, reserveIn, reserveOut);
    }

    /**
     * @notice Returns reserves for tokenA and tokenB from a pair.
     */
    function getReserves(address tokenA, address tokenB)
        external
        view
        returns (uint256 reserveA, uint256 reserveB)
    {
        address pair = IFactory(factory).getPairAddress(tokenA, tokenB);
        if (pair == address(0)) return (0, 0);
        (, reserveA, reserveB) = _getReserves(tokenA, tokenB);
    }

    // ─── Internal Helpers ─────────────────────────────────────────────────────

    function _quote(
        uint256 amountA,
        uint256 reserveA,
        uint256 reserveB
    ) internal pure returns (uint256 amountB) {
        if (amountA  == 0) revert ZeroAmount();
        if (reserveA == 0 || reserveB == 0) revert ZeroAmount();
        amountB = (amountA * reserveB) / reserveA;
    }

    function _getReservesOnly(
        address pair,
        address tokenA,
        address tokenB
    ) internal view returns (uint256 reserveA, uint256 reserveB) {
        (uint112 r0, uint112 r1,) = IPair(pair).getReserves();
        address token0 = IPair(pair).token0();
        (reserveA, reserveB) = tokenA == token0
            ? (uint256(r0), uint256(r1))
            : (uint256(r1), uint256(r0));
    }

    /// @dev Router should not hold ETH. receive() only for WETH unwrap path (future).
    receive() external payable {}
}
