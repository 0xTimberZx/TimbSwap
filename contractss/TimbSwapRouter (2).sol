// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// @dev: Compiled with Solidity 0.8.24 and viaIR enabled

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
using SafeERC20 for IERC20;

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface IFactory {
    function getPairAddress(address, address) external view returns (address);
    function feeTo() external view returns (address);
}

interface IPair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256, uint256, address) external;
    function mint(address) external returns (uint256);
    function burn(address) external returns (uint256, uint256);
    function token0() external view returns (address);
}

interface IEligibleTokenRegistry {
    function isEligible(address token) external view returns (bool);
}

interface ITimbPrize {
    function nudgeScroll() external;
    function isSettlementWindow() external view returns (bool);
}

// ─── Contract ────────────────────────────────────────────────────────────────

/**
 * @title TimbSwapRouter
 * @notice Routes swaps and liquidity through TimbSwap AMM pairs.
 */
contract TimbSwapRouter is Ownable, ReentrancyGuard {
    
    // ─── Immutables ──────────────────────────────────────────────────────────

    address public immutable factory;

    // ─── State ───────────────────────────────────────────────────────────────

    address public treasury;
    address public eligibleRegistry;
    address public timbPrize;
    bool    public paused;

    // ─── Constants ───────────────────────────────────────────────────────────

    uint256 public constant PROTOCOL_FEE_BPS = 5;
    uint256 public constant BPS_DENOMINATOR  = 10_000;

    // ─── Events ──────────────────────────────────────────────────────────────

    event SwapExecuted(address sender, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, address to);
    event LiquidityAdded(address indexed pair, address indexed provider, uint256 amountA, uint256 amountB, uint256 liquidity);
    event LiquidityRemoved(address indexed pair, address indexed provider, uint256 amountA, uint256 amountB, uint256 liquidity);
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
    error ZeroAmount();

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

    constructor(
        address _factory,
        address _treasury,
        address _eligibleRegistry,
        address _timbPrize
    ) Ownable(msg.sender) {
        if (_factory  == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        factory          = _factory;
        treasury         = _treasury;
        eligibleRegistry = _eligibleRegistry;
        timbPrize        = _timbPrize;
    }

    // ─── Owner Config ─────────────────────────────────────────────────────────

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }

    function setEligibleRegistry(address _r) external onlyOwner {
        eligibleRegistry = _r;
        emit EligibleRegistrySet(_r);
    }

    function setTimbPrize(address _p) external onlyOwner {
        timbPrize = _p;
        emit TimbPrizeSet(_p);
    }

    function pause()   external onlyOwner { paused = true;  emit Paused(msg.sender); }
    function unpause() external onlyOwner { paused = false; emit Unpaused(msg.sender); }

    // ─── Internal: Pair Helpers ───────────────────────────────────────────────

    function _getPair(address tokenA, address tokenB)
        internal view returns (address pair)
    {
        pair = IFactory(factory).getPairAddress(tokenA, tokenB);
        if (pair == address(0)) revert PairNotFound(tokenA, tokenB);
    }

    function _getReserves(address pair, address tokenA)
        internal view returns (uint256 reserveA, uint256 reserveB)
    {
        (uint112 r0, uint112 r1,) = IPair(pair).getReserves();
        (reserveA, reserveB) = tokenA == IPair(pair).token0()
            ? (uint256(r0), uint256(r1))
            : (uint256(r1), uint256(r0));
    }

    // ─── Internal: Math ───────────────────────────────────────────────────────

    function _getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) internal pure returns (uint256) {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0) revert ZeroAmount();
        uint256 fee = amountIn * 997;
        return (fee * reserveOut) / (reserveIn * 1_000 + fee);
    }

    function _getAmountIn(
        uint256 amountOut,
        uint256 reserveIn,
        uint256 reserveOut
    ) internal pure returns (uint256) {
        if (amountOut == 0 || reserveIn == 0 || reserveOut == 0) revert ZeroAmount();
        return (reserveIn * amountOut * 1_000) / ((reserveOut - amountOut) * 997) + 1;
    }

    function _quote(uint256 amountA, uint256 reserveA, uint256 reserveB)
        internal pure returns (uint256)
    {
        if (amountA == 0 || reserveA == 0 || reserveB == 0) revert ZeroAmount();
        return (amountA * reserveB) / reserveA;
    }

    // ─── Internal: Protocol Fee ───────────────────────────────────────────────

    function _collectProtocolFee(address token, uint256 amountIn) internal {
        uint256 fee = (amountIn * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
        if (fee > 0 && treasury != address(0)) {
            IERC20(token).safeTransferFrom(msg.sender, treasury, fee);
            emit ProtocolFeeSent(treasury, token, fee);
        }
    }

    // ─── Internal: Prize Nudge ────────────────────────────────────────────────

    function _maybeNudge(address tokenIn, bool influencePrize) internal {
        if (!influencePrize)                return;
        if (timbPrize == address(0))        return;
        if (eligibleRegistry == address(0)) return;
        try IEligibleTokenRegistry(eligibleRegistry).isEligible(tokenIn)
            returns (bool ok) { if (!ok) return; } catch { return; }
        try ITimbPrize(timbPrize).isSettlementWindow()
            returns (bool win) { if (win) return; } catch { return; }
        try ITimbPrize(timbPrize).nudgeScroll() {
            emit ScrollNudged(msg.sender, tokenIn);
        } catch {}
    }

    // ─── Internal: Swap Direction ─────────────────────────────────────────────

    function _swapOnPair(address pair, address tokenIn, uint256 amountOut, address to)
        internal
    {
        bool isToken0 = IPair(pair).token0() == tokenIn;
        (uint256 a0, uint256 a1) = isToken0
            ? (uint256(0), amountOut)
            : (amountOut, uint256(0));
        IPair(pair).swap(a0, a1, to);
    }

    // ─── Internal: Swap Execution ────────────────────────────────────────────

    function _executeSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address to,
        bool influencePrize
    ) internal {
        address pair = _getPair(tokenIn, tokenOut);
        IERC20(tokenIn).safeTransferFrom(msg.sender, pair, amountIn);
        _collectProtocolFee(tokenIn, amountIn);
        _swapOnPair(pair, tokenIn, amountOut, to);
        _maybeNudge(tokenIn, influencePrize);
        emit SwapExecuted(msg.sender, tokenIn, tokenOut, amountIn, amountOut, to);
    }

    // ─── View: Quote Helpers ──────────────────────────────────────────────────

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        external pure returns (uint256)
    { return _getAmountOut(amountIn, reserveIn, reserveOut); }

    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        external pure returns (uint256)
    { return _getAmountIn(amountOut, reserveIn, reserveOut); }

    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB)
        external pure returns (uint256)
    { return _quote(amountA, reserveA, reserveB); }

    function getReserves(address tokenA, address tokenB)
        external view returns (uint256 reserveA, uint256 reserveB)
    {
        address pair = IFactory(factory).getPairAddress(tokenA, tokenB);
        if (pair == address(0)) return (0, 0);
        return _getReserves(pair, tokenA);
    }

    // ─── Swap: Exact In ───────────────────────────────────────────────────────

    /**
     * @notice Swap an exact amount of tokenIn for as much tokenOut as possible.
     * @param amountIn       Exact input amount.
     * @param amountOutMin   Minimum output (slippage protection).
     * @param tokenIn        Token being sold.
     * @param tokenOut       Token being bought.
     * @param to             Recipient of output tokens.
     * @param deadline       Unix timestamp.
     * @param influencePrize If true, nudge prize scroll after swap.
     * @return amountOut     Actual output received.
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
        if (amountIn == 0)    revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();

        (uint256 reserveIn, uint256 reserveOut) = _getReserves(_getPair(tokenIn, tokenOut), tokenIn);
        amountOut = _getAmountOut(amountIn, reserveIn, reserveOut);

        if (amountOut < amountOutMin)
            revert InsufficientOutputAmount(amountOut, amountOutMin);

        _executeSwap(tokenIn, tokenOut, amountIn, amountOut, to, influencePrize);
    }

    // ─── Swap: Exact Out ──────────────────────────────────────────────────────

    /**
     * @notice Swap as little tokenIn as possible for an exact tokenOut amount.
     * @param amountOut      Exact output desired.
     * @param amountInMax    Maximum input (slippage protection).
     * @param tokenIn        Token being sold.
     * @param tokenOut       Token being bought.
     * @param to             Recipient of output tokens.
     * @param deadline       Unix timestamp.
     * @param influencePrize If true, nudge prize scroll after swap.
     * @return amountIn      Actual input spent.
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

        (uint256 reserveIn, uint256 reserveOut) = _getReserves(_getPair(tokenIn, tokenOut), tokenIn);
        amountIn = _getAmountIn(amountOut, reserveIn, reserveOut);

        if (amountIn > amountInMax) revert ExcessiveInputAmount();

        _executeSwap(tokenIn, tokenOut, amountIn, amountOut, to, influencePrize);
    }
}
