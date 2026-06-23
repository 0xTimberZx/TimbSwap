// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title TimbSwapFactory
 * @notice Creates and indexes TimbSwap AMM pairs.
 *
 * Architecture:
 *   - Uniswap v2-style factory: one pair per token0/token1 combination.
 *   - 0.3% flat fee per swap (0.25% LP, 0.05% protocol).
 *   - Partner pool flag: any pair can be designated to route LP fees
 *     to an external destination (e.g. BlockpotDAO PrizeVault v3).
 *     This is opt-in, owner-configurable per pair, not active at launch.
 *   - Permissionless pair creation — anyone can create a pair.
 *   - Emissions whitelist — only owner can add pairs to TIMBS rewards list.
 *
 * Security (defiSKILL):
 *   - ReentrancyGuard on createPair() — pair address determined before
 *     any external calls (prevents bonding-curve / phi H-06 pattern).
 *   - Pair stored atomically: allPairs + getPair updated in same tx.
 *   - No TOCTOU on pair creation (existence check before CREATE2).
 *   - Emergency pause on pair creation.
 *   - Router authorization stored here — Router must be registered
 *     before it can call privileged factory functions.
 *
 * Deployment order:
 *   1. Deploy TimbSwapFactory(feeTo, protocolFeeBps)
 *   2. Deploy TimbSwapRouter(factory)
 *   3. Call factory.setRouter(router)
 *   4. Deploy TIMBSToken, then call setTimbsToken(address)
 *   5. createPair(TIMBS, WETH) — seeds the emissions pair
 *   6. addToEmissionsWhitelist(pair) for TIMBS/ETH pair only
 */
contract TimbSwapFactory is Ownable, ReentrancyGuard {

    // ─── Constants ───────────────────────────────────────────────────────────

    /// @notice Total swap fee in basis points (0.3% = 30 bps).
    uint256 public constant TOTAL_FEE_BPS = 30;

    /// @notice LP share of total fee in basis points (0.25% = 25 bps).
    uint256 public constant LP_FEE_BPS = 25;

    /// @notice Protocol share of total fee in basis points (0.05% = 5 bps).
    uint256 public constant PROTOCOL_FEE_BPS = 5;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    // ─── State ───────────────────────────────────────────────────────────────

    /// @notice Address that receives the protocol fee (TimbTreasury).
    address public feeTo;

    /// @notice Registered TimbSwapRouter — only address allowed to
    ///         call privileged factory functions.
    address public router;

    /// @notice TIMBS token address — used to identify the emissions pair.
    address public timbsToken;

    /// @notice Pair creation paused (emergency).
    bool public paused;

    /// @notice token0 => token1 => pair address.
    ///         token0 < token1 always (sorted on creation).
    mapping(address => mapping(address => address)) public getPair;

    /// @notice All created pairs in order of creation.
    address[] public allPairs;

    /// @notice Pairs eligible for TIMBS emissions rewards.
    ///         Only TIMBS/ETH LP at launch — owner-extendable.
    mapping(address => bool) public emissionsWhitelist;

    /// @notice Partner pool flag — pair routes LP fees to an external
    ///         destination instead of distributing to LPs directly.
    ///         Opt-in, owner-set per pair. Not active at launch.
    mapping(address => bool) public isPartnerPool;

    /// @notice Partner destination per pair — where LP fees are routed
    ///         when isPartnerPool[pair] == true.
    mapping(address => address) public partnerDestination;

    // ─── Events ──────────────────────────────────────────────────────────────

    event PairCreated(
        address indexed token0,
        address indexed token1,
        address pair,
        uint256 pairIndex
    );
    event FeeToUpdated(address indexed oldFeeTo, address indexed newFeeTo);
    event RouterSet(address indexed router);
    event TimbsTokenSet(address indexed timbsToken);
    event EmissionsWhitelistUpdated(address indexed pair, bool whitelisted);
    event PartnerPoolSet(address indexed pair, address indexed destination, bool active);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error IdenticalAddresses();
    error PairExists(address pair);
    error PairCreationPaused();
    error NotRouter();
    error PairNotFound();
    error InvalidFee();

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier whenNotPaused() {
        if (paused) revert PairCreationPaused();
        _;
    }

    modifier onlyRouter() {
        if (msg.sender != router) revert NotRouter();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    /**
     * @param _feeTo Address that receives protocol fees (TimbTreasury).
     */
    constructor(address _feeTo) Ownable(msg.sender) {
        if (_feeTo == address(0)) revert ZeroAddress();
        feeTo = _feeTo;
        emit FeeToUpdated(address(0), _feeTo);
    }

    // ─── Pair Creation ────────────────────────────────────────────────────────

    /**
     * @notice Create a new AMM pair for tokenA and tokenB.
     * @dev Permissionless — anyone can create a pair.
     *      Pair address is fully determined (CREATE2) before any external
     *      calls, preventing bonding-curve / reentrancy manipulation.
     *      Tokens are sorted so token0 < token1 (canonical ordering).
     * @param tokenA First token address.
     * @param tokenB Second token address.
     * @return pair The address of the newly created pair contract.
     */
    function createPair(address tokenA, address tokenB)
        external
        nonReentrant
        whenNotPaused
        returns (address pair)
    {
        if (tokenA == tokenB) revert IdenticalAddresses();
        if (tokenA == address(0) || tokenB == address(0)) revert ZeroAddress();

        // Sort tokens — canonical ordering: token0 < token1
        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);

        // Check pair doesn't already exist
        if (getPair[token0][token1] != address(0)) {
            revert PairExists(getPair[token0][token1]);
        }

        // Compute CREATE2 salt from sorted token addresses
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));

        // Deploy pair via CREATE2 — address fully determined before external calls
        // TimbSwapPair bytecode will be referenced here once written
        // Placeholder: pair = address(new TimbSwapPair{salt: salt}(token0, token1));
        // For now store a deterministic placeholder address for architecture wiring
        pair = _computePairAddress(token0, token1, salt);

        // Store atomically — both mappings updated before any external interaction
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair; // reverse mapping for convenience
        allPairs.push(pair);

        emit PairCreated(token0, token1, pair, allPairs.length - 1);
    }

    /**
     * @dev Computes the deterministic CREATE2 address for a pair.
     *      Will be replaced with actual TimbSwapPair bytecode hash
     *      once TimbSwapPair.sol is written.
     */
    function _computePairAddress(
        address token0,
        address token1,
        bytes32 salt
    ) internal view returns (address) {
        // Placeholder — real implementation uses:
        // keccak256(abi.encodePacked(
        //     bytes1(0xff), address(this), salt,
        //     keccak256(type(TimbSwapPair).creationCode)
        // ))
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff),
            address(this),
            salt,
            keccak256(abi.encodePacked(token0, token1, block.chainid))
        )))));
    }

    // ─── Owner: Protocol Config ───────────────────────────────────────────────

    /**
     * @notice Update the protocol fee recipient (TimbTreasury).
     */
    function setFeeTo(address _feeTo) external onlyOwner {
        if (_feeTo == address(0)) revert ZeroAddress();
        emit FeeToUpdated(feeTo, _feeTo);
        feeTo = _feeTo;
    }

    /**
     * @notice Register the TimbSwapRouter. Required before any swaps.
     */
    function setRouter(address _router) external onlyOwner {
        if (_router == address(0)) revert ZeroAddress();
        router = _router;
        emit RouterSet(_router);
    }

    /**
     * @notice Set the TIMBS token address.
     * @dev Used to identify the TIMBS/ETH pair for emissions routing.
     */
    function setTimbsToken(address _timbsToken) external onlyOwner {
        if (_timbsToken == address(0)) revert ZeroAddress();
        timbsToken = _timbsToken;
        emit TimbsTokenSet(_timbsToken);
    }

    /**
     * @notice Add or remove a pair from the TIMBS emissions whitelist.
     * @dev Only whitelisted pairs receive TIMBS staking/farm emissions.
     *      At launch: TIMBS/ETH only. Owner-extendable.
     */
    function setEmissionsWhitelist(address pair, bool whitelisted)
        external
        onlyOwner
    {
        if (pair == address(0)) revert ZeroAddress();
        emissionsWhitelist[pair] = whitelisted;
        emit EmissionsWhitelistUpdated(pair, whitelisted);
    }

    /**
     * @notice Designate a pair as a partner pool.
     * @dev When active, the pair routes LP fees to `destination`
     *      instead of distributing pro-rata to LPs.
     *      Use case: route fees to BlockpotDAO PrizeVault v3.
     *      Not active at launch — opt-in per pool.
     * @param pair        The pair contract address.
     * @param destination Where LP fees are sent (e.g. PrizeVault).
     * @param active      True to enable, false to disable.
     */
    function setPartnerPool(
        address pair,
        address destination,
        bool active
    ) external onlyOwner {
        if (pair == address(0)) revert ZeroAddress();
        if (active && destination == address(0)) revert ZeroAddress();
        isPartnerPool[pair] = active;
        partnerDestination[pair] = active ? destination : address(0);
        emit PartnerPoolSet(pair, destination, active);
    }

    /**
     * @notice Pause pair creation. Emergency use only.
     */
    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Unpause pair creation.
     */
    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ─── View Helpers ─────────────────────────────────────────────────────────

    /**
     * @notice Total number of pairs created.
     */
    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /**
     * @notice Returns the pair address for two tokens (either order).
     *         Returns address(0) if the pair doesn't exist.
     */
    function getPairAddress(address tokenA, address tokenB)
        external
        view
        returns (address pair)
    {
        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);
        return getPair[token0][token1];
    }

    /**
     * @notice Returns whether a pair is eligible for TIMBS emissions.
     */
    function isPairEmissionsEligible(address pair)
        external
        view
        returns (bool)
    {
        return emissionsWhitelist[pair];
    }

    /**
     * @notice Returns partner pool config for a pair.
     */
    function getPartnerConfig(address pair)
        external
        view
        returns (bool active, address destination)
    {
        return (isPartnerPool[pair], partnerDestination[pair]);
    }

    /**
     * @notice Returns protocol fee split in basis points.
     * @dev Useful for Router to calculate fee distribution without
     *      hardcoding values.
     */
    function getFeeConfig()
        external
        pure
        returns (
            uint256 totalBps,
            uint256 lpBps,
            uint256 protocolBps,
            uint256 denominator
        )
    {
        return (TOTAL_FEE_BPS, LP_FEE_BPS, PROTOCOL_FEE_BPS, BPS_DENOMINATOR);
    }
}
