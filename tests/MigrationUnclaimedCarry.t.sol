// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PrizeEscrow} from "../contracts/PrizeEscrow.sol";
import {TimbPrize} from "../contracts/TimbPrize.sol";
import {GameRegistry} from "../contracts/GameRegistry.sol";
import {PotCarry} from "../scripts/PotCarry.sol";

contract UCMockTIMBS is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") { _mint(msg.sender, 1_000_000e18); }
}

/// Stand-in for VRFEntropy: every request is fulfilled at once with word 0, so
/// each segment locks the first free letter and every round draws "ABCDEF".
contract UCInstantEntropy {
    mapping(bytes32 => bool) public requested;
    uint256 public n;
    function requestFor(bytes32 salt) external returns (uint256) { requested[salt] = true; return ++n; }
    function rerequest(bytes32) external pure returns (uint256) { revert("unused"); }
    function isReady(bytes32 salt) external view returns (bool) { return requested[salt]; }
    function isRequested(bytes32 salt) external view returns (bool) { return requested[salt]; }
    function entropyFor(bytes32) external pure returns (bytes32) { return bytes32(0); }
}

/// The migration broadcaster: owns the escrow, both registries and both
/// prizes, and runs the scripts' own PotCarry steps.
contract UCOperator is PotCarry {
    function carry(address oldPrize, address escrow, TimbPrize newPrize) external returns (uint256) {
        return _carryPot(oldPrize, escrow, newPrize, address(this));
    }
    function release(address oldPrize, address escrow, TimbPrize livePrize, address cutTo) external returns (uint256) {
        return _releaseRetired(oldPrize, escrow, livePrize, address(this), cutTo);
    }
    receive() external payable {}
}

/**
 * TS-071 — a migration carries the outgoing game's unclaimed winnings too.
 *
 * TS-067's carry moved only currentAccumulatedRewards. (1) Expired shares that
 * nobody had recycled stayed in gameUnclaimed_winningsPool, and recycling them
 * after the migration only credited the retired prize. (2) retire() freezes
 * currentRound, so the last rounds can never be recycled, and once the runbook
 * revoked the retired payer their unclaimed shares were stranded in the
 * escrow. _carryPot now recycles expired rounds first, and _releaseRetired
 * (scripts/ReleaseRetiredPrize.s.sol) replaces the bare revoke.
 *
 * Run: forge test --match-contract MigrationUnclaimedCarryTest -vvv
 */
contract MigrationUnclaimedCarryTest is Test {
    bytes6  constant WIN = "ABCDEF";
    uint256 constant POT = 1 ether;

    UCOperator   op;
    UCMockTIMBS  timbs;
    PrizeEscrow  escrow;
    GameRegistry oldReg;
    TimbPrize    oldPrize;
    address sink   = address(0x51CC);
    address router = address(0xCAFE);
    address alice  = address(0xA11CE); // wins round 1
    address bob    = address(0xB0B);   // wins the outgoing game's last round
    address cutTo  = address(0xC07);

    function setUp() public {
        op = new UCOperator();
        vm.deal(address(op), 10 ether);
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
        timbs = new UCMockTIMBS();

        vm.startPrank(address(op));
        escrow   = new PrizeEscrow();
        oldReg   = new GameRegistry(address(timbs), sink, address(0), 2e18, 1e18);
        oldPrize = new TimbPrize(address(escrow), address(oldReg), router);
        escrow.setTimbPrize(address(oldPrize));
        oldReg.setTimbPrize(address(oldPrize));
        oldPrize.setEntropy(address(new UCInstantEntropy()));
        vm.stopPrank();

        // Alice enters before the game starts, so her ticket plays round 1.
        vm.prank(alice);
        oldReg.submitEntry{value: 0.001 ether}(WIN, true, 0);

        vm.startPrank(address(op));
        oldPrize.fundPot{value: POT}();
        oldPrize.startGame();
        vm.stopPrank();
    }

    function _settleRound(TimbPrize p) internal {
        uint256 r = p.currentRound();
        while (p.currentRound() == r) {
            vm.warp(p.segmentStartTime() + p.INTERACTION_WINDOW());
            p.settleSegment(); // arm
            p.settleSegment(); // lock (word is instant)
        }
    }

    /// DeployGen3Migration steps 3-6b, with the scripts' own _carryPot.
    function _migrate() internal returns (TimbPrize newPrize, uint256 carried) {
        vm.startPrank(address(op));
        GameRegistry newReg = new GameRegistry(address(timbs), sink, address(0), 2e18, 1e18);
        newPrize = new TimbPrize(address(escrow), address(newReg), router);
        newReg.setTimbPrize(address(newPrize));
        newPrize.setEntropy(address(new UCInstantEntropy()));
        oldPrize.retire();
        oldReg.retireGame();
        escrow.setTimbPrize(address(newPrize));
        vm.stopPrank();
        carried = op.carry(address(oldPrize), address(escrow), newPrize);
    }

    /// Every wei in the escrow is owed through a prize that can still pay it.
    function _stranded(TimbPrize live) internal view returns (uint256) {
        uint256 owed = live.currentAccumulatedRewards() + live.gameUnclaimed_winningsPool() + live.protocolCutAccrued();
        if (escrow.retiredPrize(address(oldPrize))) {
            owed += oldPrize.gameUnclaimed_winningsPool() + oldPrize.protocolCutAccrued();
        }
        return address(escrow).balance - owed;
    }

    /// Bob wins round 3, the outgoing game's last; the migration follows.
    function _bobWinsLastRound() internal returns (uint256 share) {
        _settleRound(oldPrize);                   // round 1 (Alice)
        vm.prank(alice);
        oldPrize.claimWinnings(1);
        vm.prank(bob);
        oldReg.submitEntry{value: 0.001 ether}(WIN, true, 0); // plays round 3
        _settleRound(oldPrize);                   // round 2: nobody holds a ticket
        vm.prank(address(op));
        oldPrize.fundPot{value: POT}();
        _settleRound(oldPrize);                   // round 3: Bob matches
        share = oldPrize.roundPerWinnerAmount(3);
        assertEq(oldPrize.roundWinners(3, 0), bob);
        assertGt(share, 0);
    }

    // ─── (1) Expired, unrecycled winnings ride the carry ────────────────────

    function test_TS071_ExpiredWinningsRideTheCarry() public {
        _settleRound(oldPrize);                   // round 1: Alice matches
        uint256 share = oldPrize.roundPerWinnerAmount(1);
        assertGt(share, 0);
        _settleRound(oldPrize);
        _settleRound(oldPrize);                   // currentRound 4: window over
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TimbPrize.ClaimWindowExpired.selector, 1));
        oldPrize.claimWinnings(1);
        assertFalse(oldPrize.roundRecycled(1));

        uint256 livePot = oldPrize.currentAccumulatedRewards();
        (TimbPrize newPrize, uint256 carried) = _migrate();
        assertEq(carried, livePot + share, "carry includes the expired share");
        assertEq(newPrize.currentAccumulatedRewards(), livePot + share);
        assertTrue(oldPrize.roundRecycled(1));
        assertEq(oldPrize.gameUnclaimed_winningsPool(), 0);
        assertEq(_stranded(newPrize), 0, "nothing stranded in the escrow");
    }

    /// Already-recycled and fully-claimed rounds are skipped (no wasted sends).
    function test_TS071_NothingToRecycleIsSkipped() public {
        _settleRound(oldPrize);
        vm.prank(alice);
        oldPrize.claimWinnings(1);                // claimed in time
        _settleRound(oldPrize);
        _settleRound(oldPrize);
        uint256 livePot = oldPrize.currentAccumulatedRewards();
        (, uint256 carried) = _migrate();
        assertEq(carried, livePot);
        assertFalse(oldPrize.roundRecycled(1), "a fully claimed round is not sent");
    }

    // ─── (2) Last-round winnings: claimable, then carried at the revoke ─────

    function test_TS071_LastRoundWinnerCanStillClaim() public {
        uint256 share = _bobWinsLastRound();
        _migrate();
        uint256 before = bob.balance;
        vm.prank(bob);
        oldPrize.claimWinnings(3);                // retired payer still honoured (TS-018)
        assertEq(bob.balance, before + share);
    }

    function test_TS071_ReleaseCarriesLastRoundWinnings() public {
        uint256 share = _bobWinsLastRound();
        (TimbPrize newPrize,) = _migrate();
        vm.prank(address(op));
        newPrize.startGame();
        for (uint256 i = 0; i < 3; i++) _settleRound(newPrize); // Bob's claim period passes

        uint256 potBefore = newPrize.currentAccumulatedRewards();
        uint256 released  = op.release(address(oldPrize), address(escrow), newPrize, cutTo);
        assertEq(released, share);
        assertEq(newPrize.currentAccumulatedRewards(), potBefore + share, "share reaches the live pot");
        assertFalse(escrow.retiredPrize(address(oldPrize)));
        assertEq(_stranded(newPrize), 0, "nothing stranded after the revoke");

        vm.prank(bob);
        vm.expectRevert(PrizeEscrow.NotTimbPrize.selector);
        oldPrize.claimWinnings(3);                // revoked: cannot be paid twice
    }

    function test_TS071_ReleaseAfterClaimCarriesNothing() public {
        _bobWinsLastRound();
        (TimbPrize newPrize,) = _migrate();
        vm.prank(bob);
        oldPrize.claimWinnings(3);
        uint256 potBefore = newPrize.currentAccumulatedRewards();
        assertEq(op.release(address(oldPrize), address(escrow), newPrize, cutTo), 0);
        assertEq(newPrize.currentAccumulatedRewards(), potBefore);
        assertEq(_stranded(newPrize), 0);
    }

    function test_TS071_ReleaseDeliversTheOldProtocolCut() public {
        _bobWinsLastRound();
        uint256 cut = oldPrize.protocolCutAccrued();
        assertGt(cut, 0);
        (TimbPrize newPrize,) = _migrate();

        vm.expectRevert(bytes("TS-071: old prize has an undelivered protocol cut; set PROTOCOL_CUT_TO"));
        op.release(address(oldPrize), address(escrow), newPrize, address(0));

        op.release(address(oldPrize), address(escrow), newPrize, cutTo);
        assertEq(cutTo.balance, cut);
        assertEq(oldPrize.protocolCutAccrued(), 0);
        assertEq(_stranded(newPrize), 0);
    }

    function test_TS071_ReleaseGuards() public {
        (TimbPrize newPrize,) = _migrate();
        vm.expectRevert(bytes("TS-071: old prize is the live prize"));
        op.release(address(newPrize), address(escrow), newPrize, cutTo);

        op.release(address(oldPrize), address(escrow), newPrize, cutTo);
        vm.expectRevert(bytes("TS-071: old prize is not a retired payer (already revoked?)"));
        op.release(address(oldPrize), address(escrow), newPrize, cutTo);
    }
}
