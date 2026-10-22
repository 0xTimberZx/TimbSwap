// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../contracts/GameRegistry.sol";

contract MigrationMockTIMBS is ERC20 {
    constructor() ERC20("TIMBS", "TIMBS") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/**
 * @title MigrationLapseWindowTest
 * @notice TS-059: during a migration the escrow was repointed before the old
 *         registry was retired. In that window the old prize's addToPot
 *         reverts (the escrow takes deposits from the live prize only) and
 *         the lapse leg's try/catch sends 100% of each lapse to the sink. The
 *         migration now retires the old registry first: retireGame() moves the
 *         generation on, so no lapse sweep runs on the old game and its
 *         holders reclaim their principal instead.
 *
 * The test contract stands in as the OLD `timbPrize`; `escrowRepointed`
 * makes its addToPot revert the way the real one does once the escrow
 * points elsewhere.
 */
contract MigrationLapseWindowTest is Test {
    MigrationMockTIMBS timbs;
    GameRegistry       reg;

    address constant SINK   = address(0xFEE);
    address constant HOLDER = address(0xB1);
    bytes6  constant S1     = bytes6("ABC123");
    uint256 constant ENTRY  = 0.001 ether;

    bool    public escrowRepointed;
    uint256 public potReceived;

    function addToPot() external payable {
        require(!escrowRepointed, "NotTimbPrize");
        potReceived += msg.value;
    }
    receive() external payable {}

    function setUp() public {
        timbs = new MigrationMockTIMBS();
        reg = new GameRegistry(address(timbs), SINK, address(this), 2e18, 1e18);
    }

    function _one(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    /// One ETH ticket played in round 1; its refund window lapses at round 5.
    function _ticketDueToLapse() internal returns (uint256 tid) {
        vm.deal(HOLDER, 1 ether);
        vm.prank(HOLDER);
        reg.submitEntry{value: ENTRY}(S1, true, 0);
        tid = reg.activeTicketOf(HOLDER);
        reg.setCurrentRound(1);
        reg.activateRoundEntries(1, _one(HOLDER));
        reg.setCurrentRound(6); // round 5 settled
    }

    /// The window as it was: escrow repointed, old registry still live. The
    /// permissionless sweep sends the whole lapse to the sink.
    function test_TS059_OldOrder_RepointThenSweep_AllToSink() public {
        _ticketDueToLapse();
        escrowRepointed = true;
        vm.prank(address(0xCA11)); // anyone
        reg.onRoundSettled(5, 0);
        assertEq(potReceived, 0, "pot share lost to the try/catch");
        assertEq(SINK.balance, ENTRY, "100% to the sink, not 70/30");
    }

    /// The migration order now: retire the old registry, then repoint. No
    /// sweep moves the lapse anywhere and the holder reclaims the principal.
    function test_TS059_NewOrder_RetireThenRepoint_NoSweep() public {
        uint256 tid = _ticketDueToLapse();
        reg.retireGame();
        escrowRepointed = true;

        vm.prank(address(0xCA11));
        reg.onRoundSettled(5, 0);
        assertEq(potReceived, 0, "nothing swept to the old pot");
        assertEq(SINK.balance, 0, "nothing swept to the sink");

        uint256 before = HOLDER.balance;
        vm.prank(HOLDER);
        reg.reclaimFromPastGame(tid);
        assertEq(HOLDER.balance - before, ENTRY, "principal back to the holder");
    }
}
