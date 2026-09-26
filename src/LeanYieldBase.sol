// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LeanVaultBase} from "./LeanVaultBase.sol";

/// @title LeanYieldBase
/// @notice The yield accounting shared by every strategy-backed LeanVault:
///         a permissionless harvest that syncs the vault's total with a
///         valuation the subclass computes, gains streamed linearly over
///         `unlockPeriod`, losses recognized at once and eating locked profit
///         first. Follows the Yearn V3 and Euler Earn model.
/// @dev Plain Solidity, no assembly. Unaudited.
abstract contract LeanYieldBase is LeanVaultBase {
    uint256 public constant MIN_UNLOCK_PERIOD = 1 hours;
    uint256 public constant MAX_UNLOCK_PERIOD = 30 days;

    // One slot: profit still locked at `unlockStart`, and the window it streams over.
    uint96 private _lockedProfit;
    uint40 private _unlockStart;
    uint40 private _unlockEnd;
    uint40 public unlockPeriod;

    event Harvest(uint256 gain, uint256 loss, uint256 totalAssets, uint256 lockedProfit);
    event UnlockPeriodSet(uint256 unlockPeriod);

    error InvalidUnlockPeriod();

    constructor(address asset_, string memory name_, string memory symbol_, uint256 unlockPeriod_)
        LeanVaultBase(asset_, name_, symbol_)
    {
        _setUnlockPeriod(unlockPeriod_);
    }

    /// @dev What the strategies are worth right now, in assets. Read only in harvest.
    function _strategyValuation() internal view virtual returns (uint256);

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
        return locked * (end - timestamp) / (end - start);
    }

    function _netTotalAssets(uint256 totalAssets_) internal view override returns (uint256) {
        return totalAssets_ - _lockedAt(block.timestamp);
    }

    /// @notice Sync the vault's total with the strategies' valuation. Anyone may call.
    ///         Gains start streaming over `unlockPeriod`; losses apply at once.
    function harvest() external nonReentrant returns (uint256 gain, uint256 loss) {
        uint256 gross = _totalAssets;
        uint256 valuation = _strategyValuation();
        if (valuation > MAX_96_BITS) valuation = MAX_96_BITS;

        uint256 stillLocked = _lockedAt(block.timestamp);
        uint256 newLocked;

        if (valuation > gross) {
            gain = valuation - gross;
            newLocked = stillLocked + gain;
        } else {
            loss = gross - valuation;
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
        _setUnlockPeriod(unlockPeriod_);
    }

    function _setUnlockPeriod(uint256 unlockPeriod_) private {
        if (unlockPeriod_ < MIN_UNLOCK_PERIOD || unlockPeriod_ > MAX_UNLOCK_PERIOD) revert InvalidUnlockPeriod();
        // forge-lint: disable-next-line(unsafe-typecast)
        unlockPeriod = uint40(unlockPeriod_);
        emit UnlockPeriodSet(unlockPeriod_);
    }
}
