// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LeanYieldVault} from "../src/LeanYieldVault.sol";
import {LeanVaultBase} from "../src/LeanVaultBase.sol";
import {LeanYieldBase} from "../src/LeanYieldBase.sol";
import {MockStrategy} from "./mocks/MockStrategy.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @title LeanYieldVaultTest
/// @notice What the yield vault promises: deposits live in the strategy, gains
///         stream, losses land at once, a harvest cannot be sandwiched, anyone
///         can harvest, and limits follow the strategy's liquidity.
contract LeanYieldVaultTest is Test {
    MockERC20 asset;
    MockStrategy strategy;
    LeanYieldVault vault;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address attacker = address(0xBAD);
    uint256 constant PERIOD = 1 days;
    // setUp warps to T0; the stream tests count time from it instead of re-reading block.timestamp.
    uint256 constant T0 = 1_000_000;

    function setUp() public {
        asset = new MockERC20("Mock Token", "MOCK", 18);
        strategy = new MockStrategy(address(asset));
        vault = new LeanYieldVault(address(asset), address(strategy), "Lean Yield Vault", "lyVAULT", PERIOD);
        for (uint256 i = 0; i < 3; i++) {
            address u = [alice, bob, attacker][i];
            asset.mint(u, 1_000_000e18);
            vm.prank(u);
            asset.approve(address(vault), type(uint256).max);
        }
        vm.warp(1_000_000);
    }

    function _gain(uint256 amount) internal {
        asset.mint(address(strategy), amount);
    }

    // The strategy prices with a virtual share, so it values a position a wei
    // under what was deposited. Every real strategy rounds somewhere; the vault
    // must live with that, and these assertions allow exactly one wei for it.
    uint256 constant WEI = 1;

    /*//////////////////////////////////////////////////////////////
                                 ROUTING
    //////////////////////////////////////////////////////////////*/

    function test_depositsLiveInStrategy() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        assertEq(asset.balanceOf(address(vault)), 0, "vault must hold nothing itself");
        assertEq(asset.balanceOf(address(strategy)), 100e18, "strategy holds the deposit");
        assertEq(vault.totalAssets(), 100e18);
    }

    function test_withdrawPaysFromStrategyStraightToReceiver() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        uint256 before = asset.balanceOf(bob);
        vm.prank(alice);
        vault.withdraw(40e18, bob, alice);
        assertEq(asset.balanceOf(bob) - before, 40e18);
        assertEq(asset.balanceOf(address(vault)), 0);
        assertEq(vault.totalAssets(), 60e18);
    }

    function test_constructorRejectsWrongStrategyAssetAndBadPeriod() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        MockStrategy wrong = new MockStrategy(address(other));
        vm.expectRevert(LeanYieldVault.StrategyAssetMismatch.selector);
        new LeanYieldVault(address(asset), address(wrong), "x", "x", PERIOD);
        vm.expectRevert(LeanYieldBase.InvalidUnlockPeriod.selector);
        new LeanYieldVault(address(asset), address(strategy), "x", "x", 1 minutes);
        vm.expectRevert(LeanYieldBase.InvalidUnlockPeriod.selector);
        new LeanYieldVault(address(asset), address(strategy), "x", "x", 31 days);
    }

    /*//////////////////////////////////////////////////////////////
                               GAIN STREAM
    //////////////////////////////////////////////////////////////*/

    function test_gainStreamsLinearly() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        _gain(10e18);

        (uint256 gain, uint256 loss) = vault.harvest();
        assertApproxEqAbs(gain, 10e18, WEI);
        assertEq(loss, 0);

        // Nothing at the moment of harvest.
        assertEq(vault.totalAssets(), 100e18, "no gain credited at harvest time");
        assertApproxEqAbs(vault.lockedProfit(), 10e18, WEI);

        uint256 t = T0;
        t += PERIOD / 4;
        vm.warp(t);
        assertApproxEqAbs(vault.totalAssets(), 102.5e18, WEI, "a quarter of the gain after a quarter period");

        t += PERIOD / 4;
        vm.warp(t);
        assertApproxEqAbs(vault.totalAssets(), 105e18, WEI, "half after half");

        t += PERIOD / 2;
        vm.warp(t);
        assertApproxEqAbs(vault.totalAssets(), 110e18, WEI, "all of it at the end");
        assertEq(vault.lockedProfit(), 0);

        t += 365 days;
        vm.warp(t);
        assertApproxEqAbs(vault.totalAssets(), 110e18, WEI, "and it stays there");
    }

    function testFuzz_sharePriceNeverDecreasesDuringStream(uint256 gain, uint256 t1, uint256 t2) public {
        gain = bound(gain, 1, 1_000_000e18);
        t1 = bound(t1, 0, 2 * PERIOD);
        t2 = bound(t2, t1, 2 * PERIOD);
        vm.prank(alice);
        vault.deposit(100e18, alice);
        _gain(gain);
        uint256 start = T0;
        vault.harvest();

        vm.warp(start + t1);
        uint256 p1 = vault.convertToAssets(1e18);
        vm.warp(start + t2);
        uint256 p2 = vault.convertToAssets(1e18);
        assertGe(p2, p1, "price went down while streaming");
    }

    function test_secondHarvestRollsRemainingLockedProfitForward() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        _gain(10e18);
        uint256 t = T0;
        vault.harvest();
        t += PERIOD / 2; // 5e18 still locked
        vm.warp(t);
        _gain(4e18);
        vault.harvest();
        assertApproxEqAbs(vault.lockedProfit(), 9e18, WEI, "5 remaining plus 4 new");
        assertApproxEqAbs(vault.totalAssets(), 105e18, WEI, "nothing new credited at harvest time");
        t += PERIOD;
        vm.warp(t);
        assertApproxEqAbs(vault.totalAssets(), 114e18, WEI);
    }

    /*//////////////////////////////////////////////////////////////
                                  LOSSES
    //////////////////////////////////////////////////////////////*/

    function test_lossLandsImmediately() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        asset.burn(address(strategy), 10e18);
        (uint256 gain, uint256 loss) = vault.harvest();
        assertEq(gain, 0);
        assertEq(loss, 10e18);
        assertEq(vault.totalAssets(), 90e18, "loss recognized at once");
    }

    function test_lossEatsLockedProfitFirst() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        _gain(10e18);
        vault.harvest();
        // Still fully locked; price is 100. A 4e18 loss should come out of the locked 10.
        asset.burn(address(strategy), 4e18);
        vault.harvest();
        assertEq(vault.totalAssets(), 100e18, "price untouched, locked profit absorbed the loss");
        assertApproxEqAbs(vault.lockedProfit(), 6e18, WEI);
        uint256 t = T0 + PERIOD;
        vm.warp(t);
        assertApproxEqAbs(vault.totalAssets(), 106e18, WEI);
    }

    /*//////////////////////////////////////////////////////////////
                                SANDWICH
    //////////////////////////////////////////////////////////////*/

    function testFuzz_depositBeforeHarvestCapturesNothing(uint256 gain, uint256 attackSize) public {
        gain = bound(gain, 1e18, 1_000_000e18);
        attackSize = bound(attackSize, 1e18, 1_000_000e18);
        vm.prank(alice);
        vault.deposit(100e18, alice);
        _gain(gain); // yield sits in the strategy, harvest is about to happen

        vm.prank(attacker);
        uint256 shares = vault.deposit(attackSize, attacker);
        vault.harvest();
        vm.prank(attacker);
        uint256 got = vault.redeem(shares, attacker, attacker);

        assertLe(got, attackSize, "sandwich extracted yield");
    }

    function test_harvestIsPermissionless() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        _gain(1e18);
        vm.prank(address(0x5EED));
        (uint256 gain,) = vault.harvest();
        assertApproxEqAbs(gain, 1e18, WEI);
    }

    /*//////////////////////////////////////////////////////////////
                             ADMIN AND LIMITS
    //////////////////////////////////////////////////////////////*/

    function test_unlockPeriodIsOwnerOnlyAndBounded() public {
        vm.prank(alice);
        vm.expectRevert(LeanVaultBase.Unauthorized.selector);
        vault.setUnlockPeriod(2 days);
        vm.expectRevert(LeanYieldBase.InvalidUnlockPeriod.selector);
        vault.setUnlockPeriod(0);
        vault.setUnlockPeriod(2 days);
        assertEq(vault.unlockPeriod(), 2 days);
    }

    function test_maxWithdrawFollowsStrategyLiquidity() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        assertEq(vault.maxWithdraw(alice), 100e18);
        // The strategy loses liquidity without the vault having harvested yet.
        asset.burn(address(strategy), 30e18);
        assertEq(vault.maxWithdraw(alice), 70e18, "capped by what the strategy can pay");
        vm.prank(alice);
        vault.withdraw(70e18, alice, alice); // must not revert at maxWithdraw
    }

    function test_pauseBlocksDepositsAndWithdrawalsNotHarvest() public {
        vm.prank(alice);
        vault.deposit(100e18, alice);
        vault.pause();
        vm.prank(alice);
        vm.expectRevert(LeanVaultBase.Paused.selector);
        vault.deposit(1e18, alice);
        vm.prank(alice);
        vm.expectRevert(LeanVaultBase.Paused.selector);
        vault.withdraw(1e18, alice, alice);
        _gain(1e18);
        vault.harvest(); // accounting keeps working while paused
        assertEq(vault.maxDeposit(alice), 0);
    }
}
