// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../../contracts/TIMBSToken.sol";
import "../../contracts/TimbYieldVault.sol";

/**
 * @title TimbsHandler
 * @notice Drives the real TIMBSToken through minting by every minter role,
 *         minting attempts by outsiders, burns, transfers, pool rotation,
 *         transfer caps and pauses. The handler is the owner and treasury.
 */
contract TimbsHandler is Test {
    TIMBSToken public timbs;

    uint256 public constant GENESIS = 50_000_000e18;
    address public constant STAKING = address(0x57A1);
    address public constant FARM    = address(0xFA12);
    address[3] public holders = [address(0xC1), address(0xC2), address(0xC3)];

    uint256 public minted;            // ghost: emissions that went through
    uint256 public burned;            // ghost: burns that went through
    bool    public outsiderMinted;    // ghost: a non-minter's mintEmissions succeeded
    uint256 public capHits;           // ghost: mints refused at the cap
    uint256 public calls;
    mapping(bytes32 => uint256) public callCount;

    constructor() {
        timbs = new TIMBSToken(address(this), GENESIS, 0);
        timbs.setStakingPool(STAKING);
        timbs.setFarmPool(FARM);
    }

    function _count(bytes32 k) internal { calls++; callCount[k]++; }
    function _holder(uint256 seed) internal view returns (address) { return holders[seed % holders.length]; }

    /// @dev Owner, staking pool or farm pool mints; amounts range past the cap
    ///      so the cap check itself is exercised.
    function mint(uint256 who, uint256 toSeed, uint256 amount) external {
        _count("mint");
        address m = who % 3 == 0 ? address(this) : who % 3 == 1 ? timbs.stakingPool() : timbs.farmPool();
        amount = bound(amount, 1, timbs.HARD_CAP() - GENESIS);
        vm.prank(m);
        try timbs.mintEmissions(_holder(toSeed), amount) { minted += amount; } catch { capHits++; }
    }

    function outsiderMint(uint256 seed, uint256 amount) external {
        _count("outsiderMint");
        vm.prank(_holder(seed));
        try timbs.mintEmissions(_holder(seed), bound(amount, 1, 1e27)) { outsiderMinted = true; } catch {}
    }

    function burn(uint256 seed, uint256 frac) external {
        _count("burn");
        address u = _holder(seed);
        uint256 amt = timbs.balanceOf(u) * bound(frac, 0, 20) / 100;
        if (amt == 0) return;
        vm.prank(u);
        try timbs.burn(amt) { burned += amt; } catch {}
    }

    function treasuryBurn(uint256 amount) external {
        _count("treasuryBurn");
        amount = bound(amount, 1, 1e24);
        if (amount > timbs.balanceOf(address(this))) return;
        try timbs.burn(amount) { burned += amount; } catch {}
    }

    function distribute(uint256 seed, uint256 amount) external {
        _count("distribute");
        amount = bound(amount, 0, timbs.balanceOf(address(this)) / 10);
        try timbs.transfer(_holder(seed), amount) {} catch {}
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 frac) external {
        _count("transfer");
        address from = _holder(fromSeed);
        vm.prank(from);
        try timbs.transfer(_holder(toSeed), timbs.balanceOf(from) * bound(frac, 0, 100) / 100) {} catch {}
    }

    /// @dev Rotating a pool hands minting to the new address and takes it off the old.
    function rotatePool(uint256 seed, bool staking) external {
        _count("rotatePool");
        address next = address(uint160(0x10000 + bound(seed, 1, 50)));
        if (staking) timbs.setStakingPool(next);
        else timbs.setFarmPool(next);
    }

    function setCap(uint256 cap) external {
        _count("setCap");
        timbs.setMaxTransferAmount(bound(cap, 0, 1e25));
    }

    function togglePause(bool on) external {
        _count("pause");
        if (on && !timbs.paused()) timbs.pause();
        else if (!on && timbs.paused()) timbs.unpause();
    }

    function holderCount() external view returns (uint256) { return holders.length; }
}

/**
 * @title VaultHandler
 * @notice Drives the real TimbYieldVault, standing in for both the
 *         GameRegistry (register/remove) and TimbPrize (harvest), and as owner
 *         (rate, epochs, emergencyWithdraw). Tracks the expected weight book.
 */
contract VaultHandler is Test {
    TimbYieldVault public vault;

    address public constant SINK = address(0x5122);
    address public constant FUNDER = address(0xF00D);

    uint256 public ethIn;              // ghost: every wei dealt
    uint256 public funded;             // ghost: ETH sent into the vault
    uint256 public harvested;          // ghost: ETH the vault paid out as yield
    uint256 public withdrawn;          // ghost: emergencyWithdraw total
    uint256 public ghostWeight;        // ghost: expected totalWeight this epoch
    uint256 public calls;
    mapping(bytes32 => uint256) public callCount;
    mapping(uint256 => mapping(uint256 => uint256)) public ghostWeightOf; // epoch => id => w

    constructor() {
        vault = new TimbYieldVault();
        vault.setGameRegistry(address(this));
        vault.setTimbPrize(address(this));
        vault.setYieldAPRBps(10_000);
        vm.deal(FUNDER, 1_000 ether);
        ethIn = 1_000 ether;
    }

    receive() external payable {}

    function _count(bytes32 k) internal { calls++; callCount[k]++; }

    function register(uint256 id, uint256 amount) external {
        _count("register");
        id = bound(id, 1, 40);
        amount = bound(amount, 0, 1 ether);
        uint256 ep = vault.epoch();
        vault.register(id, address(0), amount);
        if (ghostWeightOf[ep][id] == 0 && amount > 0) {
            ghostWeightOf[ep][id] = amount;
            ghostWeight += amount;
        }
    }

    function remove(uint256 id) external {
        _count("remove");
        id = bound(id, 1, 40);
        uint256 ep = vault.epoch();
        vault.remove(id);
        ghostWeight -= ghostWeightOf[ep][id];
        ghostWeightOf[ep][id] = 0;
    }

    function fund(uint256 amount) external {
        _count("fund");
        amount = bound(amount, 1, 5 ether);
        if (amount > FUNDER.balance) return;
        vm.prank(FUNDER);
        vault.fund{value: amount}();
        funded += amount;
    }

    function warp(uint256 secs) external {
        _count("warp");
        vm.warp(block.timestamp + bound(secs, 1, 30 days));
    }

    function harvest() external {
        _count("harvest");
        harvested += vault.harvest();
    }

    function setApr(uint256 bps) external {
        _count("setApr");
        vault.setYieldAPRBps(bound(bps, 0, 1_000_000));
    }

    function newEpoch() external {
        _count("newEpoch");
        vault.newEpoch();
        ghostWeight = 0;
    }

    function emergencyWithdraw(uint256 amount) external {
        _count("emergencyWithdraw");
        uint256 avail = vault.reserve();
        if (avail == 0) return;
        amount = bound(amount, 1, avail);
        vault.emergencyWithdraw(SINK, amount);
        withdrawn += amount;
    }

    /// @dev Asking for more than the un-earmarked reserve must revert.
    function overWithdraw(uint256 extra) external {
        _count("overWithdraw");
        uint256 ask = vault.reserve() + bound(extra, 1, 1 ether);
        vm.expectRevert();
        vault.emergencyWithdraw(SINK, ask);
    }
}

/**
 * @title SupplyAndYieldInvariants
 * @notice TIMBS hard cap and supply accounting; yield vault backing, weight
 *         book and ETH conservation, after ANY sequence of handler actions.
 *
 * Run: forge test --match-contract SupplyAndYieldInvariants -vvv
 */
contract SupplyAndYieldInvariants is Test {
    TimbsHandler th;
    VaultHandler vh;

    function setUp() public {
        th = new TimbsHandler();
        vh = new VaultHandler();
        targetContract(address(th));
        targetContract(address(vh));
    }

    // ─── TIMBS ───────────────────────────────────────────────────────────────

    function invariant_SupplyNeverExceedsHardCap() public view {
        TIMBSToken t = th.timbs();
        assertLe(t.totalSupply(), t.HARD_CAP(), "TIMBS supply above HARD_CAP");
    }

    function invariant_SupplyMatchesMintsAndBurns() public view {
        assertEq(th.timbs().totalSupply(), th.GENESIS() + th.minted() - th.burned(), "supply != genesis + minted - burned");
    }

    function invariant_OnlyMintersMint() public view {
        assertFalse(th.outsiderMinted(), "a non-minter minted TIMBS");
    }

    function invariant_BalancesSumToSupply() public view {
        TIMBSToken t = th.timbs();
        uint256 sum = t.balanceOf(address(th));
        for (uint256 i = 0; i < th.holderCount(); i++) sum += t.balanceOf(th.holders(i));
        assertEq(sum, t.totalSupply(), "TIMBS held outside the known holders");
    }

    // ─── Yield vault ─────────────────────────────────────────────────────────

    /// Accrued pot yield is always backed by ETH the vault holds.
    function invariant_AccruedBackedByBalance() public view {
        TimbYieldVault v = vh.vault();
        assertLe(v.accruedForPot(), address(v).balance, "accruedForPot > vault balance");
    }

    function invariant_WeightBookMatches() public view {
        assertEq(vh.vault().totalWeight(), vh.ghostWeight(), "totalWeight != registered - removed");
    }

    /// The vault never pays out more than it was funded with.
    function invariant_PaidOutNeverExceedsFunded() public view {
        assertLe(vh.harvested() + vh.withdrawn(), vh.funded(), "vault paid out more than it received");
        assertEq(address(vh.vault()).balance, vh.funded() - vh.harvested() - vh.withdrawn(), "vault balance drift");
    }

    function invariant_VaultEthConserved() public view {
        uint256 sum = address(vh.vault()).balance + address(vh).balance + vh.SINK().balance + vh.FUNDER().balance;
        assertEq(sum, vh.ethIn(), "ETH created or destroyed");
    }

    function invariant_callSummary() public view {
        console.log("TIMBS calls", th.calls(), "minted", th.minted() / 1e18);
        console.log("  refused mints", th.capHits());
        console.log("  supply", th.timbs().totalSupply() / 1e18, "burned", th.burned() / 1e18);
        console.log("vault calls", vh.calls(), "harvested", vh.harvested());
        console.log("  funded/withdrawn", vh.funded(), vh.withdrawn());
    }
}
