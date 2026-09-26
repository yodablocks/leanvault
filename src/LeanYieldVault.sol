// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LeanVaultBase} from "./LeanVaultBase.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @dev The subset of ERC4626 a strategy must implement.
interface IStrategy {
    function asset() external view returns (address);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function balanceOf(address account) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function maxDeposit(address receiver) external view returns (uint256);
    function maxWithdraw(address owner) external view returns (uint256);
}

/// @title LeanYieldVault
/// @notice LeanVaultBase that routes every deposit into another ERC4626 vault,
///         the strategy, and pays withdrawals straight out of it.
///
///         Yield accounting follows the Yearn V3 and Euler Earn model:
///         - `harvest()` is callable by anyone. It compares the strategy's
///           valuation with the vault's own total.
///         - A gain is not credited at once. It is locked and released linearly
///           over `unlockPeriod`, so the share price rises as a stream and a
///           deposit timed just before a harvest captures nothing.
///         - A loss is recognized immediately, eating locked profit first.
///         Between harvests the price is what the last harvest left, adjusted
///         for the stream. The vault never reads the strategy's price inside
///         deposit or withdraw, so a strategy whose valuation can be moved
///         within a block cannot move this vault's price without a harvest,
///         and even then only through the stream.
/// @dev Plain Solidity, no assembly. No fee. Unaudited.
contract LeanYieldVault is LeanVaultBase {
    using SafeTransferLib for address;

    IStrategy public immutable strategy;

    uint256 public constant MIN_UNLOCK_PERIOD = 1 hours;
    uint256 public constant MAX_UNLOCK_PERIOD = 30 days;

    // One slot: profit still locked at `unlockStart`, and the window it streams over.
    uint96 private _lockedProfit;
    uint40 private _unlockStart;
    uint40 private _unlockEnd;
    uint40 public unlockPeriod;

    event Harvest(uint256 gain, uint256 loss, uint256 totalAssets, uint256 lockedProfit);
    event UnlockPeriodSet(uint256 unlockPeriod);

    error StrategyAssetMismatch();
    error InvalidUnlockPeriod();
    error StrategyMintedNothing();

    constructor(
        address asset_,
        address strategy_,
        string memory name_,
        string memory symbol_,
        uint256 unlockPeriod_
    ) LeanVaultBase(asset_, name_, symbol_) {
        if (strategy_ == address(0)) revert ZeroAddress();
        if (IStrategy(strategy_).asset() != asset_) revert StrategyAssetMismatch();
        if (unlockPeriod_ < MIN_UNLOCK_PERIOD || unlockPeriod_ > MAX_UNLOCK_PERIOD) revert InvalidUnlockPeriod();
        strategy = IStrategy(strategy_);
        // forge-lint: disable-next-line(unsafe-typecast)
        unlockPeriod = uint40(unlockPeriod_);
        asset_.safeApprove(strategy_, type(uint256).max);
        emit UnlockPeriodSet(unlockPeriod_);
    }

    /*//////////////////////////////////////////////////////////////
                              PROFIT STREAM
    //////////////////////////////////////////////////////////////*/

    /// @notice Profit that has not yet been released into the share price.
    function lockedProfit() public view returns (uint256) {
        return _lockedAt(block.timestamp);
    }

    function _lockedAt(uint256 timestamp) internal view returns (uint256) {
        uint256 end = _unlockEnd;
        if (timestamp >= end) return 0;
        uint256 start = _unlockStart;
        uint256 locked = _lockedProfit;
        // Linear release from start to end; timestamp is within the window here.
        return locked * (end - timestamp) / (end - start);
    }

    function _netTotalAssets(uint256 totalAssets_) internal view override returns (uint256) {
        return totalAssets_ - _lockedAt(block.timestamp);
    }

    /// @notice Sync the vault's total with the strategy's valuation. Anyone may call.
    ///         Gains start streaming over `unlockPeriod`; losses apply at once.
    function harvest() external nonReentrant returns (uint256 gain, uint256 loss) {
        uint256 gross = _totalAssets;
        uint256 valuation = strategy.convertToAssets(strategy.balanceOf(address(this)));
        if (valuation > MAX_96_BITS) valuation = MAX_96_BITS;

        uint256 stillLocked = _lockedAt(block.timestamp);
        uint256 newLocked;

        if (valuation > gross) {
            gain = valuation - gross;
            newLocked = stillLocked + gain;
        } else {
            loss = gross - valuation;
            // Losses consume locked profit before they touch the price.
            newLocked = stillLocked > loss ? stillLocked - loss : 0;
        }
        if (newLocked > MAX_96_BITS) newLocked = MAX_96_BITS;

        // forge-lint: disable-next-line(unsafe-typecast)
        _lockedProfit = uint96(newLocked);
        // forge-lint: disable-next-line(unsafe-typecast)
        _unlockStart = uint40(block.timestamp);
        // forge-lint: disable-next-line(unsafe-typecast)
        _unlockEnd = uint40(block.timestamp + unlockPeriod);
        _store(valuation, _totalSupply);

        emit Harvest(gain, loss, valuation, newLocked);
    }

    function setUnlockPeriod(uint256 unlockPeriod_) external onlyOwner {
        if (unlockPeriod_ < MIN_UNLOCK_PERIOD || unlockPeriod_ > MAX_UNLOCK_PERIOD) revert InvalidUnlockPeriod();
        // forge-lint: disable-next-line(unsafe-typecast)
        unlockPeriod = uint40(unlockPeriod_);
        emit UnlockPeriodSet(unlockPeriod_);
    }

    /*//////////////////////////////////////////////////////////////
                                 HOOKS
    //////////////////////////////////////////////////////////////*/

    function _afterDeposit(uint256 assets) internal override {
        // A strategy that takes the assets and mints nothing would swallow the deposit.
        if (strategy.deposit(assets, address(this)) == 0) revert StrategyMintedNothing();
    }

    function _sendAssets(uint256 assets, address receiver) internal override {
        // The strategy pays `receiver` directly; how many strategy shares it burned is not needed here.
        // forge-lint: disable-next-line(unused-return)
        strategy.withdraw(assets, receiver, address(this));
    }

    /*//////////////////////////////////////////////////////////////
                         LIMITS FOLLOW THE STRATEGY
    //////////////////////////////////////////////////////////////*/

    function maxDeposit(address receiver) public view override returns (uint256) {
        uint256 own = super.maxDeposit(receiver);
        uint256 strat = strategy.maxDeposit(address(this));
        return own < strat ? own : strat;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        uint256 assets = maxDeposit(receiver);
        return _toShares(assets, _netTotalAssets(_totalAssets), _totalSupply, false);
    }

    function maxWithdraw(address account) public view override returns (uint256) {
        uint256 own = super.maxWithdraw(account);
        uint256 strat = strategy.maxWithdraw(address(this));
        return own < strat ? own : strat;
    }

    function maxRedeem(address account) public view override returns (uint256) {
        uint256 assets = maxWithdraw(account);
        uint256 own = _balances[account];
        uint256 byLiquidity = _toShares(assets, _netTotalAssets(_totalAssets), _totalSupply, false);
        return own < byLiquidity ? own : byLiquidity;
    }
}
