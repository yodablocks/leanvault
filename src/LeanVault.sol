// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title LeanVault
/// @notice An ERC4626 accounting shell with the costs designed out:
///         - No first-deposit burn. Inflation is handled the way Solady does it,
///           with one virtual share and one virtual asset in the price formula.
///           The packed accounting already makes donations inert, so the offset
///           only has to cover rounding on tiny deposits, and it costs no storage.
///         - No Ownable base. One owner slot, one transfer function, no handover
///           machinery, no payable functions. Smaller code, and ETH cannot get stuck.
/// @dev Plain Solidity, no assembly. Passes the 26 a16z ERC4626 properties. Unaudited.
contract LeanVault is ReentrancyGuardTransient {
    using SafeTransferLib for address;

    uint256 private constant MAX_96_BITS = type(uint96).max;

    address public immutable asset;

    // One slot: 96 + 96 + 8 bits.
    uint96 private _totalAssets;
    uint96 private _totalSupply;
    bool private _paused;

    address public owner;

    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    string private _name;
    string private _symbol;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares
    );
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PausedEvent();
    event UnpausedEvent();

    error Paused();
    error ZeroAmount();
    error ZeroAddress();
    error InsufficientShares();
    error ExceedsMaxCapacity();
    error InsufficientAssets();
    error InsufficientBalance();
    error InsufficientAllowance();
    error Unauthorized();

    constructor(address asset_, string memory name_, string memory symbol_) {
        if (asset_ == address(0)) revert ZeroAddress();
        asset = asset_;
        _name = name_;
        _symbol = symbol_;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    function _useTransientReentrancyGuardOnlyOnMainnet() internal pure override returns (bool) {
        return false;
    }

    /*//////////////////////////////////////////////////////////////
                             SHARE TOKEN
    //////////////////////////////////////////////////////////////*/

    function name() public view returns (string memory) {
        return _name;
    }

    function symbol() public view returns (string memory) {
        return _symbol;
    }

    function decimals() public pure returns (uint8) {
        return 18;
    }

    function totalSupply() public view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) public view returns (uint256) {
        return _balances[account];
    }

    function allowance(address account, address spender) public view returns (uint256) {
        return _allowances[account][spender];
    }

    function approve(address spender, uint256 amount) public returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) public returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        uint256 fromBalance = _balances[from];
        if (fromBalance < amount) revert InsufficientBalance();
        unchecked {
            _balances[from] = fromBalance - amount;
            _balances[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    function _spendAllowance(address account, address spender, uint256 amount) private {
        uint256 allowed = _allowances[account][spender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            unchecked {
                _allowances[account][spender] = allowed - amount;
            }
        }
    }

    function _mintShares(address to, uint256 amount) private {
        unchecked {
            _balances[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    function _burnShares(address from, uint256 amount) private {
        uint256 fromBalance = _balances[from];
        if (fromBalance < amount) revert InsufficientBalance();
        unchecked {
            _balances[from] = fromBalance - amount;
        }
        emit Transfer(from, address(0), amount);
    }

    /*//////////////////////////////////////////////////////////////
                              ERC4626 CORE
    //////////////////////////////////////////////////////////////*/

    /// @dev Callers bound both values to MAX_96_BITS first, so the casts cannot truncate.
    function _store(uint256 totalAssets_, uint256 totalSupply_) private {
        // forge-lint: disable-next-line(unsafe-typecast)
        _totalAssets = uint96(totalAssets_);
        // forge-lint: disable-next-line(unsafe-typecast)
        _totalSupply = uint96(totalSupply_);
    }

    // Virtual offset: one share and one asset that nobody owns. The price is
    // defined for an empty vault, and rounding can never hand out the pool.
    function _toShares(uint256 assets, uint256 totalAssets_, uint256 totalSupply_, bool roundUp)
        private
        pure
        returns (uint256)
    {
        uint256 numerator = assets * (totalSupply_ + 1);
        uint256 denominator = totalAssets_ + 1;
        return numerator / denominator + (roundUp && numerator % denominator != 0 ? 1 : 0);
    }

    function _toAssets(uint256 shares, uint256 totalAssets_, uint256 totalSupply_, bool roundUp)
        private
        pure
        returns (uint256)
    {
        uint256 numerator = shares * (totalAssets_ + 1);
        uint256 denominator = totalSupply_ + 1;
        return numerator / denominator + (roundUp && numerator % denominator != 0 ? 1 : 0);
    }

    function deposit(uint256 assets, address receiver) public nonReentrant returns (uint256 shares) {
        (uint256 totalAssets_, uint256 totalSupply_, bool paused_) = (_totalAssets, _totalSupply, _paused);
        if (paused_) revert Paused();
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        if (assets > MAX_96_BITS) revert ExceedsMaxCapacity();

        shares = _toShares(assets, totalAssets_, totalSupply_, false);
        if (shares == 0) revert InsufficientShares();
        uint256 newAssets = totalAssets_ + assets;
        uint256 newSupply = totalSupply_ + shares;
        if (newAssets > MAX_96_BITS || newSupply > MAX_96_BITS) revert ExceedsMaxCapacity();
        _store(newAssets, newSupply);

        _mintShares(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);

        asset.safeTransferFrom(msg.sender, address(this), assets);
    }

    function mint(uint256 shares, address receiver) public nonReentrant returns (uint256 assets) {
        (uint256 totalAssets_, uint256 totalSupply_, bool paused_) = (_totalAssets, _totalSupply, _paused);
        if (paused_) revert Paused();
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        if (shares > MAX_96_BITS) revert ExceedsMaxCapacity();

        assets = _toAssets(shares, totalAssets_, totalSupply_, true);
        uint256 newAssets = totalAssets_ + assets;
        uint256 newSupply = totalSupply_ + shares;
        if (newAssets > MAX_96_BITS || newSupply > MAX_96_BITS) revert ExceedsMaxCapacity();
        _store(newAssets, newSupply);

        _mintShares(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);

        asset.safeTransferFrom(msg.sender, address(this), assets);
    }

    function withdraw(uint256 assets, address receiver, address account)
        public
        nonReentrant
        returns (uint256 shares)
    {
        (uint256 totalAssets_, uint256 totalSupply_, bool paused_) = (_totalAssets, _totalSupply, _paused);
        if (paused_) revert Paused();
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        if (assets > totalAssets_) revert InsufficientAssets();

        shares = _toShares(assets, totalAssets_, totalSupply_, true);
        if (shares > totalSupply_) revert InsufficientShares();
        _store(totalAssets_ - assets, totalSupply_ - shares);

        if (msg.sender != account) _spendAllowance(account, msg.sender, shares);
        _burnShares(account, shares);
        emit Withdraw(msg.sender, receiver, account, assets, shares);

        asset.safeTransfer(receiver, assets);
    }

    function redeem(uint256 shares, address receiver, address account)
        public
        nonReentrant
        returns (uint256 assets)
    {
        (uint256 totalAssets_, uint256 totalSupply_, bool paused_) = (_totalAssets, _totalSupply, _paused);
        if (paused_) revert Paused();
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        if (shares > totalSupply_) revert InsufficientShares();

        assets = _toAssets(shares, totalAssets_, totalSupply_, false);
        if (assets == 0) revert InsufficientAssets();
        _store(totalAssets_ - assets, totalSupply_ - shares);

        if (msg.sender != account) _spendAllowance(account, msg.sender, shares);
        _burnShares(account, shares);
        emit Withdraw(msg.sender, receiver, account, assets, shares);

        asset.safeTransfer(receiver, assets);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function totalAssets() public view returns (uint256) {
        return _totalAssets;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return _toShares(assets, _totalAssets, _totalSupply, false);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return _toAssets(shares, _totalAssets, _totalSupply, false);
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        return _toShares(assets, _totalAssets, _totalSupply, false);
    }

    function previewMint(uint256 shares) public view returns (uint256) {
        return _toAssets(shares, _totalAssets, _totalSupply, true);
    }

    function previewWithdraw(uint256 assets) public view returns (uint256) {
        return _toShares(assets, _totalAssets, _totalSupply, true);
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        return _toAssets(shares, _totalAssets, _totalSupply, false);
    }

    function maxDeposit(address) public view returns (uint256) {
        if (_paused) return 0;
        return MAX_96_BITS - _totalAssets;
    }

    function maxMint(address) public view returns (uint256) {
        if (_paused) return 0;
        return MAX_96_BITS - _totalSupply;
    }

    function maxWithdraw(address account) public view returns (uint256) {
        if (_paused) return 0;
        return _toAssets(_balances[account], _totalAssets, _totalSupply, false);
    }

    function maxRedeem(address account) public view returns (uint256) {
        if (_paused) return 0;
        return _balances[account];
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function pause() external onlyOwner {
        _paused = true;
        emit PausedEvent();
    }

    function unpause() external onlyOwner {
        _paused = false;
        emit UnpausedEvent();
    }

    function paused() external view returns (bool) {
        return _paused;
    }
}
