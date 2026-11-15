// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// An ERC-20 that misbehaves on demand, to test how contracts treat bad tokens.
contract HostileToken {
    enum Mode {
        Honest,
        /// Keeps 1% of every transfer, so the recipient receives less than was sent.
        TakesFee,
        /// Returns false instead of reverting.
        ReturnsFalse,
        /// Reverts every transfer.
        Reverts,
        /// Moves tokens and returns no data, as some older tokens do.
        ReturnsNothing,
        /// Calls `target` with `callback` during every transfer, and records how that call reverted.
        Reenters
    }

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    Mode public mode;
    address public target;
    bytes public callback;
    bytes public callbackRevert;
    bool public callbackSucceeded;
    bool private reentering;

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function setReentry(address target_, bytes calldata callback_) external {
        mode = Mode.Reenters;
        target = target_;
        callback = callback_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        return _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) private returns (bool) {
        if (mode == Mode.ReturnsFalse) return false;
        if (mode == Mode.Reverts) revert("transfer refused");
        _reenter();

        uint256 fee = mode == Mode.TakesFee ? amount / 100 : 0;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;

        if (mode == Mode.ReturnsNothing) {
            assembly {
                return(0, 0)
            }
        }
        return true;
    }

    function _reenter() private {
        if (mode != Mode.Reenters || reentering) return;
        reentering = true;
        (bool ok, bytes memory reason) = target.call(callback);
        callbackSucceeded = ok;
        callbackRevert = reason;
        reentering = false;
    }
}
