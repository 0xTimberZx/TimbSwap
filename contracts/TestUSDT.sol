// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title TestUSDT
 * @notice 6-decimal Tether stand-in for Arbitrum Sepolia. Tether issues no
 *         official testnet USDT (unlike Circle's canonical testnet USDC), so
 *         the ecosystem deploys its own: same 6-decimal convention as the
 *         real thing, owner-mintable, plus a capped public faucet so other
 *         test wallets can self-serve for swap/liquidity testing.
 *
 *         NOT for the EligibleTokenRegistry — stable↔stable swaps carry no
 *         price exposure and would make intermission-window nudge sniping
 *         (a privilege reserved for economically meaningful volume) free.
 *         See dev-docs/CONTRACT_TODO.md §12.
 */
contract TestUSDT is ERC20, Ownable {
    /// @notice 100 USDT per faucet call (6 decimals).
    uint256 public constant FAUCET_AMOUNT = 100 * 10 ** 6;

    /// @notice wallet → last faucet drip timestamp.
    mapping(address => uint256) public lastDrip;

    error FaucetCooldown(uint256 nextDripAt);

    constructor() ERC20("Tether USD (Test)", "USDT") Ownable(msg.sender) {
        _mint(msg.sender, 1_000_000 * 10 ** 6); // 1M USDT to deployer
    }

    /// @dev Real USDT is 6 decimals — match it so frontend math is honest.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice 100 USDT per address per day — enough to test, hard to farm.
    function faucet() external {
        uint256 nextAt = lastDrip[msg.sender] + 1 days;
        if (block.timestamp < nextAt) revert FaucetCooldown(nextAt);
        lastDrip[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}
