// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";
import {VestingWalletCliff} from "@openzeppelin/contracts/finance/VestingWalletCliff.sol";

/**
 * @title TimbVesting
 * @notice One beneficiary's TIMBS allocation, released on a cliff-then-linear
 *         schedule. A thin, concrete wrapper over OpenZeppelin's audited
 *         {VestingWallet} + {VestingWalletCliff} — it adds no custody logic of
 *         its own, which is the point: the audit surface is the two OZ bases.
 *
 * Schedule (OpenZeppelin semantics):
 *   - `start`     when the clock begins (unix seconds).
 *   - `duration`  the WHOLE vesting window measured from `start`; everything is
 *                 vested at `start + duration`.
 *   - `cliff`     nothing is releasable before `start + cliff`. At the cliff the
 *                 linear amount for the time already elapsed vests in one step
 *                 (a catch-up); it then continues linearly to the end.
 *
 *   Era-1 deploy values (dev-docs/EMISSIONS_SCHEDULE.md §7): cliff 180 days,
 *   duration 730 days. So 180/730 ≈ 24.7 % unlocks at month six and the rest
 *   streams to month twenty-four. Reading "six-month cliff, THEN twenty-four
 *   months linear" is the same contract with duration = 910 days.
 *
 * Allocation: the wallet vests whatever TIMBS it holds plus what it has already
 * released, so the allocation is simply the amount transferred in. Tokens sent
 * later join the SAME schedule (they are treated as though present from
 * `start`), which is why each wallet should be funded once, before its cliff.
 *
 * Properties, all deliberate:
 *   - Irrevocable. No clawback. Whoever funds this gives the tokens up; only
 *     time releases them. Trustless for the beneficiary — which also means a
 *     departing team member keeps their schedule.
 *   - The beneficiary is `owner` and MAY transfer ownership (key rotation).
 *     The flip side, per OpenZeppelin's own note, is that unvested tokens can
 *     effectively be sold by selling the wallet. Accepted.
 *   - `release(token)` is permissionless and always pays the owner.
 *   - TIMBS only. Native ETH is rejected so nothing but the allocation ever
 *     sits here.
 */
contract TimbVesting is VestingWalletCliff {
    /// @notice This wallet holds TIMBS only; ETH transfers are refused.
    error NoEther();

    /**
     * @param beneficiary     Receives every release; becomes `owner`.
     * @param startTimestamp  Unix seconds the schedule is measured from.
     * @param cliffSeconds    Offset from `start` before which nothing is releasable.
     * @param durationSeconds Whole window from `start` to fully vested. Must be
     *                        ≥ `cliffSeconds` (OZ reverts otherwise).
     */
    constructor(
        address beneficiary,
        uint64 startTimestamp,
        uint64 cliffSeconds,
        uint64 durationSeconds
    )
        VestingWallet(beneficiary, startTimestamp, durationSeconds)
        VestingWalletCliff(cliffSeconds)
    {}

    /// @dev Refuse ETH so the wallet can only ever hold the TIMBS allocation.
    receive() external payable override {
        revert NoEther();
    }
}
