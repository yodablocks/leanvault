// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LeanVault} from "../src/LeanVault.sol";
import {LeanYieldVault} from "../src/LeanYieldVault.sol";
import {MockStrategy} from "./mocks/MockStrategy.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Idle shell against the yield vault on the same calls, so the cost
///         of routing through a strategy and pricing through the stream is
///         visible. Measure with `forge test --isolate -vvvv` per test, or the
///         erc4626-bench script.
contract GasBenchmark is Test {
    MockERC20 asset;
    MockStrategy strategy;
    LeanVault idle;
    LeanYieldVault yieldVault;
    address alice = address(0x1);

    function setUp() public {
        asset = new MockERC20("Test Token", "TEST", 18);
        strategy = new MockStrategy(address(asset));
        idle = new LeanVault(address(asset), "Lean Vault", "lVAULT");
        yieldVault = new LeanYieldVault(address(asset), address(strategy), "Lean Yield Vault", "lyVAULT", 1 days);
        asset.mint(alice, 1_000_000e18);
        vm.startPrank(alice);
        asset.approve(address(idle), type(uint256).max);
        asset.approve(address(yieldVault), type(uint256).max);
        vm.stopPrank();
    }

    function test_gas_idle_first_deposit() public { vm.prank(alice); idle.deposit(10000e18, alice); }
    function test_gas_yield_first_deposit() public { vm.prank(alice); yieldVault.deposit(10000e18, alice); }

    function test_gas_idle_subsequent_deposit() public {
        vm.startPrank(alice); idle.deposit(10000e18, alice); idle.deposit(5000e18, alice); vm.stopPrank();
    }
    function test_gas_yield_subsequent_deposit() public {
        vm.startPrank(alice); yieldVault.deposit(10000e18, alice); yieldVault.deposit(5000e18, alice); vm.stopPrank();
    }

    function test_gas_idle_withdraw() public {
        vm.startPrank(alice); idle.deposit(10000e18, alice); idle.withdraw(1000e18, alice, alice); vm.stopPrank();
    }
    function test_gas_yield_withdraw() public {
        vm.startPrank(alice); yieldVault.deposit(10000e18, alice); yieldVault.withdraw(1000e18, alice, alice); vm.stopPrank();
    }

    function test_gas_idle_redeem() public {
        vm.startPrank(alice); idle.deposit(10000e18, alice); idle.redeem(1000e18, alice, alice); vm.stopPrank();
    }
    function test_gas_yield_redeem() public {
        vm.startPrank(alice); yieldVault.deposit(10000e18, alice); yieldVault.redeem(1000e18, alice, alice); vm.stopPrank();
    }

    function test_gas_idle_convertToShares() public {
        vm.prank(alice); idle.deposit(10000e18, alice); idle.convertToShares(1000e18);
    }
    function test_gas_yield_convertToShares() public {
        vm.prank(alice); yieldVault.deposit(10000e18, alice); yieldVault.convertToShares(1000e18);
    }

    function test_gas_yield_harvest() public {
        vm.prank(alice); yieldVault.deposit(10000e18, alice);
        asset.mint(address(strategy), 100e18);
        yieldVault.harvest();
    }
}
