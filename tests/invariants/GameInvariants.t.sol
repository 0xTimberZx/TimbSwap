// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";

import "../../contracts/PrizeEscrow.sol";
import "../../contracts/GameRegistry.sol";
import "../../contracts/TimbPrize.sol";
import "../../contracts/VRFEntropy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract InvTIMBS is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") { _mint(msg.sender, 1_000_000e18); }
}

/// @dev Mock VRF v2.5 coordinator: hands out ids; the handler fulfils explicitly.
contract InvVRF is IVRFCoordinatorV2Plus {
    uint256 public nextId = 1;
    function requestRandomWords(RandomWordsRequest calldata) external returns (uint256) { return nextId++; }
    function fulfil(address consumer, uint256 requestId, uint256 word) external {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        VRFEntropy(consumer).rawFulfillRandomWords(requestId, words);
    }
}

/**
 * @title GameHandler
 * @notice Drives the real GameRegistry + TimbPrize + PrizeEscrow + VRFEntropy
 *         through random sequences of player and keeper actions. Owns every
 *         contract (it deploys them), so owner-only actions (fundPot,
 *         withdrawProtocolCut) are part of the action space.
 */
contract GameHandler is Test {
    bytes constant ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    InvTIMBS     public timbs;
    PrizeEscrow  public escrow;
    GameRegistry public registry;
    TimbPrize    public prize;
    InvVRF       public coord;
    VRFEntropy   public entropy;

    address public constant SINK = address(0xBEEF);
    address[4] public actors = [address(0xA1), address(0xA2), address(0xA3), address(0xA4)];

    // Ghosts for the conservation check.
    uint256 public ethIn;              // every wei this suite ever dealt
    uint256 public calls;
    uint256 public okRefunds;
    uint256 public okClaims;
    uint256 public okRecycles;
    uint256 public winRounds;
    mapping(bytes32 => uint256) public callCount;

    constructor() {
        timbs    = new InvTIMBS();
        escrow   = new PrizeEscrow();
        registry = new GameRegistry(address(timbs), SINK, address(0), 2e18, 1e18);
        prize    = new TimbPrize(address(escrow), address(registry), address(this));
        coord    = new InvVRF();
        entropy  = new VRFEntropy(address(coord), bytes32(uint256(0xABC)), 42, 3, 200_000, hex"1234");
        entropy.setBoard(address(prize));
        prize.setEntropy(address(entropy));
        registry.setTimbPrize(address(prize));
        escrow.setTimbPrize(address(prize));
        prize.setProtocolCutBps(50);    // the beta's 0.5% round sweep
        prize.startGame();

        for (uint256 i = 0; i < actors.length; i++) {
            vm.deal(actors[i], 50 ether);
            ethIn += 50 ether;
        }
        vm.deal(address(this), 50 ether);
        ethIn += 50 ether;
    }

    receive() external payable {}

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _actor(uint256 seed) internal view returns (address) { return actors[seed % actors.length]; }

    /// @dev Six distinct letters from a seed (no swaps run, so every segment
    ///      draws a letter; letters-only strings are the winnable ones).
    function _string(uint256 seed) internal pure returns (bytes6) {
        bytes memory pool = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        bytes memory s = new bytes(6);
        uint256 n = 26;
        for (uint256 i = 0; i < 6; i++) {
            uint256 j = uint256(keccak256(abi.encode(seed, i))) % n;
            s[i] = pool[j];
            pool[j] = pool[n - 1];
            n--;
        }
        return bytes6(s);
    }

    function _wordFor(uint256 round, uint256 segment) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked("INV_VRF_WORD", round, segment)));
    }

    /// @dev Mirror of the letter-class distinct draw (TS-051), as in PrizeWindows.
    function _expectedChar(uint256 round, uint256 segment) internal view returns (bytes1) {
        uint256 takenMask;
        for (uint256 s = 1; s < segment; s++) {
            takenMask |= (1 << (uint256(uint8(_expectedChar(round, s))) - 0x41));
        }
        bytes32 salt = prize.saltFor(round, segment);
        uint256 mix  = uint256(keccak256(abi.encodePacked(_wordFor(round, segment), salt)));
        uint256 pick = mix % (26 - (segment - 1));
        for (uint256 k = 0; k < 26; k++) {
            if (takenMask & (1 << k) != 0) continue;
            if (pick == 0) return ALPHABET[k];
            pick--;
        }
        revert("mirror");
    }

    function _expectedString(uint256 round) internal view returns (bytes6) {
        bytes memory s = new bytes(6);
        for (uint256 i = 1; i <= 6; i++) s[i - 1] = _expectedChar(round, i);
        return bytes6(s);
    }

    function _count(bytes32 k) internal { calls++; callCount[k]++; }

    // ─── Player actions ──────────────────────────────────────────────────────

    function submit(uint256 actorSeed, uint256 strSeed, uint256 extraSeed) external {
        _count("submit");
        address a = _actor(actorSeed);
        uint256 extra = extraSeed % (registry.maxExtraRounds() + 1);
        uint256 cost = registry.entryCostETH();
        vm.prank(a);
        try registry.submitEntry{value: cost}(_string(strSeed), true, extra) {} catch {}
    }

    /// @dev Enter the string the next round will draw, so wins and payouts
    ///      actually happen inside the sequence.
    function submitWinner(uint256 actorSeed) external {
        _count("submitWinner");
        address a = _actor(actorSeed);
        uint256 cost = registry.entryCostETH();
        bytes6 s = _expectedString(prize.currentRound() + 1); // before the prank: it makes external calls
        vm.prank(a);
        try registry.submitEntry{value: cost}(s, true, 0) {} catch {}
    }

    function replace(uint256 actorSeed, uint256 strSeed) external {
        _count("replace");
        vm.prank(_actor(actorSeed));
        try registry.replaceEntry(_string(strSeed), 0) {} catch {}
    }

    function cancel(uint256 actorSeed) external {
        _count("cancel");
        vm.prank(_actor(actorSeed));
        try registry.cancelEntry() {} catch {}
    }

    /// @dev Try a refund on each of the actor's own tickets (most revert:
    ///      still eligible, already closed, or past the window).
    function refund(uint256 actorSeed) external {
        _count("refund");
        address a = _actor(actorSeed);
        (GameRegistry.Ticket[] memory list,) = registry.getTicketsOf(a);
        for (uint256 i = 0; i < list.length; i++) {
            vm.prank(a);
            try registry.claimRefund(list[i].id) { okRefunds++; } catch {}
        }
    }

    /// @dev Every actor tries to claim each of the last three settled rounds.
    function claimWin(uint256) external {
        _count("claimWin");
        uint256 cur = prize.currentRound();
        for (uint256 i = 0; i < actors.length; i++) {
            for (uint256 back = 1; back <= 3 && back < cur; back++) {
                vm.prank(actors[i]);
                try prize.claimWinnings(cur - back) { okClaims++; } catch {}
            }
        }
    }

    function recycle(uint256 back) external {
        _count("recycle");
        uint256 cur = prize.currentRound();
        if (cur < 4) return;
        uint256 r = 1 + back % (cur - 1);
        try prize.recycleUnclaimed(r) { okRecycles++; } catch {}
    }

    function addToPot(uint256 actorSeed, uint256 amount) external {
        _count("addToPot");
        amount = bound(amount, 1, 0.05 ether);
        vm.prank(_actor(actorSeed));
        try prize.addToPot{value: amount}() {} catch {}
    }

    // ─── Owner actions ───────────────────────────────────────────────────────

    function fundPot(uint256 amount) external {
        _count("fundPot");
        amount = bound(amount, 1, 0.5 ether);
        try prize.fundPot{value: amount}() {} catch {}
    }

    function withdrawCut() external {
        _count("withdrawCut");
        try prize.withdrawProtocolCut(SINK) {} catch {}
    }

    // ─── Keeper: one segment (arm → VRF → lock), with the settler's follow-up ─

    /// @dev 1-6 segments per call, so sequences reach refunds, lapses and wins.
    function settle(uint256 n) external {
        _count("settle");
        n = 1 + n % 6;
        for (uint256 i = 0; i < n; i++) if (!_settleOne()) return;
    }

    function _settleOne() internal returns (bool) {
        uint256 before = prize.currentRound();
        uint256 seg    = prize.currentSegment();
        vm.warp(prize.segmentStartTime() + prize.INTERACTION_WINDOW() + 1);
        try prize.settleSegment() {} catch { return false; }
        bytes32 salt = prize.saltFor(before, seg);
        (uint256 reqId, , , bool ready) = entropy.draws(salt);
        if (!ready && reqId != 0) coord.fulfil(address(entropy), reqId, _wordFor(before, seg));
        try prize.settleSegment() {} catch { return false; }
        uint256 nowR = prize.currentRound();
        if (nowR > before) {
            (, , address[] memory w, ,) = prize.getRoundResult(before);
            if (w.length > 0) winRounds++;
            registry.onRoundSettled(before, 0);
            registry.activateRoundEntries(nowR, registry.getRoundEntrants(nowR));
        }
        return true;
    }

    // ─── Views for the invariants ────────────────────────────────────────────

    function actorCount() external view returns (uint256) { return actors.length; }
}

/**
 * @title GameInvariants
 * @notice Solvency and accounting properties of the game that must hold after
 *         ANY sequence of player, keeper and owner actions.
 *
 * Run: forge test --match-contract GameInvariants -vvv
 */
contract GameInvariants is Test {
    GameHandler public h;

    function setUp() public {
        h = new GameHandler();
        targetContract(address(h));
    }

    /// Every ETH ticket's principal is backed by ETH the registry holds.
    function invariant_RegistryHoldsAllEthPrincipal() public view {
        GameRegistry r = h.registry();
        uint256 owed;
        uint256 last = r.nextTicketId();
        for (uint256 id = 1; id < last; id++) {
            (GameRegistry.Ticket memory t,) = r.getTicket(id);
            if (t.escrowToken == address(0)) owed += t.escrowAmount;
        }
        assertGe(address(r).balance, owed, "registry ETH < ticket principal owed");
    }

    /// The pot, the unclaimed winnings and the protocol cut are book entries;
    /// PrizeEscrow must hold at least their sum.
    function invariant_EscrowBacksPrizeBooks() public view {
        TimbPrize p = h.prize();
        uint256 books = p.currentAccumulatedRewards() + p.gameUnclaimed_winningsPool() + p.protocolCutAccrued();
        assertGe(address(h.escrow()).balance, books, "escrow ETH < pot + unclaimed + cut");
    }

    /// A ticket that is closed, cancelled or conceded holds no principal.
    function invariant_TerminalTicketsHoldNothing() public view {
        GameRegistry r = h.registry();
        uint256 last = r.nextTicketId();
        for (uint256 id = 1; id < last; id++) {
            (GameRegistry.Ticket memory t,) = r.getTicket(id);
            if (t.status == GameRegistry.TicketStatus.Closed ||
                t.status == GameRegistry.TicketStatus.Cancelled ||
                t.status == GameRegistry.TicketStatus.Conceded) {
                assertEq(t.escrowAmount, 0, "terminal ticket still holds escrow");
            }
        }
    }

    /// A wallet's active slot is empty or names its own live ticket.
    function invariant_ActiveSlotIsOwnLiveTicket() public view {
        GameRegistry r = h.registry();
        for (uint256 i = 0; i < h.actorCount(); i++) {
            address a = h.actors(i);
            uint256 id = r.activeTicketOf(a);
            if (id == 0) continue;
            (GameRegistry.Ticket memory t,) = r.getTicket(id);
            assertEq(t.owner, a, "active slot names another wallet's ticket");
            assertTrue(t.status == GameRegistry.TicketStatus.Pending ||
                       t.status == GameRegistry.TicketStatus.Active, "active slot names a dead ticket");
        }
    }

    /// No ETH is created or lost: everything dealt is still with the actors,
    /// the owner, the sink, the registry or the escrow.
    function invariant_EthConserved() public view {
        uint256 sum = address(h).balance + address(h.registry()).balance + address(h.escrow()).balance
                    + address(h.prize()).balance + h.SINK().balance;
        for (uint256 i = 0; i < h.actorCount(); i++) sum += h.actors(i).balance;
        assertEq(sum, h.ethIn(), "ETH left the system or appeared from nowhere");
    }

    /// Diagnostic: the run actually exercised the game (shown with -vv).
    function invariant_callSummary() public view {
        console.log("calls", h.calls());
        console.log("  submit/winner", h.callCount("submit"), h.callCount("submitWinner"));
        console.log("  settle", h.callCount("settle"), "round", h.prize().currentRound());
        console.log("  ok claims/refunds/recycles", h.okClaims(), h.okRefunds(), h.okRecycles());
        console.log("  rounds with winners", h.winRounds());
    }
}
