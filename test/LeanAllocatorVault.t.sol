// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LeanAllocatorVault} from "../src/LeanAllocatorVault.sol";
import {LeanVaultBase} from "../src/LeanVaultBase.sol";
import {MockStrategy} from "./mocks/MockStrategy.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @title LeanAllocatorVaultTest
/// @notice Every guardrail the allocator vault promises: timelocked allowlist,
///         caps on deposits and rebalances, allocator-only rebalancing within a
///         per-window limit, a withdrawal queue across strategies, removal only
///         when empty, and harvest summing every strategy.
contract LeanAllocatorVaultTest is Test {
    MockERC20 asset;
    MockStrategy sA;
    MockStrategy sB;
    LeanAllocatorVault vault;

    address alice = address(0xA11CE);
    address allocator = address(0xA110C);
    uint256 constant PERIOD = 1 days;
    uint256 constant TIMELOCK = 1 hours;
    uint256 constant T0 = 1_000_000;

    function setUp() public {
        vm.warp(T0);
        asset = new MockERC20("Mock Token", "MOCK", 18);
        sA = new MockStrategy(address(asset));
        sB = new MockStrategy(address(asset));
        vault = new LeanAllocatorVault(address(asset), "Lean Allocator Vault", "laVAULT", PERIOD, TIMELOCK);
        vault.proposeStrategy(address(sA), 1_000e18);
        vault.proposeStrategy(address(sB), 500e18);
        vm.warp(T0 + TIMELOCK);
        vault.acceptStrategy(address(sA));
        vault.acceptStrategy(address(sB));
        vault.setAllocator(allocator);
        vault.setRebalanceLimit(300e18);
        asset.mint(alice, 1_000_000e18);
        vm.prank(alice);
        asset.approve(address(vault), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                                ALLOWLIST
    //////////////////////////////////////////////////////////////*/

    function test_strategyMustWaitForTimelock() public {
        MockStrategy sC = new MockStrategy(address(asset));
        vm.expectRevert(LeanAllocatorVault.NotProposed.selector);
        vault.acceptStrategy(address(sC));
        vault.proposeStrategy(address(sC), 1e18);
        vm.expectRevert(LeanAllocatorVault.TimelockNotElapsed.selector);
        vault.acceptStrategy(address(sC));
        vm.warp(T0 + TIMELOCK + TIMELOCK);
        vault.acceptStrategy(address(sC));
        assertEq(vault.strategies().length, 3);
    }

    function test_wrongAssetStrategyIsRejected() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        MockStrategy wrong = new MockStrategy(address(other));
        vm.expectRevert(LeanAllocatorVault.StrategyAssetMismatch.selector);
        vault.proposeStrategy(address(wrong), 1e18);
    }

    function test_onlyOwnerManagesTheAllowlist() public {
        vm.startPrank(alice);
        vm.expectRevert(LeanVaultBase.Unauthorized.selector);
        vault.proposeStrategy(address(sA), 1e18);
        vm.expectRevert(LeanVaultBase.Unauthorized.selector);
        vault.setCap(address(sA), 1e18);
        vm.expectRevert(LeanVaultBase.Unauthorized.selector);
        vault.setAllocator(alice);
        vm.stopPrank();
    }

    function test_removeRequiresEmptyStrategy() public {
        vm.prank(alice);
        vault.deposit(100e18, alice); // lands in sA, the deposit target
        vm.expectRevert(LeanAllocatorVault.StrategyNotEmpty.selector);
        vault.removeStrategy(address(sA));
        // sB is empty and not the target: removable.
        vault.removeStrategy(address(sB));
        assertEq(vault.strategies().length, 1);
        assertEq(asset.allowance(address(vault), address(sB)), 0, "approval revoked");
    }

    /*//////////////////////////////////////////////////////////////
                                   CAPS
    //////////////////////////////////////////////////////////////*/

    function test_depositCappedByTargetCap() public {
        assertEq(vault.maxDeposit(alice), 1_000e18, "cap of the deposit target");
        vm.prank(alice);
        vault.deposit(1_000e18, alice);
        assertEq(vault.maxDeposit(alice), 0);
        vm.prank(alice);
        vm.expectRevert(LeanAllocatorVault.CapExceeded.selector);
        vault.deposit(1, alice);
    }

    function test_rebalanceCappedByDestinationCap() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);
        vault.setRebalanceLimit(1_000e18);
        vm.startPrank(allocator);
        vault.rebalance(address(sA), address(sB), 300e18); // sB now ~300 of its 500 cap
        vm.expectRevert(LeanAllocatorVault.CapExceeded.selector);
        vault.rebalance(address(sA), address(sB), 200e18 + 1);
        vault.rebalance(address(sA), address(sB), 199e18); // fits, allowing a wei of strategy rounding
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                               REBALANCING
    //////////////////////////////////////////////////////////////*/

    function test_onlyAllocatorOrOwnerRebalances() public {
        vm.prank(alice);
        vault.deposit(500e18, alice);
        vm.prank(alice);
        vm.expectRevert(LeanAllocatorVault.NotAllocator.selector);
        vault.rebalance(address(sA), address(sB), 100e18);
        vm.prank(allocator);
        vault.rebalance(address(sA), address(sB), 100e18);
        vault.rebalance(address(sA), address(sB), 50e18); // owner too
        assertApproxEqAbs(sB.convertToAssets(sB.balanceOf(address(vault))), 150e18, 2);
    }

    function test_rebalanceLimitPerWindow() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);
        assertEq(vault.rebalanceAvailable(), 300e18);
        vm.startPrank(allocator);
        vault.rebalance(address(sA), address(sB), 200e18);
        assertEq(vault.rebalanceAvailable(), 100e18);
        vm.expectRevert(LeanAllocatorVault.RebalanceLimitExceeded.selector);
        vault.rebalance(address(sA), address(sB), 100e18 + 1);
        vault.rebalance(address(sA), address(sB), 100e18);
        assertEq(vault.rebalanceAvailable(), 0);
        vm.warp(T0 + TIMELOCK + 24 hours);
        assertEq(vault.rebalanceAvailable(), 300e18, "window rolled");
        vault.rebalance(address(sB), address(sA), 100e18);
        vm.stopPrank();
    }

    function test_rebalanceDoesNotMoveThePrice() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);
        uint256 before = vault.convertToAssets(1e18);
        vm.prank(allocator);
        vault.rebalance(address(sA), address(sB), 300e18);
        assertEq(vault.convertToAssets(1e18), before, "price must not react to a rebalance");
        assertEq(vault.totalAssets(), 1_000e18);
    }

    /*//////////////////////////////////////////////////////////////
                             WITHDRAW QUEUE
    //////////////////////////////////////////////////////////////*/

    function test_withdrawDrainsStrategiesInOrder() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);
        vm.prank(allocator);
        vault.rebalance(address(sA), address(sB), 300e18); // sA ~700, sB ~300
        uint256 before = asset.balanceOf(alice);
        vm.prank(alice);
        vault.withdraw(900e18, alice, alice); // needs both
        assertEq(asset.balanceOf(alice) - before, 900e18);
        assertLe(sA.convertToAssets(sA.balanceOf(address(vault))), 2, "sA drained first");
        assertApproxEqAbs(sB.convertToAssets(sB.balanceOf(address(vault))), 100e18, 2, "rest came from sB");
    }

    function test_maxWithdrawFollowsTotalLiquidity() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);
        asset.burn(address(sA), 400e18); // sA lost liquidity, not yet harvested
        assertApproxEqAbs(vault.maxWithdraw(alice), 600e18, 2);
        uint256 max = vault.maxWithdraw(alice);
        vm.prank(alice);
        vault.withdraw(max, alice, alice); // must not revert
    }

    /*//////////////////////////////////////////////////////////////
                                 HARVEST
    //////////////////////////////////////////////////////////////*/

    function test_harvestSumsEveryStrategy() public {
        vm.prank(alice);
        vault.deposit(1_000e18, alice);
        vm.prank(allocator);
        vault.rebalance(address(sA), address(sB), 300e18);
        asset.mint(address(sA), 7e18);
        asset.mint(address(sB), 3e18);
        (uint256 gain,) = vault.harvest();
        assertApproxEqAbs(gain, 10e18, 3);
        vm.warp(T0 + TIMELOCK + PERIOD);
        assertApproxEqAbs(vault.totalAssets(), 1_010e18, 3);
    }

    function test_depositsNeedATarget() public {
        LeanAllocatorVault empty = new LeanAllocatorVault(address(asset), "E", "E", PERIOD, TIMELOCK);
        assertEq(empty.maxDeposit(alice), 0);
        vm.prank(alice);
        asset.approve(address(empty), type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(LeanAllocatorVault.NoDepositTarget.selector);
        empty.deposit(1e18, alice);
    }
}
