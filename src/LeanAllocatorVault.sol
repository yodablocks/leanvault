// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LeanYieldBase} from "./LeanYieldBase.sol";
import {IStrategy} from "./IStrategy.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title LeanAllocatorVault
/// @notice LeanYieldBase over several ERC4626 strategies, with the authority to
///         move funds between them bounded on-chain so that a curator, human or
///         automated, can be wrong without being able to drain the vault:
///         - Strategies are allowlisted by the owner through a timelock, so
///           depositors can see a new strategy coming and leave first.
///         - Every strategy has a cap. Deposits and rebalances cannot push it over.
///         - An allocator role may rebalance between allowlisted strategies, at
///           most `rebalanceLimit` assets per 24-hour window.
///         - Deposits go to one designated strategy. Withdrawals drain the
///           strategies in list order until the amount is covered.
///         - Deposits and withdrawals never read a strategy's price; the share
///           price moves only through harvest and the stream, as in LeanYieldBase.
/// @dev Plain Solidity, no assembly. No fee. Unaudited.
contract LeanAllocatorVault is LeanYieldBase {
    using SafeTransferLib for address;

    uint256 public constant MIN_TIMELOCK = 1 hours;
    uint256 public constant MAX_TIMELOCK = 30 days;
    uint256 public constant REBALANCE_WINDOW = 24 hours;

    struct StrategyInfo {
        bool active;
        uint96 cap;
        uint40 proposedAt;
        uint96 proposedCap;
    }

    address[] private _strategies;
    mapping(address => StrategyInfo) public strategyInfo;

    address public depositTarget;
    address public allocator;
    uint256 public timelock;

    // One slot: assets moved in the current rebalance window, its start, and the limit.
    uint96 private _movedInWindow;
    uint40 private _windowStart;
    uint96 public rebalanceLimit;

    event StrategyProposed(address indexed strategy, uint256 cap, uint256 executableAt);
    event StrategyAdded(address indexed strategy, uint256 cap);
    event StrategyRemoved(address indexed strategy);
    event CapSet(address indexed strategy, uint256 cap);
    event DepositTargetSet(address indexed strategy);
    event AllocatorSet(address indexed allocator);
    event TimelockSet(uint256 timelock);
    event RebalanceLimitSet(uint256 limit);
    event Rebalanced(address indexed from, address indexed to, uint256 assets);

    error StrategyAssetMismatch();
    error StrategyNotActive();
    error StrategyAlreadyActive();
    error NotProposed();
    error TimelockNotElapsed();
    error StrategyNotEmpty();
    error CapExceeded();
    error InvalidTimelock();
    error InvalidCap();
    error NotAllocator();
    error RebalanceLimitExceeded();
    error InsufficientLiquidity();
    error StrategyMintedNothing();
    error NoDepositTarget();

    constructor(
        address asset_,
        string memory name_,
        string memory symbol_,
        uint256 unlockPeriod_,
        uint256 timelock_
    ) LeanYieldBase(asset_, name_, symbol_, unlockPeriod_) {
        _setTimelock(timelock_);
    }

    modifier onlyAllocator() {
        if (msg.sender != allocator && msg.sender != owner) revert NotAllocator();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                            STRATEGY ALLOWLIST
    //////////////////////////////////////////////////////////////*/

    function strategies() external view returns (address[] memory) {
        return _strategies;
    }

    /// @notice Start the clock on a new strategy. Anyone can see it coming.
    function proposeStrategy(address strategy_, uint256 cap) external onlyOwner {
        if (strategy_ == address(0)) revert ZeroAddress();
        if (strategyInfo[strategy_].active) revert StrategyAlreadyActive();
        if (IStrategy(strategy_).asset() != asset) revert StrategyAssetMismatch();
        if (cap > MAX_96_BITS) revert InvalidCap();
        StrategyInfo storage info = strategyInfo[strategy_];
        // forge-lint: disable-next-line(unsafe-typecast)
        info.proposedAt = uint40(block.timestamp);
        // forge-lint: disable-next-line(unsafe-typecast)
        info.proposedCap = uint96(cap);
        emit StrategyProposed(strategy_, cap, block.timestamp + timelock);
    }

    /// @notice Activate a proposed strategy once the timelock has elapsed.
    function acceptStrategy(address strategy_) external onlyOwner {
        StrategyInfo storage info = strategyInfo[strategy_];
        if (info.active) revert StrategyAlreadyActive();
        if (info.proposedAt == 0) revert NotProposed();
        if (block.timestamp < uint256(info.proposedAt) + timelock) revert TimelockNotElapsed();
        info.active = true;
        info.cap = info.proposedCap;
        info.proposedAt = 0;
        info.proposedCap = 0;
        _strategies.push(strategy_);
        asset.safeApprove(strategy_, type(uint256).max);
        if (depositTarget == address(0)) {
            depositTarget = strategy_;
            emit DepositTargetSet(strategy_);
        }
        emit StrategyAdded(strategy_, info.cap);
    }

    /// @notice Drop a strategy that holds nothing. Exit it through rebalance first.
    function removeStrategy(address strategy_) external onlyOwner {
        StrategyInfo storage info = strategyInfo[strategy_];
        if (!info.active) revert StrategyNotActive();
        if (IStrategy(strategy_).balanceOf(address(this)) != 0) revert StrategyNotEmpty();
        if (strategy_ == depositTarget) revert StrategyNotEmpty();
        info.active = false;
        info.cap = 0;
        uint256 n = _strategies.length;
        for (uint256 i = 0; i < n; i++) {
            if (_strategies[i] == strategy_) {
                _strategies[i] = _strategies[n - 1];
                _strategies.pop();
                break;
            }
        }
        asset.safeApprove(strategy_, 0);
        emit StrategyRemoved(strategy_);
    }

    function setCap(address strategy_, uint256 cap) external onlyOwner {
        if (!strategyInfo[strategy_].active) revert StrategyNotActive();
        if (cap > MAX_96_BITS) revert InvalidCap();
        // forge-lint: disable-next-line(unsafe-typecast)
        strategyInfo[strategy_].cap = uint96(cap);
        emit CapSet(strategy_, cap);
    }

    function setDepositTarget(address strategy_) external onlyOwner {
        if (!strategyInfo[strategy_].active) revert StrategyNotActive();
        depositTarget = strategy_;
        emit DepositTargetSet(strategy_);
    }

    function setAllocator(address allocator_) external onlyOwner {
        allocator = allocator_;
        emit AllocatorSet(allocator_);
    }

    function setTimelock(uint256 timelock_) external onlyOwner {
        _setTimelock(timelock_);
    }

    function _setTimelock(uint256 timelock_) private {
        if (timelock_ < MIN_TIMELOCK || timelock_ > MAX_TIMELOCK) revert InvalidTimelock();
        timelock = timelock_;
        emit TimelockSet(timelock_);
    }

    function setRebalanceLimit(uint256 limit) external onlyOwner {
        if (limit > MAX_96_BITS) revert InvalidCap();
        // forge-lint: disable-next-line(unsafe-typecast)
        rebalanceLimit = uint96(limit);
        emit RebalanceLimitSet(limit);
    }

    /*//////////////////////////////////////////////////////////////
                               REBALANCING
    //////////////////////////////////////////////////////////////*/

    /// @notice Assets the allocator may still move in the current 24-hour window.
    function rebalanceAvailable() public view returns (uint256) {
        if (block.timestamp >= uint256(_windowStart) + REBALANCE_WINDOW) return rebalanceLimit;
        uint256 moved = _movedInWindow;
        uint256 limit = rebalanceLimit;
        return limit > moved ? limit - moved : 0;
    }

    /// @notice Move `assets` from one allowlisted strategy to another, within the
    ///         destination's cap and the per-window limit.
    function rebalance(address from, address to, uint256 assets) external onlyAllocator nonReentrant {
        if (!strategyInfo[from].active || !strategyInfo[to].active) revert StrategyNotActive();
        if (assets == 0) revert ZeroAmount();
        if (from == to) revert StrategyNotActive();

        if (block.timestamp >= uint256(_windowStart) + REBALANCE_WINDOW) {
            // forge-lint: disable-next-line(unsafe-typecast)
            _windowStart = uint40(block.timestamp);
            _movedInWindow = 0;
        }
        uint256 moved = uint256(_movedInWindow) + assets;
        if (moved > rebalanceLimit) revert RebalanceLimitExceeded();
        // forge-lint: disable-next-line(unsafe-typecast)
        _movedInWindow = uint96(moved);

        _checkCap(to, assets);

        // forge-lint: disable-next-line(unused-return)
        IStrategy(from).withdraw(assets, address(this), address(this));
        if (IStrategy(to).deposit(assets, address(this)) == 0) revert StrategyMintedNothing();

        emit Rebalanced(from, to, assets);
    }

    function _valuation(address strategy_) private view returns (uint256) {
        IStrategy s = IStrategy(strategy_);
        return s.convertToAssets(s.balanceOf(address(this)));
    }

    function _checkCap(address strategy_, uint256 incoming) private view {
        if (_valuation(strategy_) + incoming > strategyInfo[strategy_].cap) revert CapExceeded();
    }

    function _strategyValuation() internal view override returns (uint256 total) {
        uint256 n = _strategies.length;
        for (uint256 i = 0; i < n; i++) {
            total += _valuation(_strategies[i]);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 HOOKS
    //////////////////////////////////////////////////////////////*/

    function _afterDeposit(uint256 assets) internal override {
        address target = depositTarget;
        if (target == address(0)) revert NoDepositTarget();
        _checkCap(target, assets);
        if (IStrategy(target).deposit(assets, address(this)) == 0) revert StrategyMintedNothing();
    }

    /// @dev Drain strategies in list order until `assets` are paid to `receiver`.
    function _sendAssets(uint256 assets, address receiver) internal override {
        uint256 remaining = assets;
        uint256 n = _strategies.length;
        for (uint256 i = 0; i < n && remaining > 0; i++) {
            IStrategy s = IStrategy(_strategies[i]);
            uint256 available = s.maxWithdraw(address(this));
            if (available == 0) continue;
            uint256 take = available < remaining ? available : remaining;
            // forge-lint: disable-next-line(unused-return)
            s.withdraw(take, receiver, address(this));
            remaining -= take;
        }
        if (remaining != 0) revert InsufficientLiquidity();
    }

    /*//////////////////////////////////////////////////////////////
                         LIMITS FOLLOW THE STRATEGIES
    //////////////////////////////////////////////////////////////*/

    function maxDeposit(address receiver) public view override returns (uint256) {
        address target = depositTarget;
        if (target == address(0)) return 0;
        uint256 own = super.maxDeposit(receiver);
        uint256 cap = strategyInfo[target].cap;
        uint256 held = _valuation(target);
        uint256 headroom = cap > held ? cap - held : 0;
        uint256 strat = IStrategy(target).maxDeposit(address(this));
        uint256 limit = headroom < strat ? headroom : strat;
        return own < limit ? own : limit;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        uint256 assets = maxDeposit(receiver);
        return _toShares(assets, _netTotalAssets(_totalAssets), _totalSupply, false);
    }

    /// @notice Everything the strategies can pay right now.
    function availableLiquidity() public view returns (uint256 total) {
        uint256 n = _strategies.length;
        for (uint256 i = 0; i < n; i++) {
            total += IStrategy(_strategies[i]).maxWithdraw(address(this));
        }
    }

    function maxWithdraw(address account) public view override returns (uint256) {
        uint256 own = super.maxWithdraw(account);
        uint256 liquid = availableLiquidity();
        return own < liquid ? own : liquid;
    }

    function maxRedeem(address account) public view override returns (uint256) {
        uint256 assets = maxWithdraw(account);
        uint256 own = _balances[account];
        uint256 byLiquidity = _toShares(assets, _netTotalAssets(_totalAssets), _totalSupply, false);
        return own < byLiquidity ? own : byLiquidity;
    }
}
