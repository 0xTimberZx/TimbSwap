// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TimbSwapFactory} from "../contracts/TimbSwapFactory.sol";
import {TimbSwapRouter} from "../contracts/TimbSwapRouter.sol";
import {TimbSwapPair} from "../contracts/TimbSwapPair.sol";

contract SeedToken is ERC20 {
    constructor(string memory n) ERC20(n, n) { _mint(msg.sender, 1e30); }
}

/**
 * TS-020 — a 1-wei donation + sync() must not stop the router seeding a pair.
 *
 * With (dust, 0) reserves and no LP supply, the router used to quote against
 * the dust and revert on every add-liquidity call for that pair. It now treats
 * a zero-supply pair as unseeded and passes the desired amounts straight to
 * the pair's first mint, which prices off balance - reserve.
 *
 * Run: forge test --match-contract EmptyPairSeedTest -vvv
 */
contract EmptyPairSeedTest is Test {
    SeedToken a;
    SeedToken b;
    TimbSwapFactory factory;
    TimbSwapRouter router;
    address griefer = address(0x6A1E);

    function setUp() public {
        a = new SeedToken("A");
        b = new SeedToken("B");
        factory = new TimbSwapFactory(address(0x7EA5));
        router  = new TimbSwapRouter(address(factory), address(0x7EA5), address(0), address(0), address(0xE7E7));
        factory.setRouter(address(router));
        a.approve(address(router), type(uint256).max);
        b.approve(address(router), type(uint256).max);
        a.transfer(griefer, 10);
    }

    function test_TS020_DustSyncDoesNotBlockFirstLiquidity() public {
        address pair = factory.createPair(address(a), address(b)); // permissionless

        vm.startPrank(griefer);
        a.transfer(pair, 1);
        TimbSwapPair(pair).sync();                                  // reserves (1, 0)
        vm.stopPrank();

        (uint256 liq) = _add(100 ether, 100 ether);
        assertGt(liq, 0, "first LP minted despite the dust");
        assertEq(TimbSwapPair(pair).balanceOf(address(this)), liq);

        // Normal quoting resumes once the pair is seeded.
        uint256 liq2 = _add(10 ether, 10 ether);
        assertGt(liq2, 0, "second add quotes normally");
    }

    function _add(uint256 x, uint256 y) internal returns (uint256 liq) {
        (, , liq) = router.addLiquidity(address(a), address(b), x, y, 0, 0, address(this), block.timestamp);
    }
}
