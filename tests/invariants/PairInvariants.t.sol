// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import {TimbSwapFactory} from "../../contracts/TimbSwapFactory.sol";
import {TimbSwapPair} from "../../contracts/TimbSwapPair.sol";

contract InvPairTok is ERC20 {
    constructor(string memory s) ERC20(s, s) { _mint(msg.sender, 1e30); }
}

/**
 * @title PairHandler
 * @notice Drives a real TimbSwapPair (deployed through the factory, protocol
 *         fee on) through random liquidity, swap, donation, sync and skim
 *         sequences from four actors.
 */
contract PairHandler is Test {
    InvPairTok      public a;
    InvPairTok      public b;
    TimbSwapFactory public factory;
    TimbSwapPair    public pair;

    address public constant FEE_TO = address(0xFEE);
    address public constant SINK   = address(0x5111);
    address[4] public actors = [address(0xB1), address(0xB2), address(0xB3), address(0xB4)];

    // Ghosts.
    bool    public swapLoweredK;          // a successful swap left k below its pre-swap value
    bool    public overQuoteSwapPassed;   // a swap asking 1 wei above the fee-adjusted quote went through
    bool    public roundTripProfit;       // mint then burn in one step returned more than deposited
    bool    public shareValueDropped;     // sqrt(k)/totalSupply fell across a mint or burn
    uint256 public lastShareValue;        // sqrt(k) * 1e18 / totalSupply after the last mint/burn
    uint256 public calls;
    mapping(bytes32 => uint256) public callCount;

    constructor() {
        a = new InvPairTok("A");
        b = new InvPairTok("B");
        factory = new TimbSwapFactory(FEE_TO);
        pair = TimbSwapPair(factory.createPair(address(a), address(b)));

        _fund(actors[0]); _fund(actors[1]); _fund(actors[2]); _fund(actors[3]);
        // Seed so the first actor action meets a live pool.
        a.transfer(address(pair), 1_000 ether);
        b.transfer(address(pair), 1_000 ether);
        pair.mint(address(this));
        lastShareValue = _shareValue();
    }

    function _fund(address u) internal {
        a.transfer(u, 1e27);
        b.transfer(u, 1e27);
    }

    function actorCount() external view returns (uint256) { return actors.length; }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _actor(uint256 seed) internal view returns (address) { return actors[seed % actors.length]; }
    function _count(bytes32 k) internal { calls++; callCount[k]++; }

    function _k() internal view returns (uint256) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        return uint256(r0) * uint256(r1);
    }

    function _shareValue() internal view returns (uint256) {
        uint256 s = pair.totalSupply();
        return s == 0 ? 0 : Math.sqrt(_k()) * 1e18 / s;
    }

    /// @dev Share value may only grow across mint/burn, up to 1e-18 relative
    ///      flooring in the sqrt and division (the pool rounds in its own favour).
    function _checkShareValue() internal {
        uint256 v = _shareValue();
        if (v + 1 < lastShareValue) shareValueDropped = true;
        lastShareValue = v;
    }

    function _tokens(bool zeroIn) internal view returns (InvPairTok tin, InvPairTok tout) {
        bool aIs0 = pair.token0() == address(a);
        (tin, tout) = zeroIn == aIs0 ? (a, b) : (b, a);
    }

    function _quote(uint256 amountIn, uint256 rIn, uint256 rOut) internal pure returns (uint256) {
        uint256 inFee = amountIn * 997;
        return inFee * rOut / (rIn * 1_000 + inFee);
    }

    // ─── Actions ─────────────────────────────────────────────────────────────

    function addLiquidity(uint256 actorSeed, uint256 amt0, uint256 amt1) external {
        _count("add");
        address u = _actor(actorSeed);
        amt0 = bound(amt0, 1e6, 1e24);
        amt1 = bound(amt1, 1e6, 1e24);
        (InvPairTok t0, InvPairTok t1) = _tokens(true);
        vm.startPrank(u);
        t0.transfer(address(pair), amt0);
        t1.transfer(address(pair), amt1);
        try pair.mint(u) {} catch {}
        vm.stopPrank();
        _checkShareValue();
    }

    function removeLiquidity(uint256 actorSeed, uint256 frac) external {
        _count("remove");
        address u = _actor(actorSeed);
        uint256 lp = pair.balanceOf(u) * bound(frac, 1, 100) / 100;
        if (lp == 0) return;
        vm.startPrank(u);
        pair.transfer(address(pair), lp);
        try pair.burn(u) {} catch {}
        vm.stopPrank();
        _checkShareValue();
    }

    /// @dev Add then remove the same LP at once: a depositor must never get
    ///      back more of either token than they put in.
    function roundTrip(uint256 actorSeed, uint256 amt0, uint256 amt1) external {
        _count("roundTrip");
        pair.skim(SINK); // unsynced donations go to the next minter by design; start clean
        address u = _actor(actorSeed);
        (InvPairTok t0, InvPairTok t1) = _tokens(true);
        uint256 b0 = t0.balanceOf(u);
        uint256 b1 = t1.balanceOf(u);
        _mintThenBurn(u, bound(amt0, 1e6, 1e24), bound(amt1, 1e6, 1e24));
        if (t0.balanceOf(u) > b0 || t1.balanceOf(u) > b1) roundTripProfit = true;
        _checkShareValue();
    }

    function _mintThenBurn(address u, uint256 amt0, uint256 amt1) internal {
        (InvPairTok t0, InvPairTok t1) = _tokens(true);
        vm.startPrank(u);
        t0.transfer(address(pair), amt0);
        t1.transfer(address(pair), amt1);
        uint256 minted = pair.mint(u);
        pair.transfer(address(pair), minted);
        pair.burn(u);
        vm.stopPrank();
    }

    function swap(uint256 actorSeed, bool zeroIn, uint256 amountIn) external {
        _count("swap");
        address u = _actor(actorSeed);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 rIn, uint256 rOut) = zeroIn ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        amountIn = bound(amountIn, 1e3, rIn * 2);
        uint256 out = _quote(amountIn, rIn, rOut);
        if (out == 0) return;
        (InvPairTok tin,) = _tokens(zeroIn);
        uint256 kBefore = _k();
        vm.startPrank(u);
        tin.transfer(address(pair), amountIn);
        try pair.swap(zeroIn ? 0 : out, zeroIn ? out : 0, u) {
            if (_k() < kBefore) swapLoweredK = true;
        } catch {}
        vm.stopPrank();
    }

    /// @dev Ask for one wei more than the 0.3%-fee quote allows. The pair must
    ///      refuse it; the input is then skimmed back so the actor loses nothing.
    function overQuoteSwap(uint256 actorSeed, bool zeroIn, uint256 amountIn) external {
        _count("overQuote");
        pair.skim(SINK); // unsynced donations count as swap input by design; start clean
        address u = _actor(actorSeed);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 rIn, uint256 rOut) = zeroIn ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        amountIn = bound(amountIn, 1e9, rIn);
        uint256 out = _quote(amountIn, rIn, rOut) + 1;
        if (out >= rOut) return;
        (InvPairTok tin,) = _tokens(zeroIn);
        vm.startPrank(u);
        tin.transfer(address(pair), amountIn);
        try pair.swap(zeroIn ? 0 : out, zeroIn ? out : 0, u) {
            overQuoteSwapPassed = true;
        } catch {
            pair.skim(u); // hand the refused input back
        }
        vm.stopPrank();
    }

    function donate(uint256 actorSeed, bool tokenA, uint256 amt) external {
        _count("donate");
        vm.prank(_actor(actorSeed));
        (tokenA ? a : b).transfer(address(pair), bound(amt, 1, 1e22));
    }

    function sync() external {
        _count("sync");
        pair.sync();
    }

    function skim() external {
        _count("skim");
        pair.skim(SINK);
    }

    /// @dev LP moves between holders without touching the pool.
    function transferLp(uint256 fromSeed, uint256 toSeed, uint256 frac) external {
        _count("transferLp");
        address from = _actor(fromSeed);
        uint256 lp = pair.balanceOf(from) * bound(frac, 0, 100) / 100;
        vm.prank(from);
        pair.transfer(_actor(toSeed), lp);
    }
}

/**
 * @title PairInvariants
 * @notice Constant-product and LP-accounting properties of TimbSwapPair that
 *         must hold after ANY sequence of liquidity, swap, donation, sync and
 *         skim actions, with the protocol fee on.
 *
 * Run: forge test --match-contract PairInvariants -vvv
 */
contract PairInvariants is Test {
    PairHandler h;

    function setUp() public {
        h = new PairHandler();
        targetContract(address(h));
    }

    /// The recorded reserves never exceed what the pair actually holds.
    function invariant_ReservesBackedByBalances() public view {
        TimbSwapPair p = h.pair();
        (uint112 r0, uint112 r1,) = p.getReserves();
        assertLe(r0, ERC20(p.token0()).balanceOf(address(p)), "reserve0 > balance0");
        assertLe(r1, ERC20(p.token1()).balanceOf(address(p)), "reserve1 > balance1");
    }

    /// Every LP token is held by a known party: the actors, the seeder, feeTo or the lock.
    function invariant_LpSupplyFullyAccounted() public view {
        TimbSwapPair p = h.pair();
        uint256 sum = p.balanceOf(address(h)) + p.balanceOf(h.FEE_TO()) + p.balanceOf(address(1))
                    + p.balanceOf(address(p)) + _actorsHold(p);
        assertEq(sum, p.totalSupply(), "LP balances != totalSupply");
    }

    function _actorsHold(ERC20 t) internal view returns (uint256 sum) {
        for (uint256 i = 0; i < h.actorCount(); i++) sum += t.balanceOf(h.actors(i));
    }

    /// The first-mint lock stays at address(1) for good.
    function invariant_MinimumLiquidityLocked() public view {
        TimbSwapPair p = h.pair();
        assertEq(p.balanceOf(address(1)), p.MINIMUM_LIQUIDITY(), "MINIMUM_LIQUIDITY moved");
    }

    /// Token supply is conserved across the pair, actors, the seeder and the skim sink.
    function invariant_TokensConserved() public view {
        _assertConserved(h.a());
        _assertConserved(h.b());
    }

    function _assertConserved(InvPairTok t) internal view {
        uint256 sum = t.balanceOf(address(h.pair())) + t.balanceOf(address(h)) + t.balanceOf(h.SINK())
                    + _actorsHold(t);
        assertEq(sum, t.totalSupply(), "token leaked");
    }

    function invariant_SwapNeverLowersK() public view {
        assertFalse(h.swapLoweredK(), "a swap lowered k");
    }

    function invariant_NoSwapBeatsTheFee() public view {
        assertFalse(h.overQuoteSwapPassed(), "swap above the 0.3% quote accepted");
    }

    function invariant_NoRoundTripProfit() public view {
        assertFalse(h.roundTripProfit(), "mint+burn returned more than deposited");
    }

    function invariant_ShareValueNeverDrops() public view {
        assertFalse(h.shareValueDropped(), "sqrt(k) per LP fell across a mint or burn");
    }

    function invariant_callSummary() public view {
        console.log("calls", h.calls());
        console.log("  add/remove/roundTrip", h.callCount("add"), h.callCount("remove"), h.callCount("roundTrip"));
        console.log("  swap/overQuote", h.callCount("swap"), h.callCount("overQuote"));
        console.log("  donate/sync/skim", h.callCount("donate"), h.callCount("sync"), h.callCount("skim"));
        console.log("  feeTo LP", h.pair().balanceOf(h.FEE_TO()));
    }
}
