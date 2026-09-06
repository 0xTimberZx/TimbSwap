// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../contracts/GameRegistry.sol";

contract LapseMockTIMBS is ERC20 {
    constructor() ERC20("TIMBS", "TIMBS") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/**
 * @title LapseSplitTest
 * @notice Abandoned-ticket revenue: lapsed ETH principal is split between the
 *         live prize pot (community-tilted) and the protocol sink.
 *
 * The test contract stands in as `timbPrize`, so it both drives the round
 * lifecycle AND receives the pot-recycle via `addToPot()` — letting us assert
 * exactly how much of a forfeited stake reached the pot vs the sink.
 */
contract LapseSplitTest is Test {
    LapseMockTIMBS timbs;
    GameRegistry   reg;

    address constant SINK   = address(0xFEE);
    bytes6  constant S1     = bytes6("ABC123");
    uint256 constant ENTRY  = 0.001 ether; // ETH_ENTRY_FLOOR

    uint256 public potReceived; // ETH the registry recycled to the "pot"

    // timbPrize surface used by GameRegistry.
    function addToPot() external payable { potReceived += msg.value; }
    receive() external payable {}

    function setUp() public {
        timbs = new LapseMockTIMBS();
        reg = new GameRegistry(address(timbs), SINK, address(this)); // timbPrize = this
    }

    function _one(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    // Drive one ETH ticket (entered at round 0 → plays round 1, forfeit at 5)
    // all the way to its §14 forfeiture sweep.
    function _forfeitEthTicket(address who) internal {
        vm.deal(who, 1 ether);
        vm.prank(who);
        reg.submitEntry{value: ENTRY}(S1, true, 0); // playRound 1, LER 1, forfeit 5

        reg.setCurrentRound(1);
        reg.activateRoundEntries(1, _one(who));
        reg.setCurrentRound(6);      // round 5 is "settled" once currentRound > 5
        reg.onRoundSettled(5, 0);    // forfeitRound == 5 → split sweep
    }

    // Default 70/30: pot gets 70%, sink gets 30%.
    function test_DefaultSplit70_30() public {
        assertEq(reg.lapsePotBps(), 7_000, "default 70%");
        _forfeitEthTicket(address(0xB1));

        assertEq(potReceived,   (ENTRY * 7_000) / 10_000, "pot share");
        assertEq(SINK.balance,  ENTRY - (ENTRY * 7_000) / 10_000, "sink share");
        assertEq(potReceived + SINK.balance, ENTRY, "no wei lost");
    }

    // The split is timelock-tunable.
    function test_TunableSplit_AllToPot() public {
        reg.setLapsePotBps(10_000); // 100% to the pot
        _forfeitEthTicket(address(0xB1));

        assertEq(potReceived,  ENTRY, "all to pot");
        assertEq(SINK.balance, 0,     "nothing to sink");
    }

    function test_TunableSplit_AllToSink() public {
        reg.setLapsePotBps(0); // 0% to the pot — legacy behavior
        _forfeitEthTicket(address(0xB1));

        assertEq(potReceived,  0,     "nothing to pot");
        assertEq(SINK.balance, ENTRY, "all to sink");
    }

    function test_SetLapsePotBps_RejectsOverBps() public {
        vm.expectRevert();
        reg.setLapsePotBps(10_001);
    }

    // The ticket is terminally settled and holds no leftover after a clean split.
    function test_TicketFullyDisposed() public {
        _forfeitEthTicket(address(0xB1));
        uint256 id = 1; // first minted ticket
        (GameRegistry.Ticket memory t,) = reg.getTicket(id);
        assertEq(uint8(t.status), uint8(GameRegistry.TicketStatus.Ineligible), "status");
        assertEq(t.escrowAmount, 0, "escrow fully swept");
    }
}
