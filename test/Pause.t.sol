// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LeanVault} from "../src/LeanVault.sol";
import {LeanVaultBase} from "../src/LeanVaultBase.sol";
import {LeanAllocatorVault} from "../src/LeanAllocatorVault.sol";
import {MockStrategy} from "./mocks/MockStrategy.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @title PauseTest
/// @notice Pause stops new money, never an exit: deposit and mint revert,
///         withdraw and redeem keep working, and the max views say so. The
///         owner can halt a vault but cannot lock depositors in it.
contract PauseTest is Test {
    MockERC20 asset;
    LeanVault idle;
    LeanAllocatorVault alloc;
    MockStrategy strategy;
    address alice = address(0xA11CE);

    function setUp() public {
        asset = new MockERC20("Mock Token", "MOCK", 18);
        idle = new LeanVault(address(asset), "Lean Vault", "lVAULT");
        strategy = new MockStrategy(address(asset));
        alloc = new LeanAllocatorVault(address(asset), "Lean Allocator Vault", "laVAULT", 1 days, 1 hours);
        alloc.proposeStrategy(address(strategy), type(uint96).max);
        vm.warp(block.timestamp + 1 hours);
        alloc.acceptStrategy(address(strategy));
        asset.mint(alice, 1_000e18);
        vm.startPrank(alice);
        asset.approve(address(idle), type(uint256).max);
        asset.approve(address(alloc), type(uint256).max);
        idle.deposit(100e18, alice);
        alloc.deposit(100e18, alice);
        vm.stopPrank();
    }

    function test_pauseStopsDepositAndMint() public {
        idle.pause();
        vm.startPrank(alice);
        vm.expectRevert(LeanVaultBase.Paused.selector);
        idle.deposit(1e18, alice);
        vm.expectRevert(LeanVaultBase.Paused.selector);
        idle.mint(1e18, alice);
        vm.stopPrank();
        assertEq(idle.maxDeposit(alice), 0);
        assertEq(idle.maxMint(alice), 0);
    }

    function test_withdrawAndRedeemStayOpenWhilePaused() public {
        idle.pause();
        assertEq(idle.maxWithdraw(alice), 100e18, "maxWithdraw reports the exit");
        assertEq(idle.maxRedeem(alice), idle.balanceOf(alice), "maxRedeem reports the exit");
        vm.startPrank(alice);
        idle.withdraw(40e18, alice, alice);
        idle.redeem(idle.balanceOf(alice), alice, alice);
        vm.stopPrank();
        assertEq(idle.balanceOf(alice), 0);
        assertEq(asset.balanceOf(alice), 900e18, "all 100 came back out of the idle vault");
    }

    function test_allocatorExitsStayOpenWhilePaused() public {
        alloc.pause();
        assertEq(alloc.maxWithdraw(alice), 100e18);
        uint256 shares = alloc.balanceOf(alice);
        vm.prank(alice);
        alloc.redeem(shares, alice, alice);
        assertEq(alloc.balanceOf(alice), 0);
    }

    function test_onlyOwnerPauses() public {
        vm.prank(alice);
        vm.expectRevert(LeanVaultBase.Unauthorized.selector);
        idle.pause();
    }

    function testFuzz_anyHolderCanLeaveAPausedVault(uint96 amount) public {
        // forge-lint: disable-next-line(unsafe-typecast)
        amount = uint96(bound(amount, 1, 800e18));
        vm.prank(alice);
        idle.deposit(amount, alice);
        idle.pause();
        uint256 shares = idle.balanceOf(alice);
        vm.prank(alice);
        uint256 out = idle.redeem(shares, alice, alice);
        assertEq(out, 100e18 + uint256(amount), "virtual share rounding never costs an exit here");
    }
}
