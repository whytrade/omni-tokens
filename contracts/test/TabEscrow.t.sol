// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {TabEscrow} from "../TabEscrow.sol";
import {HostileToken} from "./mocks/HostileToken.sol";
import {MockToken} from "./mocks/MockToken.sol";

contract TabEscrowTest is Test {
    uint256 constant CLOSE_TIMEOUT = 3 days;
    bytes32 constant SALT = keccak256("salt");
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    MockToken token;
    MockToken usdc;
    TabEscrow escrow;
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        token = new MockToken("Community", "COMM", 18);
        usdc = new MockToken("USD Coin", "USDC", 6);
        escrow = new TabEscrow(operator, treasury, CLOSE_TIMEOUT);
        escrow.setAccepted(address(token), true);
        escrow.setAccepted(address(usdc), true);
        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? alice : bob;
            token.mint(who, 1_000 ether);
            usdc.mint(who, 1_000e6);
            vm.startPrank(who);
            token.approve(address(escrow), type(uint256).max);
            usdc.approve(address(escrow), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _open(address owner, uint256 amount) internal returns (bytes32) {
        vm.prank(owner);
        return escrow.open(address(token), SALT, amount);
    }

    function _charge(bytes32 tabId, uint256 cumulative) internal {
        bytes32[] memory ids = new bytes32[](1);
        uint256[] memory amounts = new uint256[](1);
        ids[0] = tabId;
        amounts[0] = cumulative;
        vm.prank(operator);
        escrow.charge(ids, amounts);
    }

    function _tab(bytes32 tabId)
        internal
        view
        returns (address owner, address tabToken, uint64 closeRequestedAt, bool finalized, uint256 locked, uint256 charged)
    {
        return escrow.tabs(tabId);
    }

    // --- open ---

    function test_OpenDerivesTabIdFromOwnerAndSalt() public {
        bytes32 tabId = _open(alice, 100 ether);
        assertEq(tabId, keccak256(abi.encode(alice, SALT)));
        assertEq(escrow.tabIdFor(alice, SALT), tabId, "a tab id can be computed before opening");
        (address owner, address tabToken,,, uint256 locked,) = _tab(tabId);
        assertEq(owner, alice);
        assertEq(tabToken, address(token));
        assertEq(locked, 100 ether);
        assertEq(token.balanceOf(address(escrow)), 100 ether);
    }

    function test_OpenEmitsTokenForIndexers() public {
        vm.expectEmit(address(escrow));
        emit TabEscrow.TabOpened(escrow.tabIdFor(alice, SALT), alice, address(usdc), 5e6);
        vm.prank(alice);
        escrow.open(address(usdc), SALT, 5e6);
    }

    function test_SameSaltFromAnotherOwnerIsAnotherTab() public {
        assertTrue(_open(alice, 100 ether) != _open(bob, 1 ether));
    }

    function test_OpenRevertsWhenTabExists() public {
        _open(alice, 100 ether);
        vm.prank(alice);
        vm.expectRevert(TabEscrow.TabExists.selector);
        escrow.open(address(usdc), SALT, 1e6);
    }

    function test_OpenRevertsOnZero() public {
        vm.prank(alice);
        vm.expectRevert(TabEscrow.InvalidAmount.selector);
        escrow.open(address(token), SALT, 0);
    }

    function test_OpenRevertsForTokenNotAccepted() public {
        MockToken other = new MockToken("Other", "OTH", 18);
        other.mint(alice, 1 ether);
        vm.startPrank(alice);
        other.approve(address(escrow), 1 ether);
        vm.expectRevert(TabEscrow.TokenNotAccepted.selector);
        escrow.open(address(other), SALT, 1 ether);
        vm.stopPrank();
    }

    function test_RemovingATokenLeavesOpenTabsWorking() public {
        bytes32 tabId = _open(alice, 100 ether);
        escrow.setAccepted(address(token), false);
        _charge(tabId, 10 ether);
        vm.prank(operator);
        escrow.finalize(tabId, 20 ether);
        assertEq(token.balanceOf(alice), 980 ether);
        assertEq(token.balanceOf(treasury), 20 ether);

        vm.prank(bob);
        vm.expectRevert(TabEscrow.TokenNotAccepted.selector);
        escrow.open(address(token), SALT, 1 ether);
    }

    // --- charge ---

    function test_ChargeSendsDeltaToSinkOnce() public {
        bytes32 tabId = _open(alice, 100 ether);
        _charge(tabId, 30 ether);
        vm.recordLogs();
        _charge(tabId, 30 ether);
        assertEq(vm.getRecordedLogs().length, 0, "a repeated post moves nothing");
        (,,,,, uint256 charged) = _tab(tabId);
        assertEq(charged, 30 ether);
        assertEq(token.balanceOf(treasury), 30 ether);
        assertEq(token.balanceOf(address(escrow)), 70 ether);
    }

    function test_ChargeSkipsStalePost() public {
        bytes32 tabId = _open(alice, 100 ether);
        _charge(tabId, 50 ether);
        _charge(tabId, 30 ether);
        (,,,,, uint256 charged) = _tab(tabId);
        assertEq(charged, 50 ether);
        assertEq(token.balanceOf(treasury), 50 ether);
    }

    function test_ChargeBatchesTabsAcrossTokens() public {
        bytes32 aliceTab = _open(alice, 100 ether);
        vm.prank(bob);
        bytes32 bobTab = escrow.open(address(usdc), SALT, 100e6);
        bytes32[] memory ids = new bytes32[](2);
        uint256[] memory amounts = new uint256[](2);
        (ids[0], ids[1]) = (aliceTab, bobTab);
        (amounts[0], amounts[1]) = (10 ether, 20e6);
        vm.prank(operator);
        escrow.charge(ids, amounts);
        assertEq(token.balanceOf(treasury), 10 ether);
        assertEq(usdc.balanceOf(treasury), 20e6);
    }

    function test_BurnModeSendsChargesToDeadAddress() public {
        TabEscrow burner = new TabEscrow(operator, DEAD, CLOSE_TIMEOUT);
        burner.setAccepted(address(token), true);
        vm.startPrank(alice);
        token.approve(address(burner), type(uint256).max);
        bytes32 tabId = burner.open(address(token), SALT, 100 ether);
        vm.stopPrank();
        vm.prank(operator);
        burner.finalize(tabId, 40 ether);
        assertEq(token.balanceOf(DEAD), 40 ether);
        assertEq(token.balanceOf(alice), 960 ether);
    }

    function test_ChargeRevertsAboveLocked() public {
        bytes32 tabId = _open(alice, 100 ether);
        bytes32[] memory ids = new bytes32[](1);
        uint256[] memory amounts = new uint256[](1);
        ids[0] = tabId;
        amounts[0] = 100 ether + 1;
        vm.prank(operator);
        vm.expectRevert(TabEscrow.ChargeExceedsLock.selector);
        escrow.charge(ids, amounts);
    }

    function test_ChargeRevertsForUnknownTab() public {
        bytes32[] memory ids = new bytes32[](1);
        uint256[] memory amounts = new uint256[](1);
        ids[0] = keccak256("missing");
        amounts[0] = 1;
        vm.prank(operator);
        vm.expectRevert(TabEscrow.UnknownTab.selector);
        escrow.charge(ids, amounts);
    }

    function test_ChargeRevertsOnLengthMismatch() public {
        vm.prank(operator);
        vm.expectRevert(TabEscrow.ArrayLengthMismatch.selector);
        escrow.charge(new bytes32[](1), new uint256[](0));
    }

    function test_OnlyOperatorCharges() public {
        bytes32 tabId = _open(alice, 100 ether);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = tabId;
        vm.prank(alice);
        vm.expectRevert(TabEscrow.Unauthorized.selector);
        escrow.charge(ids, new uint256[](1));
    }

    function test_ChargeSkipsFinalizedTab() public {
        bytes32 tabId = _open(alice, 100 ether);
        vm.prank(operator);
        escrow.finalize(tabId, 10 ether);
        _charge(tabId, 50 ether);
        (,,,,, uint256 charged) = _tab(tabId);
        assertEq(charged, 10 ether);
    }

    // --- close, finalize, force release ---

    function test_FinalizeChargesRemainderAndRefunds() public {
        bytes32 tabId = _open(alice, 100 ether);
        _charge(tabId, 30 ether);
        vm.expectEmit(address(escrow));
        emit TabEscrow.TabFinalized(tabId, alice, 45 ether, 55 ether, false);
        vm.prank(operator);
        escrow.finalize(tabId, 45 ether);
        (,,, bool finalized,, uint256 charged) = _tab(tabId);
        assertTrue(finalized);
        assertEq(charged, 45 ether);
        assertEq(token.balanceOf(treasury), 45 ether);
        assertEq(token.balanceOf(alice), 955 ether);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_FinalizeWithStaleChargeKeepsRecordedCharge() public {
        bytes32 tabId = _open(alice, 100 ether);
        _charge(tabId, 30 ether);
        vm.prank(operator);
        escrow.finalize(tabId, 10 ether);
        assertEq(token.balanceOf(alice), 970 ether);
    }

    function test_FinalizeOnlyOnce() public {
        bytes32 tabId = _open(alice, 100 ether);
        vm.startPrank(operator);
        escrow.finalize(tabId, 0);
        vm.expectRevert(TabEscrow.AlreadyFinalized.selector);
        escrow.finalize(tabId, 0);
        vm.stopPrank();
    }

    function test_FinalizeRevertsAboveLocked() public {
        bytes32 tabId = _open(alice, 100 ether);
        vm.prank(operator);
        vm.expectRevert(TabEscrow.ChargeExceedsLock.selector);
        escrow.finalize(tabId, 100 ether + 1);
    }

    function test_FinalizeRevertsForUnknownTab() public {
        vm.prank(operator);
        vm.expectRevert(TabEscrow.UnknownTab.selector);
        escrow.finalize(keccak256("missing"), 0);
    }

    function test_OnlyOperatorFinalizes() public {
        bytes32 tabId = _open(alice, 100 ether);
        vm.prank(alice);
        vm.expectRevert(TabEscrow.Unauthorized.selector);
        escrow.finalize(tabId, 0);
    }

    function test_OnlyOwnerRequestsClose() public {
        bytes32 tabId = _open(alice, 100 ether);
        vm.prank(bob);
        vm.expectRevert(TabEscrow.Unauthorized.selector);
        escrow.requestClose(tabId);
    }

    function test_RepeatedCloseRequestKeepsFirstTimestamp() public {
        bytes32 tabId = _open(alice, 100 ether);
        vm.prank(alice);
        escrow.requestClose(tabId);
        (,, uint64 first,,,) = _tab(tabId);
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        escrow.requestClose(tabId);
        (,, uint64 second,,,) = _tab(tabId);
        assertEq(first, second);
    }

    function test_CloseRequestAfterFinalizeReverts() public {
        bytes32 tabId = _open(alice, 100 ether);
        vm.prank(operator);
        escrow.finalize(tabId, 0);
        vm.prank(alice);
        vm.expectRevert(TabEscrow.AlreadyFinalized.selector);
        escrow.requestClose(tabId);
    }

    function test_ForceReleaseAfterTimeoutReturnsUncharged() public {
        bytes32 tabId = _open(alice, 100 ether);
        _charge(tabId, 25 ether);
        vm.prank(alice);
        escrow.requestClose(tabId);
        vm.warp(block.timestamp + CLOSE_TIMEOUT);
        vm.expectEmit(address(escrow));
        emit TabEscrow.TabFinalized(tabId, alice, 25 ether, 75 ether, true);
        vm.prank(alice);
        escrow.forceRelease(tabId);
        assertEq(token.balanceOf(alice), 975 ether);
        assertEq(token.balanceOf(treasury), 25 ether, "posted charges stay with the operator");
    }

    function test_OperatorCanChargeDuringCloseWindow() public {
        bytes32 tabId = _open(alice, 100 ether);
        vm.prank(alice);
        escrow.requestClose(tabId);
        _charge(tabId, 40 ether);
        vm.warp(block.timestamp + CLOSE_TIMEOUT);
        vm.prank(alice);
        escrow.forceRelease(tabId);
        assertEq(token.balanceOf(alice), 960 ether);
    }

    function test_ForceReleaseBeforeTimeoutReverts() public {
        bytes32 tabId = _open(alice, 100 ether);
        vm.prank(alice);
        escrow.requestClose(tabId);
        vm.warp(block.timestamp + CLOSE_TIMEOUT - 1);
        vm.prank(alice);
        vm.expectRevert(TabEscrow.CloseTimeoutPending.selector);
        escrow.forceRelease(tabId);
    }

    function test_ForceReleaseRequiresCloseRequest() public {
        bytes32 tabId = _open(alice, 100 ether);
        vm.prank(alice);
        vm.expectRevert(TabEscrow.CloseNotRequested.selector);
        escrow.forceRelease(tabId);
    }

    function test_OnlyOwnerForceReleases() public {
        bytes32 tabId = _open(alice, 100 ether);
        vm.prank(alice);
        escrow.requestClose(tabId);
        vm.warp(block.timestamp + CLOSE_TIMEOUT);
        vm.prank(bob);
        vm.expectRevert(TabEscrow.Unauthorized.selector);
        escrow.forceRelease(tabId);
    }

    function test_ForceReleaseAfterFinalizeReverts() public {
        bytes32 tabId = _open(alice, 100 ether);
        vm.prank(alice);
        escrow.requestClose(tabId);
        vm.prank(operator);
        escrow.finalize(tabId, 0);
        vm.warp(block.timestamp + CLOSE_TIMEOUT);
        vm.prank(alice);
        vm.expectRevert(TabEscrow.AlreadyFinalized.selector);
        escrow.forceRelease(tabId);
    }

    // --- admin ---

    function test_OnlyAdminAcceptsTokens() public {
        vm.prank(operator);
        vm.expectRevert(TabEscrow.Unauthorized.selector);
        escrow.setAccepted(address(token), false);
    }

    function test_AcceptRejectsAddressWithoutCode() public {
        vm.expectRevert(TabEscrow.InvalidAddress.selector);
        escrow.setAccepted(makeAddr("eoa"), true);
    }

    function test_NewOperatorWaitsLongEnoughForOwnersToLeave() public {
        bytes32 tabId = _open(alice, 100 ether);
        escrow.proposeOperator(bob);
        assertEq(escrow.operatorDelay(), 2 * CLOSE_TIMEOUT);
        vm.expectRevert(TabEscrow.OperatorNotReady.selector);
        escrow.acceptOperator();

        // An owner who distrusts the new operator closes and leaves in time.
        vm.prank(alice);
        escrow.requestClose(tabId);
        vm.warp(block.timestamp + CLOSE_TIMEOUT);
        vm.prank(alice);
        escrow.forceRelease(tabId);
        assertEq(token.balanceOf(alice), 1_000 ether);

        vm.warp(block.timestamp + CLOSE_TIMEOUT - 1);
        vm.expectRevert(TabEscrow.OperatorNotReady.selector);
        escrow.acceptOperator();
        vm.warp(block.timestamp + 1);
        vm.prank(alice);
        escrow.acceptOperator();
        assertEq(escrow.operator(), bob);
        assertEq(escrow.pendingOperator(), address(0));
    }

    function test_OnlyAdminProposesOrRevokes() public {
        vm.startPrank(alice);
        vm.expectRevert(TabEscrow.Unauthorized.selector);
        escrow.proposeOperator(alice);
        vm.expectRevert(TabEscrow.Unauthorized.selector);
        escrow.revokeOperator();
        vm.stopPrank();
    }

    function test_AdminCannotProposeZeroOperator() public {
        vm.expectRevert(TabEscrow.InvalidAddress.selector);
        escrow.proposeOperator(address(0));
    }

    function test_RevokeStopsChargingAtOnceAndCancelsProposal() public {
        bytes32 tabId = _open(alice, 100 ether);
        escrow.proposeOperator(bob);
        escrow.revokeOperator();
        assertEq(escrow.operator(), address(0));

        bytes32[] memory ids = new bytes32[](1);
        ids[0] = tabId;
        vm.prank(operator);
        vm.expectRevert(TabEscrow.Unauthorized.selector);
        escrow.charge(ids, new uint256[](1));

        vm.warp(block.timestamp + 2 * CLOSE_TIMEOUT);
        vm.expectRevert(TabEscrow.OperatorNotReady.selector);
        escrow.acceptOperator();

        vm.prank(alice);
        escrow.requestClose(tabId);
        vm.warp(block.timestamp + CLOSE_TIMEOUT);
        vm.prank(alice);
        escrow.forceRelease(tabId);
        assertEq(token.balanceOf(alice), 1_000 ether, "owners still get out");
    }

    function test_AdminTransferIsTwoStep() public {
        vm.prank(bob);
        vm.expectRevert(TabEscrow.Unauthorized.selector);
        escrow.acceptAdmin();
        escrow.transferAdmin(bob);
        assertEq(escrow.admin(), address(this), "the old admin stays until accepted");
        vm.prank(bob);
        escrow.acceptAdmin();
        assertEq(escrow.admin(), bob);
        vm.expectRevert(TabEscrow.Unauthorized.selector);
        escrow.proposeOperator(alice);
    }

    function test_ConstructorRejectsBadConfig() public {
        vm.expectRevert(TabEscrow.InvalidAddress.selector);
        new TabEscrow(address(0), treasury, CLOSE_TIMEOUT);
        vm.expectRevert(TabEscrow.InvalidAddress.selector);
        new TabEscrow(operator, address(0), CLOSE_TIMEOUT);
        vm.expectRevert(TabEscrow.InvalidAmount.selector);
        new TabEscrow(operator, treasury, 0);
    }

    // --- hostile tokens ---

    function _hostile() internal returns (HostileToken bad) {
        bad = new HostileToken();
        escrow.setAccepted(address(bad), true);
        bad.mint(alice, 1_000 ether);
        vm.prank(alice);
        bad.approve(address(escrow), type(uint256).max);
    }

    function test_OpenRevertsWhenLessArrivesThanWasLocked() public {
        HostileToken bad = _hostile();
        bad.setMode(HostileToken.Mode.TakesFee);
        vm.prank(alice);
        vm.expectRevert(TabEscrow.TransferFailed.selector);
        escrow.open(address(bad), SALT, 100 ether);
    }

    function test_OpenRevertsWhenTransferReturnsFalse() public {
        HostileToken bad = _hostile();
        bad.setMode(HostileToken.Mode.ReturnsFalse);
        vm.prank(alice);
        vm.expectRevert(TabEscrow.TransferFailed.selector);
        escrow.open(address(bad), SALT, 100 ether);
    }

    function test_RefundThatFailsLeavesTabOpen() public {
        HostileToken bad = _hostile();
        vm.prank(alice);
        bytes32 tabId = escrow.open(address(bad), SALT, 100 ether);
        bad.setMode(HostileToken.Mode.Reverts);
        vm.prank(operator);
        vm.expectRevert(TabEscrow.TransferFailed.selector);
        escrow.finalize(tabId, 10 ether);
        (,,, bool finalized,, uint256 charged) = _tab(tabId);
        assertFalse(finalized);
        assertEq(charged, 0);

        bad.setMode(HostileToken.Mode.Honest);
        vm.prank(operator);
        escrow.finalize(tabId, 10 ether);
        assertEq(bad.balanceOf(alice), 990 ether);
    }

    function test_TokenThatReturnsNothingIsAccepted() public {
        HostileToken bad = _hostile();
        bad.setMode(HostileToken.Mode.ReturnsNothing);
        vm.prank(alice);
        bytes32 tabId = escrow.open(address(bad), SALT, 100 ether);
        vm.prank(operator);
        escrow.finalize(tabId, 10 ether);
        assertEq(bad.balanceOf(alice), 990 ether);
        assertEq(bad.balanceOf(treasury), 10 ether);
    }

    function test_TokenCannotReenter() public {
        HostileToken bad = _hostile();
        vm.prank(alice);
        bytes32 tabId = escrow.open(address(bad), SALT, 100 ether);

        bad.setReentry(address(escrow), abi.encodeCall(TabEscrow.open, (address(bad), keccak256("inner"), 1)));
        vm.prank(operator);
        escrow.finalize(tabId, 10 ether);
        assertFalse(bad.callbackSucceeded());
        assertEq(bad.callbackRevert(), abi.encodeWithSelector(TabEscrow.ReentrantCall.selector));
        assertEq(bad.balanceOf(alice), 990 ether);
    }

    // --- conservation ---

    function testFuzz_ChargeAndFinalizeConserveTokens(uint256 locked, uint256 firstCharge, uint256 finalCharge) public {
        locked = bound(locked, 1, 1_000 ether);
        firstCharge = bound(firstCharge, 0, locked);
        finalCharge = bound(finalCharge, 0, locked);
        bytes32 tabId = _open(alice, locked);
        _charge(tabId, firstCharge);
        vm.prank(operator);
        escrow.finalize(tabId, finalCharge);

        uint256 charged = firstCharge > finalCharge ? firstCharge : finalCharge;
        assertEq(token.balanceOf(treasury), charged);
        assertEq(token.balanceOf(alice), 1_000 ether - charged);
        assertEq(token.balanceOf(address(escrow)), 0);
    }
}
