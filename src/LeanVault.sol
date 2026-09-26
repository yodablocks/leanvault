// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LeanVaultBase} from "./LeanVaultBase.sol";

/// @title LeanVault
/// @notice The idle ERC4626 shell: holds the asset and does nothing with it.
///         All behaviour lives in LeanVaultBase; this contract only fixes the
///         constructor. Passes the 26 a16z ERC4626 properties. Unaudited.
contract LeanVault is LeanVaultBase {
    constructor(address asset_, string memory name_, string memory symbol_)
        LeanVaultBase(asset_, name_, symbol_)
    {}
}
