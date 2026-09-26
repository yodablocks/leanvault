// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LeanVaultStd} from "./LeanVaultStd.t.sol";
import {LeanYieldVault} from "../src/LeanYieldVault.sol";
import {MockStrategy} from "./mocks/MockStrategy.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice The 26 a16z ERC4626 properties against the yield vault, with a
///         Solady ERC4626 as the strategy. Yield is simulated by minting the
///         asset to the strategy, harvesting, and letting the stream finish;
///         losses by burning from the strategy and harvesting.
contract LeanYieldVaultStd is LeanVaultStd {
    MockStrategy public strategy;
    uint256 constant PERIOD = 1 days;

    function setUp() public virtual override {
        _underlying_ = address(new MockERC20("Mock Token", "MOCK", 18));
        strategy = new MockStrategy(_underlying_);
        _vault_ = address(new LeanYieldVault(_underlying_, address(strategy), "Lean Yield Vault", "lyVAULT", PERIOD));
        _delta_ = 0;
        _vaultMayBeEmpty = true;
        _unlimitedAmount = false;
    }

    function setUpYield(Init memory init) public virtual override {
        if (init.yield == 0) return;
        if (init.yield > 0) {
            uint256 gain = bound(uint256(init.yield), 1, CAP);
            // forge-lint: disable-next-line(unsafe-typecast)
            init.yield = int256(gain);
            MockERC20(_underlying_).mint(address(strategy), gain);
        } else {
            vm.assume(init.yield > type(int256).min);
            uint256 held = MockERC20(_underlying_).balanceOf(address(strategy));
            if (held == 0) {
                init.yield = 0;
                return;
            }
            uint256 loss = bound(uint256(-init.yield), 1, held);
            // forge-lint: disable-next-line(unsafe-typecast)
            init.yield = -int256(loss);
            MockERC20(_underlying_).burn(address(strategy), loss);
        }
        LeanYieldVault(_vault_).harvest();
        vm.warp(block.timestamp + PERIOD);
    }
}
