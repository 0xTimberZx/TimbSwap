// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../contracts/GasFaucet.sol"; // brings in GasFaucet + ITreasury/IGameRegistry/IPrize

// ─── Mocks ────────────────────────────────────────────────────────────────────

contract MockTIMBS is ERC20 {
    constructor() ERC20("TIMBS", "TIMBS") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

// Holds ETH; the faucet is its (unmodelled) operator. Sends ETH on request.
contract MockTreasury is ITreasury {
    function withdrawOperational(address to, uint256 amount) external {
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "treasury send failed");
    }
    receive() external payable {}
}

// Grantable eligibility oracle mirroring GameRegistry's surface.
contract MockRegistry is IGameRegistry {
    mapping(address => uint256)       internal _ticket;
    mapping(uint256 => TicketStatus)  internal _status;
    uint256 internal _next = 1;

    function grant(address w, TicketStatus s) external {
        uint256 id = _ticket[w];
        if (id == 0) { id = _next++; _ticket[w] = id; }
        _status[id] = s;
    }
    function clear(address w) external { _ticket[w] = 0; }

    function activeTicketOf(address w) external view returns (uint256) { return _ticket[w]; }
    function effectiveStatus(uint256 id) external view returns (TicketStatus) { return _status[id]; }
}

contract MockPrize is IPrize {
    uint256 public potBalance;
    function addToPot() external payable { potBalance += msg.value; }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

contract GasFaucetTest is Test {
    MockTIMBS    timbs;
    MockTreasury treasury;
    MockRegistry registry;
    MockPrize    prize;
    GasFaucet    faucet;

    address dispatcher = address(0xD15);
    address guardian   = address(0x6A4D);
    address stranger   = address(0x5747);
    address alice      = address(0xA11CE);
    address bob        = address(0xB0B);

    uint256 constant DRIP = 0.001 ether;
    uint256 constant POT  = 0.001 ether;
    uint256 constant TIMB = 1e18;      // 1 TIMB
    uint256 constant COOLDOWN = 1 days;

    function setUp() public {
        timbs    = new MockTIMBS();
        treasury = new MockTreasury();
        registry = new MockRegistry();
        prize    = new MockPrize();

        faucet = new GasFaucet(
            address(treasury), address(timbs), address(registry), address(prize),
            DRIP, POT, TIMB, COOLDOWN
        );

        // Fund the treasury's ETH and the faucet's TIMBS budget.
        vm.deal(address(treasury), 100 ether);
        timbs.mint(address(faucet), 100e18);

        // Approve generous ceilings by default; individual tests tighten them.
        faucet.setEthCap(100 ether);
        faucet.setTimbsCap(100e18);
        faucet.setDispatcher(dispatcher);
        faucet.setGuardian(guardian);
    }

    function _eligible(address w) internal {
        registry.grant(w, IGameRegistry.TicketStatus.Active);
    }

    // ── Happy path: both legs in one tx ──

    function test_HappyDualDispense() public {
        _eligible(alice);
        vm.prank(dispatcher);
        faucet.dispense(alice);

        assertEq(alice.balance, DRIP, "drip to wallet");
        assertEq(prize.potBalance(), POT, "pot funded");
        assertEq(timbs.balanceOf(alice), TIMB, "1 TIMB issued");
        assertEq(faucet.ethDistributed(), DRIP + POT, "eth counter");
        assertEq(faucet.timbsDistributed(), TIMB, "timbs counter");
        assertEq(faucet.lastClaimAt(alice), block.timestamp, "cooldown stamped");
    }

    function test_OwnerMayAlsoDispense() public {
        _eligible(alice);
        faucet.dispense(alice); // msg.sender == owner (this)
        assertEq(timbs.balanceOf(alice), TIMB);
    }

    // ── Cooldown ──

    function test_CooldownBlocksSecondClaim() public {
        _eligible(alice);
        vm.prank(dispatcher);
        faucet.dispense(alice);

        uint256 readyAt = faucet.lastClaimAt(alice) + faucet.cooldown();
        vm.prank(dispatcher);
        vm.expectRevert(abi.encodeWithSelector(GasFaucet.CooldownActive.selector, readyAt));
        faucet.dispense(alice);
    }

    function test_ClaimAgainAfterCooldown() public {
        _eligible(alice);
        vm.prank(dispatcher);
        faucet.dispense(alice);

        vm.warp(block.timestamp + COOLDOWN + 1);
        vm.prank(dispatcher);
        faucet.dispense(alice);
        assertEq(timbs.balanceOf(alice), 2 * TIMB, "second claim delivered");
    }

    // ── Eligibility ──

    function test_NotEligibleReverts() public {
        vm.prank(dispatcher);
        vm.expectRevert(abi.encodeWithSelector(GasFaucet.NotEligible.selector, alice));
        faucet.dispense(alice);
    }

    function test_PendingTicketIsNotEligible() public {
        registry.grant(alice, IGameRegistry.TicketStatus.Pending);
        vm.prank(dispatcher);
        vm.expectRevert(abi.encodeWithSelector(GasFaucet.NotEligible.selector, alice));
        faucet.dispense(alice);
    }

    // ── Independent pauses ──

    function test_EthPausedSkipsEthLegOnly() public {
        _eligible(alice);
        vm.prank(guardian);
        faucet.setEthPaused(true);

        vm.prank(dispatcher);
        faucet.dispense(alice);

        assertEq(alice.balance, 0, "no drip while eth paused");
        assertEq(prize.potBalance(), 0, "no pot while eth paused");
        assertEq(faucet.ethDistributed(), 0);
        assertEq(timbs.balanceOf(alice), TIMB, "timbs still flows");
    }

    function test_TimbsPausedSkipsTimbsLegOnly() public {
        _eligible(alice);
        vm.prank(guardian);
        faucet.setTimbsPaused(true);

        vm.prank(dispatcher);
        faucet.dispense(alice);

        assertEq(alice.balance, DRIP, "drip still flows");
        assertEq(prize.potBalance(), POT, "pot still flows");
        assertEq(timbs.balanceOf(alice), 0, "no timbs while paused");
        assertEq(faucet.timbsDistributed(), 0);
    }

    function test_BothPausedReverts() public {
        _eligible(alice);
        vm.startPrank(guardian);
        faucet.setEthPaused(true);
        faucet.setTimbsPaused(true);
        vm.stopPrank();

        vm.prank(dispatcher);
        vm.expectRevert(GasFaucet.NothingToDispense.selector);
        faucet.dispense(alice);
    }

    // ── Approved-to-distribute caps ──

    function test_EthCapEnforced() public {
        faucet.setEthCap(DRIP + POT); // room for exactly one claim
        _eligible(alice);
        _eligible(bob);

        vm.prank(dispatcher);
        faucet.dispense(alice);

        vm.prank(dispatcher);
        vm.expectRevert(abi.encodeWithSelector(GasFaucet.EthCapExceeded.selector, DRIP + POT, uint256(0)));
        faucet.dispense(bob);
    }

    function test_TimbsCapEnforced() public {
        faucet.setTimbsCap(TIMB); // room for exactly one claim
        _eligible(alice);
        _eligible(bob);

        vm.prank(dispatcher);
        faucet.dispense(alice);

        vm.prank(dispatcher);
        vm.expectRevert(abi.encodeWithSelector(GasFaucet.TimbsCapExceeded.selector, TIMB, uint256(0)));
        faucet.dispense(bob);
    }

    function test_InsufficientTimbsBalanceReverts() public {
        // Drain the faucet's TIMBS budget; eth leg has headroom.
        faucet.recoverTimbs(address(this), timbs.balanceOf(address(faucet)));
        _eligible(alice);

        vm.prank(dispatcher);
        vm.expectRevert(abi.encodeWithSelector(GasFaucet.InsufficientTimbsBalance.selector, TIMB, uint256(0)));
        faucet.dispense(alice);
    }

    // ── Access control ──

    function test_OnlyDispatcherOrOwnerDispenses() public {
        _eligible(alice);
        vm.prank(stranger);
        vm.expectRevert(GasFaucet.NotDispatcher.selector);
        faucet.dispense(alice);
    }

    function test_OnlyPauserTogglesPauses() public {
        vm.prank(stranger);
        vm.expectRevert(GasFaucet.NotPauser.selector);
        faucet.setEthPaused(true);
    }

    function test_OnlyOwnerSetsCaps() public {
        vm.prank(guardian); // guardian may pause but not set caps
        vm.expectRevert();
        faucet.setEthCap(1);
    }

    // ── Recovery ──

    function test_RecoverTimbsReturnsBudget() public {
        uint256 held = timbs.balanceOf(address(faucet));
        faucet.recoverTimbs(address(treasury), held);
        assertEq(timbs.balanceOf(address(faucet)), 0);
        assertEq(timbs.balanceOf(address(treasury)), held);
    }

    // ── View helper ──

    function test_ClaimableReflectsState() public {
        assertFalse(faucet.claimable(alice), "ineligible");
        _eligible(alice);
        assertTrue(faucet.claimable(alice), "eligible + funded");

        vm.prank(dispatcher);
        faucet.dispense(alice);
        assertFalse(faucet.claimable(alice), "on cooldown");
    }
}
