// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LeanYieldVaultStd} from "./LeanYieldVaultStd.t.sol";
import {LeanAllocatorVault} from "../src/LeanAllocatorVault.sol";
import {MockStrategy} from "./mocks/MockStrategy.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice The 26 a16z ERC4626 properties against the allocator vault with two
///         allowlisted strategies, deposits going to the first. Yield and losses
///         are applied to both strategies before harvesting.
contract LeanAllocatorVaultStd is LeanYieldVaultStd {
    MockStrategy public strategy2;
    LeanAllocatorVault public alloc;

    function setUp() public override {
        _underlying_ = address(new MockERC20("Mock Token", "MOCK", 18));
        strategy = new MockStrategy(_underlying_);
        strategy2 = new MockStrategy(_underlying_);
        alloc = new LeanAllocatorVault(_underlying_, "Lean Allocator Vault", "laVAULT", PERIOD, 1 hours);
        alloc.proposeStrategy(address(strategy), type(uint96).max);
        alloc.proposeStrategy(address(strategy2), type(uint96).max);
        vm.warp(block.timestamp + 1 hours);
        alloc.acceptStrategy(address(strategy));
        alloc.acceptStrategy(address(strategy2));
        _vault_ = address(alloc);
        _delta_ = 0;
        _vaultMayBeEmpty = true;
        _unlimitedAmount = false;
    }

    function setUpYield(Init memory init) public override {
        if (init.yield == 0) return;
        if (init.yield > 0) {
            uint256 gain = bound(uint256(init.yield), 2, CAP);
            // forge-lint: disable-next-line(unsafe-typecast)
            init.yield = int256(gain);
            MockERC20(_underlying_).mint(address(strategy), gain / 2);
            MockERC20(_underlying_).mint(address(strategy2), gain - gain / 2);
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
        alloc.harvest();
        vm.warp(block.timestamp + PERIOD);
    }
}
