// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/TimbBoostFarm.sol";
import "../contracts/BoostRewarder.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract PrecisionToken is ERC20 {
    uint8 private immutable _d;
    constructor(string memory n, uint8 d_) ERC20(n, n) { _d = d_; }
    function decimals() public view override returns (uint8) { return _d; }
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// TS-075: BoostRewarder booked the full accrual into totalOwed while the
/// accumulator only received floor(accrued * 1e18 / totalShares). With a
/// 6-decimal reward token over ~1e23 LP units, any update every few seconds
/// (free since TS-074's sync) floored every step to zero: stakers earned
/// nothing, totalOwed climbed to the 99% stop and the reserve could not be
/// recovered. It now owes only what the accumulator distributed and carries
/// the remainder into the next update. TimbBoostFarm owes only what it
/// distributed too (its remainder stays free and is streamed again).
contract RewarderPrecisionTest is Test {
    TimbBoostFarm farm;
    BoostRewarder rewarder;
    PrecisionToken timbs;
    PrecisionToken lp;
    PrecisionToken usdc;

    address alice   = address(0xA11CE);
    address bob     = address(0xB0B);
    address griefer = address(0xBAD); // holds nothing
    uint256 constant WINDOW = 1 days;
    uint256 constant FUND   = 1_000e6;     // 1,000 USDC (6 dp)
    uint256 constant STAKE  = 100_000e18;  // 1e23 LP units
    uint256 constant STEP   = 8;           // seconds between pokes
    uint256 constant RUN    = 2 hours;

    function setUp() public {
        timbs = new PrecisionToken("TIMBS", 18);
        lp    = new PrecisionToken("LP", 18);
        usdc  = new PrecisionToken("USDC", 6);
        farm  = new TimbBoostFarm(address(timbs), WINDOW, address(0));
        farm.addPool(address(lp), 1);
        rewarder = new BoostRewarder(address(farm), address(usdc), WINDOW);
        farm.addPoolHook(0, address(rewarder));

        _stake(alice, STAKE);
        usdc.mint(address(this), FUND);
        usdc.approve(address(rewarder), FUND);
        rewarder.notifyRewardAmount(FUND);
    }

    function _stake(address who, uint256 amt) internal {
        lp.mint(who, amt);
        vm.startPrank(who);
        lp.approve(address(farm), type(uint256).max);
        farm.deposit(0, amt);
        vm.stopPrank();
    }

    function _u(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    /// A zero-stake wallet syncs itself every STEP seconds for RUN.
    function _poke() internal returns (uint256 emitted) {
        uint256 rate = rewarder.rewardRatePerSecond();
        uint256 t = block.timestamp; // via_ir caches block.timestamp across warps
        for (uint256 i = 0; i < RUN / STEP; i++) {
            t += STEP;
            vm.warp(t);
            vm.prank(griefer);
            rewarder.sync(0, _u(griefer));
        }
        emitted = rate * RUN;
    }

    /// The reported attack: the staker now receives the stream anyway.
    function test_TS075_PokedEveryStepStakerStillEarns() public {
        uint256 emitted = _poke();
        assertGt(rewarder.accRewardPerShare(), 0, "accumulator moves");
        assertGe(rewarder.pendingReward(0, alice), emitted * 99 / 100, "staker earns the stream");
        vm.prank(alice);
        rewarder.claim(0);
        assertGe(usdc.balanceOf(alice), emitted * 99 / 100);
    }

    /// Nothing is owed to nobody: owed + carry is exactly what was emitted,
    /// and owed never exceeds what the staker can claim.
    function test_TS075_NoPhantomOwed() public {
        uint256 emitted = _poke();
        assertEq(rewarder.totalOwed() + rewarder.accrualCarry(), emitted, "owed + carry = emitted");
        assertLe(rewarder.totalOwed(), rewarder.pendingReward(0, alice) + 1, "owed is claimable");
        assertLt(rewarder.accrualCarry(), STAKE / 1e18, "carry under one accumulator unit");
    }

    /// Two stakers under the same poking split the stream pro rata.
    function test_TS075_TwoStakersSplitTheStream() public {
        _stake(bob, STAKE * 3);
        uint256 emitted = _poke();
        uint256 a = rewarder.pendingReward(0, alice);
        uint256 b = rewarder.pendingReward(0, bob);
        assertGe(a + b, emitted * 99 / 100, "stream reaches stakers");
        assertApproxEqRel(b, a * 3, 0.01e18, "pro rata");
    }

    /// Retire after the pokes: the staker claims, the owner recovers the rest.
    function test_TS075_RetireRecoversEverythingUnowed() public {
        _poke();
        vm.prank(alice);
        rewarder.claim(0);
        rewarder.retire();
        assertEq(rewarder.accrualCarry(), 0, "carry released at retire");
        uint256 recoverable = usdc.balanceOf(address(rewarder)) - rewarder.totalOwed();
        assertGt(recoverable, FUND * 90 / 100, "unemitted reserve recoverable");
        rewarder.recoverERC20(address(usdc), recoverable);
        assertEq(usdc.balanceOf(address(rewarder)), rewarder.totalOwed(), "only owed stays");
    }

    /// The carry is already streamed: a retarget must not count it as free
    /// again. A large stake keeps every step under one accumulator unit, so
    /// the carry grows well past one window's worth of units.
    function test_TS075_CarryIsCommittedWhenRetargeting() public {
        _stake(bob, 1e27);
        uint256 t = block.timestamp;
        for (uint256 i = 0; i < 100; i++) {
            t += STEP;
            vm.warp(t);
            vm.prank(griefer);
            rewarder.sync(0, _u(griefer));
        }
        assertGt(rewarder.accrualCarry(), WINDOW * 10, "carry built up");
        usdc.mint(address(this), 1);
        usdc.approve(address(rewarder), 1);
        rewarder.notifyRewardAmount(1); // retargets
        uint256 committed = rewarder.totalOwed() + rewarder.accrualCarry();
        assertEq(rewarder.rewardRatePerSecond(), (rewarder.rewardReserve() - committed) / WINDOW,
            "rate streams only the uncommitted reserve");
    }

    /// Control: nobody pokes; the staker collects about the whole stream.
    function test_TS075_Control_NoPokeFullStream() public {
        vm.warp(block.timestamp + WINDOW);
        assertGt(rewarder.pendingReward(0, alice), FUND * 99 / 100);
    }

    /// TimbBoostFarm: an update whose share floors to zero must not add to
    /// totalOwed (it stays free and is streamed again).
    function test_TS075_FarmOwesOnlyWhatItDistributed() public {
        // 1e10 wei of TIMBS over a day on 1e24 LP units floors every second.
        _stake(bob, 9_900_000e18);
        timbs.mint(address(this), 1e10);
        timbs.approve(address(farm), 1e10);
        farm.notifyRewardAmount(1e10);

        lp.mint(bob, 600);
        uint256 t = block.timestamp;
        for (uint256 i = 0; i < 600; i++) {
            t += 1;
            vm.warp(t);
            vm.prank(bob);
            farm.deposit(0, 1); // a 1-wei deposit rolls the pool forward
        }
        uint256 claimable = farm.pendingReward(0, alice) + farm.pendingReward(0, bob);
        assertLe(farm.totalOwed(), claimable + 2, "farm owes only what stakers can claim");
    }
}
