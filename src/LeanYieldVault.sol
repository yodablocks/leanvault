// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LeanYieldBase} from "./LeanYieldBase.sol";
import {IStrategy} from "./IStrategy.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title LeanYieldVault
/// @notice LeanYieldBase with one strategy: every deposit goes into another
///         ERC4626 vault and withdrawals are paid straight out of it. The
///         vault never reads the strategy's price inside deposit or withdraw;
///         see LeanYieldBase for the harvest and the stream.
/// @dev Plain Solidity, no assembly. No fee. Unaudited.
contract LeanYieldVault is LeanYieldBase {
    using SafeTransferLib for address;

    IStrategy public immutable strategy;

    error StrategyAssetMismatch();
    error StrategyMintedNothing();

    constructor(
        address asset_,
        address strategy_,
        string memory name_,
        string memory symbol_,
        uint256 unlockPeriod_
    ) LeanYieldBase(asset_, name_, symbol_, unlockPeriod_) {
        if (strategy_ == address(0)) revert ZeroAddress();
        if (IStrategy(strategy_).asset() != asset_) revert StrategyAssetMismatch();
        strategy = IStrategy(strategy_);
        asset_.safeApprove(strategy_, type(uint256).max);
    }

    function _strategyValuation() internal view override returns (uint256) {
        return strategy.convertToAssets(strategy.balanceOf(address(this)));
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
