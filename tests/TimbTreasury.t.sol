// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../contracts/TimbTreasury.sol";

// ─── Mocks ────────────────────────────────────────────────────────────────────

contract MockTIMBS is ERC20 {
    constructor() ERC20("TIMBS", "TIMBS") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
    function burn(uint256 a) external { _burn(msg.sender, a); } // ERC20Burnable-style
}

contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped ETH", "WETH") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 a) external { _burn(msg.sender, a); payable(msg.sender).transfer(a); }
    receive() external payable { _mint(msg.sender, msg.value); }
}

// Sends a fixed TIMBS amount out on swap(); reserves are static and drive the
// treasury's amountOut math. Pre-fund it with TIMBS so it can pay the swap.
contract MockPair {
    address public token0;
    address public token1;
    uint112 private r0;
    uint112 private r1;
    IERC20  private timbs;

    constructor(address _token0, address _token1, uint112 _r0, uint112 _r1, address _timbs) {
        token0 = _token0; token1 = _token1; r0 = _r0; r1 = _r1; timbs = IERC20(_timbs);
    }
    function getReserves() external view returns (uint112, uint112, uint32) { return (r0, r1, 0); }
    function swap(uint256 amount0Out, uint256 amount1Out, address to) external {
        uint256 out = amount0Out > 0 ? amount0Out : amount1Out;
        timbs.transfer(to, out); // the TIMBS the treasury's math computed
    }
}

// Pulls the desired amounts and records `to` (must be the treasury).
contract MockRouter {
    address public lastTo;
    function addLiquidity(
        address a, address b, uint256 ad, uint256 bd, uint256, uint256, address to, uint256
    ) external returns (uint256, uint256, uint256) {
        IERC20(a).transferFrom(msg.sender, address(this), ad);
        IERC20(b).transferFrom(msg.sender, address(this), bd);
        lastTo = to;
        return (ad, bd, ad + bd);
    }
    function addLiquidityETH(
        address token, uint256 td, uint256, uint256, address to, uint256
    ) external payable returns (uint256, uint256, uint256) {
        IERC20(token).transferFrom(msg.sender, address(this), td);
        lastTo = to;
        return (td, msg.value, td + msg.value);
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

contract TimbTreasuryTest is Test {
    MockTIMBS  timbs;
    MockWETH   weth;
    MockPair   pair;
    TimbTreasury treasury;

    address staking = address(0x5742);
    address escrow  = address(0xE5C0);

    function setUp() public {
        timbs = new MockTIMBS();
        weth  = new MockWETH();
        // Reserves: TIMBS is token0. 1e24 TIMBS / 1e21 WETH → ~1000 TIMBS per WETH.
        pair  = new MockPair(address(timbs), address(weth), uint112(1e24), uint112(1e21), address(timbs));
        // Fund the pair so it can pay out swaps.
        timbs.mint(address(pair), 1e24);

        treasury = new TimbTreasury(address(timbs), staking, escrow, address(pair), address(weth));
        // this contract deploys the treasury → it is the owner.
    }

    // Buyback splits 5% burn / 20% reserve / 75% waterfall; only the burn leaves.
    function testBuybackThreeWaySplit() public {
        vm.deal(address(treasury), 1 ether);

        uint256 balBefore = timbs.balanceOf(address(treasury));
        uint256 supplyBefore = timbs.totalSupply();

        treasury.executeBuyback(1 ether, 0);

        // Derive `bought` from the lifetime counters (this is the first buyback).
        uint256 burned    = treasury.totalTimbsBurned();
        uint256 waterfall = treasury.totalTimbsToWaterfall();
        uint256 reserved  = treasury.totalTimbsReserved();
        uint256 bought    = burned + waterfall + reserved;

        assertEq(burned,   bought * 5  / 100, "burn 5%");
        assertEq(reserved, bought * 20 / 100, "reserve 20%");
        assertEq(waterfall, bought - burned - reserved, "waterfall = rest (~75%)");

        // Only the burn left the treasury; reserve + waterfall stay in its balance.
        assertEq(timbs.balanceOf(address(treasury)) - balBefore, reserved + waterfall, "reserve+waterfall retained");
        // Burn reduced total supply by exactly `burned`.
        assertEq(supplyBefore - timbs.totalSupply(), burned, "supply burned");
    }

    // Ratio setters cap at burn + reserve <= 100.
    function testRatioCaps() public {
        // burn defaults 5, reserve defaults 20.
        vm.expectRevert(); // 5 + 96 > 100
        treasury.setBuybackReserveRatio(96);

        vm.expectRevert(); // 81 + 20 > 100
        treasury.setBuybackBurnRatio(81);

        // Valid moves.
        treasury.setBuybackBurnRatio(10);   // 10 + 20 = 30 ok
        treasury.setBuybackReserveRatio(50); // 10 + 50 = 60 ok
        assertEq(treasury.buybackBurnRatio(), 10);
        assertEq(treasury.buybackReserveRatio(), 50);
    }

    // provideLiquidityETH deploys treasury-held TIMBS + ETH; LP is minted back
    // to the treasury (router `to` == treasury) and the allowance is reset.
    function testProvideLiquidityETH_LPToTreasury() public {
        MockRouter router = new MockRouter();
        treasury.setRouter(address(router));

        timbs.mint(address(treasury), 5_000e18);
        vm.deal(address(treasury), 1 ether);

        treasury.provideLiquidityETH(address(timbs), 5_000e18, 1 ether, 0, 0);

        assertEq(router.lastTo(), address(treasury), "LP minted to the treasury");
        assertEq(timbs.allowance(address(treasury), address(router)), 0, "router allowance zeroed");
    }

    // provideLiquidity (token/token) same guarantees.
    function testProvideLiquidity_LPToTreasury() public {
        MockRouter router = new MockRouter();
        treasury.setRouter(address(router));

        MockTIMBS other = new MockTIMBS();
        timbs.mint(address(treasury), 1_000e18);
        other.mint(address(treasury), 1_000e18);

        treasury.provideLiquidity(address(timbs), address(other), 1_000e18, 1_000e18, 0, 0);

        assertEq(router.lastTo(), address(treasury), "LP minted to the treasury");
        assertEq(timbs.allowance(address(treasury), address(router)), 0, "tokenA allowance zeroed");
        assertEq(other.allowance(address(treasury), address(router)), 0, "tokenB allowance zeroed");
    }

    // provideLiquidity reverts if the router was never set.
    function testProvideLiquidityRevertsWithoutRouter() public {
        timbs.mint(address(treasury), 1_000e18);
        vm.deal(address(treasury), 1 ether);
        vm.expectRevert(); // ZeroAddress (router unset)
        treasury.provideLiquidityETH(address(timbs), 1_000e18, 1 ether, 0, 0);
    }

    // ─── M1: rate-limited operator ─────────────────────────────────────────────

    address operator = address(0x09E7);
    address dest     = address(0xD00D);

    // Operator may spend up to the cap; over-cap in the same window reverts.
    function testOperatorCapEnforced() public {
        vm.deal(address(treasury), 10 ether);
        treasury.setOperator(operator);
        treasury.setOperatorEthCap(0.5 ether, 1 days);

        vm.prank(operator);
        treasury.withdrawOperational(dest, 0.4 ether);
        assertEq(dest.balance, 0.4 ether, "first op withdrawal");

        // 0.4 + 0.2 > 0.5 cap → revert.
        vm.prank(operator);
        vm.expectRevert(); // OperatorCapExceeded
        treasury.withdrawOperational(dest, 0.2 ether);
    }

    // The cap is per-window: it resets once the period elapses.
    function testOperatorWindowRolls() public {
        vm.deal(address(treasury), 10 ether);
        treasury.setOperator(operator);
        treasury.setOperatorEthCap(0.5 ether, 1 days);

        vm.prank(operator);
        treasury.withdrawOperational(dest, 0.5 ether); // fills the window

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(operator);
        treasury.withdrawOperational(dest, 0.5 ether); // fresh window
        assertEq(dest.balance, 1 ether, "window did not roll");
    }

    // The timelock owner is not rate-limited.
    function testOwnerBypassesOperatorCap() public {
        vm.deal(address(treasury), 10 ether);
        treasury.setOperatorEthCap(0.5 ether, 1 days);
        // owner == this (deployer); withdraw far above the operator cap.
        treasury.withdrawOperational(dest, 5 ether);
        assertEq(dest.balance, 5 ether, "owner must be uncapped");
    }

    // A stranger (neither owner nor operator) cannot withdraw.
    function testOperationalWithdrawRejectsStranger() public {
        vm.deal(address(treasury), 10 ether);
        treasury.setOperator(operator);
        treasury.setOperatorEthCap(0.5 ether, 1 days);
        vm.prank(address(0xBAD));
        vm.expectRevert(); // NotAuthorised
        treasury.withdrawOperational(dest, 0.1 ether);
    }

    // With no cap set, the operator can withdraw nothing (cap defaults to 0).
    function testOperatorDisabledByDefault() public {
        vm.deal(address(treasury), 10 ether);
        treasury.setOperator(operator);
        vm.prank(operator);
        vm.expectRevert(); // OperatorCapExceeded (remaining == 0)
        treasury.withdrawOperational(dest, 1 wei);
    }
}
