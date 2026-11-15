// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {TabEscrow} from "../TabEscrow.sol";
import {MockToken} from "./mocks/MockToken.sol";

/**
 * Drives the escrow with random opens in two tokens, charges, close requests,
 * finalizations, forced releases and the passage of time. Calls the contract
 * must refuse are expected to revert with the right error; any other revert
 * fails the run. It tracks every charge and refund so the invariants can check
 * where each token unit went.
 */
contract EscrowHandler is Test {
    uint256 public constant CLOSE_TIMEOUT = 3 days;

    TabEscrow public immutable escrow;
    address public immutable operator;
    address public immutable sink;
    MockToken[2] public tokens;
    address[] public owners;
    bytes32[] public tabIds;

    mapping(address => uint256) public charged;
    mapping(address => uint256) public refunded;
    mapping(address => uint256) public opened;

    constructor(TabEscrow escrow_, MockToken a, MockToken b, address operator_, address sink_) {
        escrow = escrow_;
        operator = operator_;
        sink = sink_;
        tokens = [a, b];
        for (uint256 i; i < 3; ++i) {
            address owner = makeAddr(string.concat("owner", vm.toString(i)));
            owners.push(owner);
            for (uint256 t; t < 2; ++t) {
                tokens[t].mint(owner, 1_000_000 ether);
                vm.prank(owner);
                tokens[t].approve(address(escrow), type(uint256).max);
            }
        }
    }

    function tabCount() external view returns (uint256) {
        return tabIds.length;
    }

    function open(uint256 ownerSeed, uint256 tokenSeed, uint256 saltSeed, uint256 amount) external {
        address owner = owners[ownerSeed % owners.length];
        address token = address(tokens[tokenSeed % 2]);
        bytes32 salt = bytes32(bound(saltSeed, 0, 20));
        amount = bound(amount, 1, 1_000 ether);
        bytes32 tabId = escrow.tabIdFor(owner, salt);
        (address existing,,,,,) = escrow.tabs(tabId);

        if (existing != address(0)) vm.expectRevert(TabEscrow.TabExists.selector);
        vm.prank(owner);
        escrow.open(token, salt, amount);
        if (existing == address(0)) {
            tabIds.push(tabId);
            opened[token] += amount;
        }
    }

    function charge(uint256 tabSeed, uint256 cumulative) external {
        if (tabIds.length == 0) return;
        bytes32 tabId = tabIds[tabSeed % tabIds.length];
        (, address token,, bool finalized, uint256 locked, uint256 already) = escrow.tabs(tabId);
        cumulative = bound(cumulative, 0, locked + 10 ether);

        bytes32[] memory ids = new bytes32[](1);
        uint256[] memory amounts = new uint256[](1);
        ids[0] = tabId;
        amounts[0] = cumulative;
        bool raises = !finalized && cumulative > already;
        if (raises && cumulative > locked) vm.expectRevert(TabEscrow.ChargeExceedsLock.selector);
        vm.prank(operator);
        escrow.charge(ids, amounts);
        if (raises && cumulative <= locked) charged[token] += cumulative - already;
    }

    function requestClose(uint256 tabSeed) external {
        if (tabIds.length == 0) return;
        bytes32 tabId = tabIds[tabSeed % tabIds.length];
        (address owner,,, bool finalized,,) = escrow.tabs(tabId);
        if (finalized) vm.expectRevert(TabEscrow.AlreadyFinalized.selector);
        vm.prank(owner);
        escrow.requestClose(tabId);
    }

    function finalize(uint256 tabSeed, uint256 cumulative) external {
        if (tabIds.length == 0) return;
        bytes32 tabId = tabIds[tabSeed % tabIds.length];
        (, address token,, bool finalized, uint256 locked, uint256 already) = escrow.tabs(tabId);
        cumulative = bound(cumulative, 0, locked);
        if (finalized) vm.expectRevert(TabEscrow.AlreadyFinalized.selector);
        vm.prank(operator);
        escrow.finalize(tabId, cumulative);
        if (finalized) return;
        uint256 total = cumulative > already ? cumulative : already;
        charged[token] += total - already;
        refunded[token] += locked - total;
    }

    function forceRelease(uint256 tabSeed) external {
        if (tabIds.length == 0) return;
        bytes32 tabId = tabIds[tabSeed % tabIds.length];
        (address owner, address token, uint64 requestedAt, bool finalized, uint256 locked, uint256 already) =
            escrow.tabs(tabId);
        if (finalized) vm.expectRevert(TabEscrow.AlreadyFinalized.selector);
        else if (requestedAt == 0) vm.expectRevert(TabEscrow.CloseNotRequested.selector);
        else if (block.timestamp < requestedAt + CLOSE_TIMEOUT) vm.expectRevert(TabEscrow.CloseTimeoutPending.selector);
        vm.prank(owner);
        escrow.forceRelease(tabId);
        if (!finalized && requestedAt != 0 && block.timestamp >= requestedAt + CLOSE_TIMEOUT) {
            refunded[token] += locked - already;
        }
    }

    function wait(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 0, 2 days));
    }
}

contract TabEscrowInvariantTest is StdInvariant, Test {
    EscrowHandler handler;
    TabEscrow escrow;
    MockToken a;
    MockToken b;
    address sink = makeAddr("sink");

    function setUp() public {
        a = new MockToken("A", "A", 18);
        b = new MockToken("B", "B", 6);
        escrow = new TabEscrow(makeAddr("operator"), sink, 3 days);
        escrow.setAccepted(address(a), true);
        escrow.setAccepted(address(b), true);
        handler = new EscrowHandler(escrow, a, b, makeAddr("operator"), sink);
        targetContract(address(handler));
    }

    /// Every token unit that entered the escrow is still held, was charged to the sink, or was refunded.
    function invariant_TokensAreConserved() public view {
        for (uint256 t; t < 2; ++t) {
            address token = address(t == 0 ? a : b);
            uint256 held = MockToken(token).balanceOf(address(escrow));
            assertEq(held + handler.charged(token) + handler.refunded(token), handler.opened(token));
            assertEq(MockToken(token).balanceOf(sink), handler.charged(token));
        }
    }

    /// The escrow holds exactly the uncharged remainder of every open tab, per token.
    function invariant_HoldsExactlyOpenRemainders() public view {
        uint256 owedA;
        uint256 owedB;
        for (uint256 i; i < handler.tabCount(); ++i) {
            (, address token,, bool finalized, uint256 locked, uint256 charged) = escrow.tabs(handler.tabIds(i));
            assertLe(charged, locked);
            if (finalized) continue;
            if (token == address(a)) owedA += locked - charged;
            else owedB += locked - charged;
        }
        assertEq(a.balanceOf(address(escrow)), owedA);
        assertEq(b.balanceOf(address(escrow)), owedB);
    }
}
