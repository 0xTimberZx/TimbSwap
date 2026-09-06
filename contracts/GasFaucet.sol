// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import {IERC20}        from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20}     from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable}       from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step}  from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Treasury ETH source. The faucet is the treasury's rate-limited
///         `operator` (setOperator + setOperatorEthCap), so it may pull ETH via
///         `withdrawOperational` up to the treasury's own per-window cap — a
///         second ceiling on top of this faucet's `ethCap`.
interface ITreasury {
    function withdrawOperational(address to, uint256 amount) external;
}

/// @notice Eligibility oracle. A wallet qualifies iff its single live ticket
///         reads `Active`. Minting that ticket cost gas + escrow, which is the
///         Sybil gate (see dev-docs/FAUCET_SPEC.md §4).
interface IGameRegistry {
    // Mirror of GameRegistry.TicketStatus — order MUST match.
    enum TicketStatus { Pending, Active, Conceded, Ineligible, Cancelled, Closed }
    function activeTicketOf(address wallet) external view returns (uint256);
    function effectiveStatus(uint256 ticketId) external view returns (TicketStatus);
}

/// @notice Prize pot sink — the "pot half" of each claim grows the live round.
interface IPrize {
    function addToPot() external payable;
}

/**
 * @title  GasFaucet
 * @notice Atomic, reserve-backed keep-alive faucet for live players. In ONE
 *         transaction, per eligible claim it:
 *           1. pulls `dripEth + potEth` ETH from the treasury (as its capped
 *              operator),
 *           2. sends `dripEth` to the claimant (their gas) and `potEth` to the
 *              live round via `TimbPrize.addToPot()`,
 *           3. transfers `timbsPerClaim` TIMBS (default 1) to the claimant — the
 *              participation-gated "fair release".
 *
 *         Eligibility (a live `Active` ticket) and a per-wallet cooldown are
 *         enforced ON-CHAIN here, independent of the off-chain gatekeeper — so a
 *         leaked dispatcher key still cannot over-drip or bypass the Sybil gate.
 *
 *         SAFETY CONTROLS (owner / guardian):
 *           - `ethPaused` and `timbsPaused` are INDEPENDENT kill switches. Pause
 *             one leg and the other still dispenses; pause both and claims revert.
 *           - `ethCap` / `timbsCap` are the MAX approved to ever distribute
 *             (cumulative). A claim that would push `*Distributed` past its cap
 *             reverts. Raising a cap "approves" more; lowering it below what's
 *             already gone out simply stops further outflow of that asset.
 *
 *         FUNDING MODEL (asymmetric by treasury design):
 *           - ETH stays in the treasury and is pulled live per claim — the
 *             treasury's operator role permits capped ETH withdrawals.
 *           - TIMBS is PRE-FUNDED into this contract (the owner moves the
 *             approved budget here via `TimbTreasury.withdrawToken`, which is
 *             owner-only by design — the operator role deliberately cannot move
 *             ERC20). The faucet dispenses TIMBS from its own balance and the
 *             owner tops it up. `recoverTimbs` returns any unused budget.
 *
 *         DESIGN STUB — UNAUDITED. Dispenses treasury ETH and custodies a TIMBS
 *         budget. Audit before mainnet.
 */
contract GasFaucet is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Immutable wiring ──────────────────────────────────────────────────────

    ITreasury     public immutable treasury;
    IERC20        public immutable timbs;
    IGameRegistry public immutable registry;
    IPrize        public immutable prize;

    // ─── Dispense parameters (owner-settable) ───────────────────────────────────

    /// @notice ETH sent to the claimant per claim (their gas).
    uint256 public dripEth;
    /// @notice ETH sent to the live round pot per claim.
    uint256 public potEth;
    /// @notice TIMBS sent to the claimant per claim — the fair-release drip.
    uint256 public timbsPerClaim;
    /// @notice Minimum seconds between claims for a given wallet.
    uint256 public cooldown;

    // ─── Independent kill switches ──────────────────────────────────────────────

    /// @notice When true, the ETH legs (drip + pot) are skipped.
    bool public ethPaused;
    /// @notice When true, the TIMBS leg is skipped.
    bool public timbsPaused;

    // ─── Approved-to-distribute ceilings (cumulative) ───────────────────────────

    /// @notice Max total ETH (drip + pot) this faucet may ever distribute.
    uint256 public ethCap;
    /// @notice Max total TIMBS this faucet may ever distribute.
    uint256 public timbsCap;
    /// @notice ETH distributed so far (drip + pot), lifetime.
    uint256 public ethDistributed;
    /// @notice TIMBS distributed so far, lifetime.
    uint256 public timbsDistributed;

    // ─── Access ─────────────────────────────────────────────────────────────────

    /// @notice May trigger `dispense` (the keeper worker). address(0) disables it;
    ///         the owner may always dispense.
    address public dispatcher;
    /// @notice May flip the pause switches (alongside the owner). address(0) = none.
    address public guardian;

    /// @notice Last claim timestamp per wallet (cooldown anchor).
    mapping(address => uint256) public lastClaimAt;

    // ─── Events ─────────────────────────────────────────────────────────────────

    event Dispensed(address indexed claimant, uint256 ethToWallet, uint256 ethToPot, uint256 timbsOut);
    event EthPausedSet(bool paused);
    event TimbsPausedSet(bool paused);
    event EthCapSet(uint256 cap);
    event TimbsCapSet(uint256 cap);
    event ParamsSet(uint256 dripEth, uint256 potEth, uint256 timbsPerClaim, uint256 cooldown);
    event DispatcherSet(address indexed dispatcher);
    event GuardianSet(address indexed guardian);
    event TimbsRecovered(address indexed to, uint256 amount);
    event EthSwept(address indexed to, uint256 amount);

    // ─── Errors ─────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error NotDispatcher();
    error NotPauser();
    error NothingToDispense();     // both legs paused
    error NotEligible(address claimant);
    error CooldownActive(uint256 readyAt);
    error EthCapExceeded(uint256 requested, uint256 remaining);
    error TimbsCapExceeded(uint256 requested, uint256 remaining);
    error InsufficientTimbsBalance(uint256 requested, uint256 held);
    error EthTransferFailed();

    // ─── Modifiers ──────────────────────────────────────────────────────────────

    modifier onlyDispatcher() {
        if (msg.sender != dispatcher && msg.sender != owner()) revert NotDispatcher();
        _;
    }

    modifier onlyPauser() {
        if (msg.sender != guardian && msg.sender != owner()) revert NotPauser();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────────

    /**
     * @param _treasury      TimbTreasury (this faucet must be set as its operator).
     * @param _timbs         TIMBS token.
     * @param _registry      GameRegistry (eligibility oracle).
     * @param _prize         TimbPrize (pot sink).
     * @param _dripEth       ETH to the claimant per claim.
     * @param _potEth        ETH to the pot per claim.
     * @param _timbsPerClaim TIMBS to the claimant per claim (1e18 = 1 TIMB).
     * @param _cooldown      Seconds between claims per wallet (e.g. 24h).
     */
    constructor(
        address _treasury,
        address _timbs,
        address _registry,
        address _prize,
        uint256 _dripEth,
        uint256 _potEth,
        uint256 _timbsPerClaim,
        uint256 _cooldown
    ) Ownable(msg.sender) {
        if (_treasury == address(0) || _timbs == address(0) ||
            _registry == address(0) || _prize == address(0)) revert ZeroAddress();

        treasury = ITreasury(_treasury);
        timbs    = IERC20(_timbs);
        registry = IGameRegistry(_registry);
        prize    = IPrize(_prize);

        dripEth       = _dripEth;
        potEth        = _potEth;
        timbsPerClaim = _timbsPerClaim;
        cooldown      = _cooldown;

        emit ParamsSet(_dripEth, _potEth, _timbsPerClaim, _cooldown);
    }

    // ─── Core: dispense ───────────────────────────────────────────────────────────

    /**
     * @notice Dispense one claim to `claimant` if eligible and off cooldown.
     * @dev Checks-effects-interactions + nonReentrant. Each active leg is gated
     *      by its own pause flag and its own cumulative cap. Cooldown is stamped
     *      once per successful dispense regardless of which legs ran.
     */
    function dispense(address claimant) external nonReentrant onlyDispatcher {
        if (claimant == address(0)) revert ZeroAddress();

        bool doEth   = !ethPaused   && (dripEth + potEth) > 0;
        bool doTimbs = !timbsPaused && timbsPerClaim > 0;
        if (!doEth && !doTimbs) revert NothingToDispense();

        // ── Eligibility (on-chain Sybil gate): a live Active ticket. ──
        uint256 ticketId = registry.activeTicketOf(claimant);
        if (ticketId == 0 ||
            registry.effectiveStatus(ticketId) != IGameRegistry.TicketStatus.Active) {
            revert NotEligible(claimant);
        }

        // ── Cooldown (a never-claimed wallet is always allowed). ──
        uint256 last = lastClaimAt[claimant];
        if (last != 0) {
            uint256 readyAt = last + cooldown;
            if (block.timestamp < readyAt) revert CooldownActive(readyAt);
        }

        uint256 ethOut = doEth ? dripEth + potEth : 0;
        uint256 timbsOut = doTimbs ? timbsPerClaim : 0;

        // ── Cap headroom for the legs that will run. ──
        if (doEth) {
            uint256 remaining = ethCap > ethDistributed ? ethCap - ethDistributed : 0;
            if (ethOut > remaining) revert EthCapExceeded(ethOut, remaining);
        }
        if (doTimbs) {
            uint256 remaining = timbsCap > timbsDistributed ? timbsCap - timbsDistributed : 0;
            if (timbsOut > remaining) revert TimbsCapExceeded(timbsOut, remaining);
            uint256 held = timbs.balanceOf(address(this));
            if (timbsOut > held) revert InsufficientTimbsBalance(timbsOut, held);
        }

        // ── Effects (before any external call). ──
        lastClaimAt[claimant] = block.timestamp;
        if (doEth)   ethDistributed   += ethOut;
        if (doTimbs) timbsDistributed += timbsOut;

        // ── Interactions. ──
        if (doEth) {
            // Pull drip + pot from the treasury (capped operator withdrawal).
            treasury.withdrawOperational(address(this), ethOut);
            if (dripEth > 0) {
                (bool ok, ) = payable(claimant).call{value: dripEth}("");
                if (!ok) revert EthTransferFailed();
            }
            if (potEth > 0) {
                prize.addToPot{value: potEth}();
            }
        }
        if (doTimbs) {
            timbs.safeTransfer(claimant, timbsOut);
        }

        emit Dispensed(claimant, doEth ? dripEth : 0, doEth ? potEth : 0, timbsOut);
    }

    /// @notice True if `claimant` could claim right now (eligible, off cooldown,
    ///         and at least one leg funded + unpaused + under cap). View helper
    ///         for the gatekeeper / frontend; `dispense` re-checks everything.
    function claimable(address claimant) external view returns (bool) {
        if (claimant == address(0)) return false;

        uint256 ticketId = registry.activeTicketOf(claimant);
        if (ticketId == 0 ||
            registry.effectiveStatus(ticketId) != IGameRegistry.TicketStatus.Active) {
            return false;
        }
        uint256 last = lastClaimAt[claimant];
        if (last != 0 && block.timestamp < last + cooldown) return false;

        bool ethOk = !ethPaused && (dripEth + potEth) > 0 &&
            ethDistributed + dripEth + potEth <= ethCap;
        bool timbsOk = !timbsPaused && timbsPerClaim > 0 &&
            timbsDistributed + timbsPerClaim <= timbsCap &&
            timbs.balanceOf(address(this)) >= timbsPerClaim;

        return ethOk || timbsOk;
    }

    // ─── Owner / guardian: pauses ───────────────────────────────────────────────

    function setEthPaused(bool paused) external onlyPauser {
        ethPaused = paused;
        emit EthPausedSet(paused);
    }

    function setTimbsPaused(bool paused) external onlyPauser {
        timbsPaused = paused;
        emit TimbsPausedSet(paused);
    }

    // ─── Owner: approved-to-distribute ceilings ─────────────────────────────────

    /// @notice Set the max total ETH this faucet may ever distribute. Raising it
    ///         approves more; it cannot be read as retroactively clawing back
    ///         what already went out.
    function setEthCap(uint256 cap) external onlyOwner {
        ethCap = cap;
        emit EthCapSet(cap);
    }

    /// @notice Set the max total TIMBS this faucet may ever distribute.
    function setTimbsCap(uint256 cap) external onlyOwner {
        timbsCap = cap;
        emit TimbsCapSet(cap);
    }

    // ─── Owner: parameters ──────────────────────────────────────────────────────

    function setParams(uint256 _dripEth, uint256 _potEth, uint256 _timbsPerClaim, uint256 _cooldown)
        external
        onlyOwner
    {
        dripEth       = _dripEth;
        potEth        = _potEth;
        timbsPerClaim = _timbsPerClaim;
        cooldown      = _cooldown;
        emit ParamsSet(_dripEth, _potEth, _timbsPerClaim, _cooldown);
    }

    // ─── Owner: access wiring ───────────────────────────────────────────────────

    function setDispatcher(address _dispatcher) external onlyOwner {
        dispatcher = _dispatcher;
        emit DispatcherSet(_dispatcher);
    }

    function setGuardian(address _guardian) external onlyOwner {
        guardian = _guardian;
        emit GuardianSet(_guardian);
    }

    // ─── Owner: recovery ────────────────────────────────────────────────────────

    /// @notice Return unused TIMBS budget (e.g. back to the treasury). The
    ///         approved budget is custodied here; this is its exit.
    function recoverTimbs(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        timbs.safeTransfer(to, amount);
        emit TimbsRecovered(to, amount);
    }

    /// @notice Sweep any ETH stranded here (e.g. pot-rounding dust or a failed
    ///         forward). The faucet holds ETH only transiently mid-claim.
    function sweepEth(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert EthTransferFailed();
        emit EthSwept(to, amount);
    }

    /// @dev Accept ETH pulled from the treasury during `dispense`.
    receive() external payable {}
}
