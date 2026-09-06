// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import {IERC20}    from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Monotonic, generation-safe cumulative round count. MUST never reset
///         across game-generation redeploys (unlike TimbPrize.currentRound).
///         Provided by GameRegistry — see dev-docs/EMISSIONS_SCHEDULE.md §4.
interface IRoundOracle {
    function cumulativeRounds() external view returns (uint256);
}

/**
 * @title  TimbReleaseVault
 * @notice Immutable halving release of locked TIMBS to the treasury, keyed to
 *         cumulative game rounds. At each milestone round 1000 * 2^n (1000,
 *         2000, 4000, 8000, ...), HALF of whatever is still locked is released
 *         to the treasury. Permissionless and deterministic — no owner, no
 *         admin powers over the funds. The schedule cannot be changed once
 *         deployed, which is the point: locked supply is provably out of
 *         circulation until its milestone.
 *
 *         SUPPLY AVAILABILITY ONLY. Releasing to the treasury does NOT emit
 *         rewards to anyone. Reward rates are a separate, hand-set policy
 *         (dev-docs/EMISSIONS_SCHEDULE.md §5).
 *
 *         Genesis split (deploy script): mint 50M to the treasury directly and
 *         50M to this vault; pass that 50M as `lockedTotal`.
 *
 *         DESIGN STUB — UNAUDITED. Custodies 50M TIMBS. Audit before mainnet.
 */
contract TimbReleaseVault {
    using SafeERC20 for IERC20;

    IERC20       public immutable timbs;
    address      public immutable treasury;
    IRoundOracle public immutable rounds;

    /// @notice First milestone round; each subsequent one doubles.
    uint256 public constant BASE_INTERVAL = 1000;
    /// @notice Below this the halving tail is swept in full (avoids wei-dust
    ///         stranded across infinite halvings). 1 TIMBS.
    uint256 public constant DUST = 1e18;

    /// @notice TIMBS still locked (released halves are subtracted).
    uint256 public lockedRemaining;
    /// @notice Number of halving tranches released so far.
    uint256 public releasedCount;

    event Released(uint256 indexed index, uint256 milestoneRound, uint256 amount, uint256 lockedRemaining);

    constructor(IERC20 _timbs, address _treasury, IRoundOracle _rounds, uint256 lockedTotal) {
        require(address(_timbs) != address(0), "timbs=0");
        require(_treasury != address(0),        "treasury=0");
        require(address(_rounds) != address(0), "rounds=0");
        require(lockedTotal != 0,               "locked=0");
        timbs           = _timbs;
        treasury        = _treasury;
        rounds          = _rounds;
        lockedRemaining = lockedTotal;   // deploy script mints exactly this to the vault
    }

    /// @notice The next round at which a tranche unlocks: 1000 * 2^releasedCount.
    function nextMilestoneRound() public view returns (uint256) {
        return BASE_INTERVAL << releasedCount;   // 1000, 2000, 4000, ...
    }

    /// @notice Release every matured halving tranche to the treasury.
    ///         Permissionless — anyone can push matured supply through.
    function release() external {
        uint256 cum    = rounds.cumulativeRounds();
        uint256 payout;

        // Drain each matured milestone: half of the remaining balance.
        while (lockedRemaining >= DUST && cum >= nextMilestoneRound()) {
            uint256 milestone = nextMilestoneRound();
            uint256 tranche   = lockedRemaining / 2;
            lockedRemaining  -= tranche;
            releasedCount++;
            payout += tranche;
            emit Released(releasedCount, milestone, tranche, lockedRemaining);
        }

        // Tail sweep: once the halves fall below DUST, release the remainder in
        // full at the next matured milestone rather than halving wei forever.
        if (lockedRemaining > 0 && lockedRemaining < DUST && cum >= nextMilestoneRound()) {
            uint256 milestone = nextMilestoneRound();
            payout          += lockedRemaining;
            releasedCount++;
            emit Released(releasedCount, milestone, lockedRemaining, 0);
            lockedRemaining  = 0;
        }

        require(payout > 0, "nothing matured");
        timbs.safeTransfer(treasury, payout);
    }
}
