// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title PrizeEscrow
 * @notice Holds all prize ETH for the TimbSwap prize game.
 *         Pays winners exclusively on instruction from TimbPrize.
 *
 * Design:
 *   - Single responsibility: hold ETH, pay on authorised instruction.
 *   - Only TimbPrize can call pay(). No other address can move funds.
 *   - Owner and TimbTreasury can deposit ETH (seeding + fee routing).
 *   - Balance is always queryable — feeds the prize pot display.
 *   - No accounting logic — TimbPrize owns the accounting layer.
 *
 * Security:
 *   - ReentrancyGuard on pay() and emergencyWithdraw().
 *   - Only TimbPrize can instruct payouts, and only TimbPrize can deposit
 *     (deposit() and receive()), so every wei held is credited to the pot.
 *   - Emergency withdrawal restricted to owner only.
 *   - ETH transfer uses call{value} with success check.
 *   - ETH only — no ERC-20 tokens.
 *
 * Deployment:
 *   1. Deploy PrizeEscrow()
 *   2. Deploy TimbPrize(prizeEscrow, ...)
 *   3. setTimbPrize(timbPrize)
 *   4. Fund the pot via TimbPrize.fundPot() / addToPot() (never directly)
 *   5. Verify on Sourcify
 */
contract PrizeEscrow is Ownable2Step, ReentrancyGuard {

    // ─── State ───────────────────────────────────────────────────────────────

    /// @notice TimbPrize — the live game: may deposit() and pay().
    address public timbPrize;

    /// @notice Retired TimbPrize contracts that may still pay() but never
    ///         deposit (TS-018). Repointing the escrow at a new game used to
    ///         cut the old game off mid-claim-window, so its unclaimed winners
    ///         (and its protocol-cut withdrawal) reverted NotTimbPrize until
    ///         the owner intervened. setTimbPrize now retires the outgoing
    ///         prize automatically; the owner revokes it once the old claim
    ///         windows have closed.
    mapping(address => bool) public retiredPrize;

    // ─── Events ──────────────────────────────────────────────────────────────

    event WinnerPaid(address indexed winner, uint256 amount, uint256 indexed round);
    event Deposited(address indexed from, uint256 amount);
    event TimbPrizeSet(address indexed timbPrize);
    event RetiredPrizeSet(address indexed prize, bool allowed);
    event EmergencyWithdrawn(address indexed to, uint256 amount);
    event ERC20Recovered(address indexed token, address indexed to, uint256 amount);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error NotTimbPrize();
    error InsufficientBalance(uint256 requested, uint256 available);
    error TransferFailed();

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor() Ownable(msg.sender) {}

    // ─── Payout ───────────────────────────────────────────────────────────────

    /**
     * @notice Pay a winner. Only callable by TimbPrize.
     * @param to     Winner address.
     * @param amount ETH amount in wei.
     * @param round  Round number for event indexing.
     */
    function pay(address to, uint256 amount, uint256 round)
        external
        nonReentrant
    {
        if (msg.sender != timbPrize && !retiredPrize[msg.sender]) revert NotTimbPrize();
        if (to == address(0))               revert ZeroAddress();
        if (amount == 0)                    revert ZeroAmount();
        if (amount > address(this).balance) {
            revert InsufficientBalance(amount, address(this).balance);
        }

        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit WinnerPaid(to, amount, round);
    }

    // ─── Deposit ──────────────────────────────────────────────────────────────

    /**
     * @notice Deposit ETH into the prize pool. Only callable by TimbPrize.
     * @dev Every pot source (fundPot, addToPot, yield harvest, the registry
     *      lapse share, the faucet pot share, TimbTreasury.distributeToPot)
     *      goes through TimbPrize, which credits currentAccumulatedRewards
     *      before depositing here. ETH arriving any other way would sit
     *      outside that counter and could never reach a winner (TS-006), so
     *      it is refused. To top up the pot, call TimbPrize.addToPot.
     */
    function deposit() external payable {
        if (msg.sender != timbPrize) revert NotTimbPrize();
        if (msg.value == 0) revert ZeroAmount();
        emit Deposited(msg.sender, msg.value);
    }

    // ─── Owner: Config ────────────────────────────────────────────────────────

    /**
     * @notice Set the live TimbPrize. The outgoing prize is retired, not cut
     *         off: it keeps pay() so its in-flight winners can still claim
     *         (TS-018). Revoke it with setRetiredPrize once its windows close.
     */
    function setTimbPrize(address _timbPrize) external onlyOwner {
        if (_timbPrize == address(0)) revert ZeroAddress();
        address old = timbPrize;
        if (old != address(0) && old != _timbPrize) {
            retiredPrize[old] = true;
            emit RetiredPrizeSet(old, true);
        }
        if (retiredPrize[_timbPrize]) {
            retiredPrize[_timbPrize] = false; // repointed back: live again
            emit RetiredPrizeSet(_timbPrize, false);
        }
        timbPrize = _timbPrize;
        emit TimbPrizeSet(_timbPrize);
    }

    /// @notice Grant or revoke a retired prize's pay() right (TS-018).
    function setRetiredPrize(address prize, bool allowed) external onlyOwner {
        if (prize == address(0)) revert ZeroAddress();
        retiredPrize[prize] = allowed;
        emit RetiredPrizeSet(prize, allowed);
    }

    /**
     * @notice Emergency withdrawal — owner only. Last resort.
     */
    function emergencyWithdraw(address to, uint256 amount)
        external
        nonReentrant
        onlyOwner
    {
        if (to == address(0))               revert ZeroAddress();
        if (amount == 0)                    revert ZeroAmount();
        if (amount > address(this).balance) {
            revert InsufficientBalance(amount, address(this).balance);
        }
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit EmergencyWithdrawn(to, amount);
    }

    // ─── View ─────────────────────────────────────────────────────────────────

    /**
     * @notice Current ETH balance held in escrow.
     */
    function balance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @dev Plain ETH transfers are refused for the same reason as direct
    ///      deposit() calls: they would never be credited to the pot. Only
    ///      TimbPrize may send (it uses deposit(); this is a backstop).
    receive() external payable {
        if (msg.sender != timbPrize) revert NotTimbPrize();
        if (msg.value > 0) emit Deposited(msg.sender, msg.value);
    }

    /// @notice Sweep a stray ERC-20 (for example WETH sent instead of ETH).
    ///         This contract never custodies a token, so any ERC-20 balance
    ///         here is a mistake. ERC-20 only: ETH keeps its own, bounded exit.
    function recoverERC20(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        SafeERC20.safeTransfer(IERC20(token), to, amount);
        emit ERC20Recovered(token, to, amount);
    }
}
