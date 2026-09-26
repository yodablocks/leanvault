// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "solady/tokens/ERC4626.sol";

/// @notice A strategy stand-in: Solady's ERC4626 over the same asset. Its
///         totalAssets is its token balance, so yield is simulated by minting
///         the asset to it and losses by burning from it.
contract MockStrategy is ERC4626 {
    address private immutable _asset;

    constructor(address asset_) {
        _asset = asset_;
    }

    function asset() public view override returns (address) {
        return _asset;
    }

    function name() public pure override returns (string memory) {
        return "Mock Strategy";
    }

    function symbol() public pure override returns (string memory) {
        return "mSTRAT";
    }
}
