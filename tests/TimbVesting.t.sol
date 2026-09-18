// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {VestingWalletCliff} from "@openzeppelin/contracts/finance/VestingWalletCliff.sol";
import {TimbVesting} from "../contracts/TimbVesting.sol";

contract MockTIMBS is ERC20 {
    constructor() ERC20("TIMBS", "TIMBS") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/**
 * @title TimbVesting — cliff-then-linear schedule tests
 * @notice Exercises the Era-1 deploy shape (180-day cliff inside a 730-day
 *         window) on the founder/dev tranche, plus the properties the wrapper
 *         is relied on for: catch-up at the cliff, permissionless release that
 *         always pays the owner, late top-ups joining the same schedule, ETH
 *         refused, and two wallets never crossing.
 *
 * Every warp is an ABSOLUTE constant. Do not rewrite these as
 * `vm.warp(block.timestamp + …)`: under viaIR the optimiser folds repeated
 * `block.timestamp` reads within one function, so a second relative warp
 * silently recomputes from the original timestamp (see GasFaucet.t.sol).
 */
contract TimbVestingTest is Test {
    MockTIMBS timbs;
    TimbVesting w;

    address bene     = address(0xBE11E);
    address other    = address(0x07AE2);
    address stranger = address(0x5712A);

    uint64  constant START    = 1_000_000;
    uint64  constant CLIFF    = 180 days;
    uint64  constant DURATION = 730 days;
    uint256 constant TOTAL    = 6_000_000e18; // founder/dev tranche

    function setUp() public {
        timbs = new MockTIMBS();
        w = new TimbVesting(bene, START, CLIFF, DURATION);
        timbs.mint(address(w), TOTAL);
    }

    // Mirrors OZ's linear formula so expectations are derived, not hard-coded.
    function _linear(uint256 total, uint64 ts) internal pure returns (uint256) {
        if (ts < START) return 0;
        if (ts >= START + DURATION) return total;
        return (total * (ts - START)) / DURATION;
    }

    // ── construction ──

    function test_ConstructorWiresSchedule() public view {
        assertEq(w.owner(), bene, "beneficiary is owner");
        assertEq(w.start(), START, "start");
        assertEq(w.duration(), DURATION, "duration");
        assertEq(w.end(), START + DURATION, "end");
        assertEq(w.cliff(), START + CLIFF, "cliff timestamp");
    }

    function test_CliffAboveDurationReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(VestingWalletCliff.InvalidCliffDuration.selector, uint64(800 days), DURATION)
        );
        new TimbVesting(bene, START, 800 days, DURATION);
    }

    function test_ZeroBeneficiaryReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new TimbVesting(address(0), START, CLIFF, DURATION);
    }

    // ── schedule shape ──

    function test_NothingBeforeStart() public {
        vm.warp(START - 1);
        assertEq(w.releasable(address(timbs)), 0);
    }

    function test_NothingBeforeCliff() public {
        vm.warp(START + CLIFF - 1);
        assertEq(w.releasable(address(timbs)), 0, "one second before the cliff");
        assertEq(w.vestedAmount(address(timbs), START + CLIFF - 1), 0);
    }

    // At the cliff the linear amount for elapsed time unlocks in one step.
    function test_CatchUpAtCliff() public {
        vm.warp(START + CLIFF);
        uint256 expect = _linear(TOTAL, START + CLIFF);
        assertEq(w.releasable(address(timbs)), expect, "catch-up = linear(elapsed)");
        assertGt(expect, 0, "cliff unlocks something");
        // 180/730 of the tranche, to the wei.
        assertEq(expect, (TOTAL * 180 days) / 730 days, "180/730 of total");
    }

    function test_LinearMidway() public {
        vm.warp(START + DURATION / 2);
        assertEq(w.releasable(address(timbs)), TOTAL / 2, "half at half-time");
    }

    function test_FullAtEndAndAfter() public {
        vm.warp(START + DURATION);
        assertEq(w.releasable(address(timbs)), TOTAL, "all at end");
        vm.warp(START + DURATION + 365 days);
        assertEq(w.releasable(address(timbs)), TOTAL, "still all, never more");
    }

    // ── release mechanics ──

    function test_ReleasePaysBeneficiary_ThenOnlyTheDelta() public {
        vm.warp(START + CLIFF);
        uint256 first = w.releasable(address(timbs));
        w.release(address(timbs));
        assertEq(timbs.balanceOf(bene), first, "first release");
        assertEq(w.released(address(timbs)), first, "accounted");
        assertEq(w.releasable(address(timbs)), 0, "nothing left right now");

        vm.warp(START + DURATION / 2);
        uint256 delta = TOTAL / 2 - first;
        w.release(address(timbs));
        assertEq(timbs.balanceOf(bene), TOTAL / 2, "cumulative half");
        assertEq(w.released(address(timbs)), TOTAL / 2);
        assertEq(delta, TOTAL / 2 - first, "second release is the delta only");
    }

    function test_AnyoneMayTriggerRelease_OwnerIsPaid() public {
        vm.warp(START + DURATION);
        vm.prank(stranger);
        w.release(address(timbs));
        assertEq(timbs.balanceOf(bene), TOTAL, "owner paid");
        assertEq(timbs.balanceOf(stranger), 0, "caller gets nothing");
    }

    function test_ReleaseBeforeCliffIsANoOp() public {
        vm.warp(START + CLIFF - 1);
        w.release(address(timbs)); // must not revert, must move nothing
        assertEq(timbs.balanceOf(bene), 0);
        assertEq(w.released(address(timbs)), 0);
    }

    // Tokens sent after start are treated as present from the start — the whole
    // balance vests on one schedule. This is why funding happens once, early.
    function test_LateTopUpJoinsSameSchedule() public {
        vm.warp(START + DURATION / 2);
        w.release(address(timbs));                 // TOTAL/2 out
        timbs.mint(address(w), 2_000_000e18);      // top-up mid-schedule
        uint256 vested = _linear(TOTAL + 2_000_000e18, START + DURATION / 2);
        assertEq(
            w.releasable(address(timbs)),
            vested - TOTAL / 2,
            "half of the ENLARGED allocation, less what was already released"
        );
    }

    // ── properties ──

    function test_RejectsEther() public {
        vm.deal(address(this), 1 ether);
        (bool ok, ) = address(w).call{value: 1}("");
        assertFalse(ok, "receive() reverts");
        assertEq(address(w).balance, 0);
    }

    function test_OwnershipTransferMovesThePayout() public {
        vm.prank(bene);
        w.transferOwnership(other);
        assertEq(w.owner(), other);

        vm.warp(START + DURATION);
        w.release(address(timbs));
        assertEq(timbs.balanceOf(other), TOTAL, "new owner is paid");
        assertEq(timbs.balanceOf(bene), 0, "old owner is not");
    }

    function test_OnlyOwnerTransfersOwnership() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        w.transferOwnership(stranger);
    }

    function test_TwoWalletsAreIndependent() public {
        TimbVesting w2 = new TimbVesting(other, START, CLIFF, DURATION);
        uint256 team = 7_500_000e18;
        timbs.mint(address(w2), team);

        vm.warp(START + DURATION);
        w.release(address(timbs));
        w2.release(address(timbs));
        assertEq(timbs.balanceOf(bene), TOTAL, "founder/dev tranche");
        assertEq(timbs.balanceOf(other), team, "team tranche");
        assertEq(timbs.balanceOf(address(w)), 0);
        assertEq(timbs.balanceOf(address(w2)), 0);
    }

    // The shape with duration = 910 days is the other reading of "6 months, then
    // 24 months linear": same contract, nothing unlocks at the cliff beyond the
    // 180/910 catch-up, fully vested at month thirty.
    function test_AlternateReading_ThirtyMonthWindow() public {
        TimbVesting w3 = new TimbVesting(other, START, CLIFF, 910 days);
        timbs.mint(address(w3), TOTAL);
        vm.warp(START + CLIFF);
        assertEq(w3.releasable(address(timbs)), (TOTAL * 180 days) / 910 days);
        vm.warp(START + 910 days);
        assertEq(w3.releasable(address(timbs)), TOTAL);
    }
}
