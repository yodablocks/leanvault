// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LeanVault} from "../src/LeanVault.sol";
import {LeanVaultBase} from "../src/LeanVaultBase.sol";
import {LeanYieldVault} from "../src/LeanYieldVault.sol";
import {MockStrategy} from "./mocks/MockStrategy.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @title PermitTest
/// @notice EIP-2612 on the share token: a signed approval sets the allowance,
///         spends a nonce, expires, binds to one owner, one vault and one chain,
///         and lets the spender move shares like any other approval.
contract PermitTest is Test {
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    MockERC20 asset;
    LeanVault vault;

    uint256 alicePk = 0xA11CE;
    address alice;
    address bob = address(0xB0B);

    event Approval(address indexed owner, address indexed spender, uint256 amount);

    function setUp() public {
        alice = vm.addr(alicePk);
        asset = new MockERC20("Mock Token", "MOCK", 18);
        vault = new LeanVault(address(asset), "Lean Vault", "lVAULT");
    }

    function _domain(address vault_, string memory name_) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name_)),
                keccak256("1"),
                block.chainid,
                vault_
            )
        );
    }

    function _sign(uint256 pk, address spender, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, vm.addr(pk), spender, value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domain(address(vault), "Lean Vault"), structHash));
        return vm.sign(pk, digest);
    }

    function test_domainSeparator_matches_eip712() public view {
        assertEq(vault.DOMAIN_SEPARATOR(), _domain(address(vault), "Lean Vault"));
    }

    function test_domainSeparator_differs_per_vault() public {
        MockStrategy strategy = new MockStrategy(address(asset));
        LeanYieldVault other = new LeanYieldVault(address(asset), address(strategy), "Lean Vault", "lVAULT", 1 days);
        assertEq(other.DOMAIN_SEPARATOR(), _domain(address(other), "Lean Vault"));
        assertTrue(other.DOMAIN_SEPARATOR() != vault.DOMAIN_SEPARATOR());
    }

    function test_permit_sets_allowance_and_spends_nonce() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(alicePk, bob, 1e18, 0, block.timestamp);
        vm.expectEmit(true, true, false, true, address(vault));
        emit Approval(alice, bob, 1e18);
        vault.permit(alice, bob, 1e18, block.timestamp, v, r, s);
        assertEq(vault.allowance(alice, bob), 1e18);
        assertEq(vault.nonces(alice), 1);
    }

    function test_permit_overwrites_previous_allowance() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(alicePk, bob, 5e18, 0, block.timestamp);
        vault.permit(alice, bob, 5e18, block.timestamp, v, r, s);
        (v, r, s) = _sign(alicePk, bob, 0, 1, block.timestamp);
        vault.permit(alice, bob, 0, block.timestamp, v, r, s);
        assertEq(vault.allowance(alice, bob), 0);
        assertEq(vault.nonces(alice), 2);
    }

    function test_permit_reverts_after_deadline() public {
        uint256 deadline = block.timestamp;
        (uint8 v, bytes32 r, bytes32 s) = _sign(alicePk, bob, 1e18, 0, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(LeanVaultBase.PermitExpired.selector);
        vault.permit(alice, bob, 1e18, deadline, v, r, s);
    }

    function test_permit_reverts_on_replay() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(alicePk, bob, 1e18, 0, block.timestamp);
        vault.permit(alice, bob, 1e18, block.timestamp, v, r, s);
        vm.expectRevert(LeanVaultBase.InvalidSigner.selector);
        vault.permit(alice, bob, 1e18, block.timestamp, v, r, s);
    }

    function test_permit_reverts_for_wrong_signer() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(0xB0B, bob, 1e18, 0, block.timestamp);
        vm.expectRevert(LeanVaultBase.InvalidSigner.selector);
        vault.permit(alice, bob, 1e18, block.timestamp, v, r, s);
    }

    function test_permit_reverts_for_changed_value() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(alicePk, bob, 1e18, 0, block.timestamp);
        vm.expectRevert(LeanVaultBase.InvalidSigner.selector);
        vault.permit(alice, bob, 2e18, block.timestamp, v, r, s);
    }

    /// @dev ecrecover returns zero for an invalid signature. Without the zero
    ///      check, anyone could set allowances on behalf of address(0).
    function test_permit_reverts_for_zero_owner() public {
        vm.expectRevert(LeanVaultBase.InvalidSigner.selector);
        vault.permit(address(0), bob, 1e18, block.timestamp, 0, bytes32(0), bytes32(0));
    }

    function test_permit_signature_does_not_survive_a_fork() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(alicePk, bob, 1e18, 0, block.timestamp);
        bytes32 before = vault.DOMAIN_SEPARATOR();
        vm.chainId(block.chainid + 1);
        assertTrue(vault.DOMAIN_SEPARATOR() != before);
        assertEq(vault.DOMAIN_SEPARATOR(), _domain(address(vault), "Lean Vault"));
        vm.expectRevert(LeanVaultBase.InvalidSigner.selector);
        vault.permit(alice, bob, 1e18, block.timestamp, v, r, s);
    }

    function test_permit_works_while_paused() public {
        vault.pause();
        (uint8 v, bytes32 r, bytes32 s) = _sign(alicePk, bob, 1e18, 0, block.timestamp);
        vault.permit(alice, bob, 1e18, block.timestamp, v, r, s);
        assertEq(vault.allowance(alice, bob), 1e18);
    }

    function test_spender_redeems_after_permit() public {
        asset.mint(alice, 100e18);
        vm.startPrank(alice);
        asset.approve(address(vault), 100e18);
        uint256 shares = vault.deposit(100e18, alice);
        vm.stopPrank();

        (uint8 v, bytes32 r, bytes32 s) = _sign(alicePk, bob, shares, 0, block.timestamp);
        vault.permit(alice, bob, shares, block.timestamp, v, r, s);
        vm.prank(bob);
        uint256 assets = vault.redeem(shares, bob, alice);

        assertEq(assets, 100e18);
        assertEq(asset.balanceOf(bob), 100e18);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(vault.allowance(alice, bob), 0);
    }

    function testFuzz_permit(uint256 pk, address spender, uint256 value, uint256 deadline) public {
        pk = bound(pk, 1, 115792089237316195423570985008687907852837564279074904382605163141518161494336);
        deadline = bound(deadline, block.timestamp, type(uint256).max);
        address signer = vm.addr(pk);
        (uint8 v, bytes32 r, bytes32 s) = _sign(pk, spender, value, 0, deadline);
        vault.permit(signer, spender, value, deadline, v, r, s);
        assertEq(vault.allowance(signer, spender), value);
        assertEq(vault.nonces(signer), 1);
    }
}
