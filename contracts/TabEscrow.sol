// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * Holds ERC-20 tokens behind inference tabs.
 *
 * An owner opens a tab by locking an accepted token. The operator charges
 * usage by posting each tab's cumulative charge, so a repeated or delayed post
 * can never charge twice, and no post can exceed the lock. Charged tokens go to
 * `sink`, which is fixed at deployment: a treasury, or a dead address to burn
 * them. Finalizing charges the last usage and returns the rest to the owner.
 *
 * If the operator never finalizes a tab its owner asked to close, the owner can
 * take back everything not yet charged after `closeTimeout`. Nobody, including
 * the admin, can send locked tokens anywhere except `sink` or the tab's owner.
 *
 * The admin can revoke the operator at once, but a new operator only takes
 * over `operatorDelay()` (twice `closeTimeout`) after it is proposed. That is
 * long enough for every owner to close and force-release first, so an admin
 * cannot install an operator that charges tabs their owners did not agree to.
 */
contract TabEscrow {
    struct Tab {
        address owner;
        address token;
        uint64 closeRequestedAt;
        bool finalized;
        uint256 locked;
        uint256 charged;
    }

    address public immutable sink;
    uint256 public immutable closeTimeout;
    address public admin;
    address public pendingAdmin;
    address public operator;
    address public pendingOperator;
    uint256 public pendingOperatorReadyAt;
    bool private entered;

    /// Tokens that can open new tabs. Removing a token never affects open tabs.
    mapping(address => bool) public accepted;
    mapping(bytes32 => Tab) public tabs;

    event TabOpened(bytes32 indexed tabId, address indexed owner, address indexed token, uint256 amount);
    event TabCharged(bytes32 indexed tabId, uint256 amount, uint256 cumulativeCharged);
    event TabCloseRequested(bytes32 indexed tabId, address indexed owner);
    event TabFinalized(bytes32 indexed tabId, address indexed owner, uint256 charged, uint256 refunded, bool forced);
    event TokenAccepted(address indexed token, bool accepted);
    event OperatorProposed(address indexed operator, uint256 readyAt);
    event OperatorChanged(address indexed operator);
    event AdminTransferStarted(address indexed pendingAdmin);
    event AdminTransferred(address indexed admin);

    error Unauthorized();
    error ReentrantCall();
    error InvalidAddress();
    error InvalidAmount();
    error ArrayLengthMismatch();
    error TokenNotAccepted();
    error TabExists();
    error UnknownTab();
    error AlreadyFinalized();
    error ChargeExceedsLock();
    error CloseNotRequested();
    error CloseTimeoutPending();
    error OperatorNotReady();
    error TransferFailed();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (entered) revert ReentrantCall();
        entered = true;
        _;
        entered = false;
    }

    constructor(address operator_, address sink_, uint256 closeTimeout_) {
        if (operator_ == address(0) || sink_ == address(0)) revert InvalidAddress();
        if (closeTimeout_ == 0) revert InvalidAmount();
        operator = operator_;
        sink = sink_;
        closeTimeout = closeTimeout_;
        admin = msg.sender;
    }

    /// A tab id is bound to its owner, so nobody can take an id by front-running its open.
    function tabIdFor(address tabOwner, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(tabOwner, salt));
    }

    function open(address token, bytes32 salt, uint256 amount) external nonReentrant returns (bytes32 tabId) {
        if (!accepted[token]) revert TokenNotAccepted();
        if (amount == 0) revert InvalidAmount();
        tabId = tabIdFor(msg.sender, salt);
        Tab storage tab = tabs[tabId];
        if (tab.owner != address(0)) revert TabExists();

        tab.owner = msg.sender;
        tab.token = token;
        tab.locked = amount;

        // Fee-on-transfer tokens would leave the tab backed by less than it records.
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        _call(token, abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), amount)));
        if (IERC20(token).balanceOf(address(this)) - balanceBefore != amount) revert TransferFailed();

        emit TabOpened(tabId, msg.sender, token, amount);
    }

    /**
     * Posts cumulative charges. A post at or below the recorded charge is
     * skipped, as is any tab that was already finalized, so retrying is safe.
     */
    function charge(bytes32[] calldata tabIds, uint256[] calldata cumulativeCharged) external onlyOperator nonReentrant {
        if (tabIds.length != cumulativeCharged.length) revert ArrayLengthMismatch();
        for (uint256 i; i < tabIds.length; ++i) {
            Tab storage tab = tabs[tabIds[i]];
            if (tab.owner == address(0)) revert UnknownTab();
            if (tab.finalized) continue;
            uint256 amount = _recordCharge(tabIds[i], tab, cumulativeCharged[i]);
            if (amount != 0) _call(tab.token, abi.encodeCall(IERC20.transfer, (sink, amount)));
        }
    }

    function requestClose(bytes32 tabId) external {
        Tab storage tab = tabs[tabId];
        if (tab.owner != msg.sender) revert Unauthorized();
        if (tab.finalized) revert AlreadyFinalized();
        if (tab.closeRequestedAt != 0) return;
        tab.closeRequestedAt = uint64(block.timestamp);
        emit TabCloseRequested(tabId, msg.sender);
    }

    /// Charges usage up to `finalCumulativeCharged` and returns everything else to the owner.
    function finalize(bytes32 tabId, uint256 finalCumulativeCharged) external onlyOperator nonReentrant {
        Tab storage tab = tabs[tabId];
        if (tab.owner == address(0)) revert UnknownTab();
        if (tab.finalized) revert AlreadyFinalized();

        uint256 chargeNow = _recordCharge(tabId, tab, finalCumulativeCharged);
        tab.finalized = true;
        uint256 refund = tab.locked - tab.charged;

        if (chargeNow != 0) _call(tab.token, abi.encodeCall(IERC20.transfer, (sink, chargeNow)));
        if (refund != 0) _call(tab.token, abi.encodeCall(IERC20.transfer, (tab.owner, refund)));
        emit TabFinalized(tabId, tab.owner, tab.charged, refund, false);
    }

    /// The owner's exit if the operator has not finalized a close request in time.
    function forceRelease(bytes32 tabId) external nonReentrant {
        Tab storage tab = tabs[tabId];
        if (tab.owner != msg.sender) revert Unauthorized();
        if (tab.finalized) revert AlreadyFinalized();
        if (tab.closeRequestedAt == 0) revert CloseNotRequested();
        if (block.timestamp < tab.closeRequestedAt + closeTimeout) revert CloseTimeoutPending();

        tab.finalized = true;
        uint256 refund = tab.locked - tab.charged;

        if (refund != 0) _call(tab.token, abi.encodeCall(IERC20.transfer, (msg.sender, refund)));
        emit TabFinalized(tabId, msg.sender, tab.charged, refund, true);
    }

    function setAccepted(address token, bool isAccepted) external onlyAdmin {
        if (token.code.length == 0) revert InvalidAddress();
        accepted[token] = isAccepted;
        emit TokenAccepted(token, isAccepted);
    }

    function operatorDelay() public view returns (uint256) {
        return 2 * closeTimeout;
    }

    /// Starts the notice period for a new operator. Proposing again restarts it.
    function proposeOperator(address nextOperator) external onlyAdmin {
        if (nextOperator == address(0)) revert InvalidAddress();
        pendingOperator = nextOperator;
        pendingOperatorReadyAt = block.timestamp + operatorDelay();
        emit OperatorProposed(nextOperator, pendingOperatorReadyAt);
    }

    /// Anyone can install the proposed operator once its notice period has passed.
    function acceptOperator() external {
        address next = pendingOperator;
        if (next == address(0) || block.timestamp < pendingOperatorReadyAt) revert OperatorNotReady();
        operator = next;
        pendingOperator = address(0);
        pendingOperatorReadyAt = 0;
        emit OperatorChanged(next);
    }

    /// Stops all charging at once, such as after a leaked operator key. Owners can still force-release.
    function revokeOperator() external onlyAdmin {
        operator = address(0);
        pendingOperator = address(0);
        pendingOperatorReadyAt = 0;
        emit OperatorChanged(address(0));
    }

    function transferAdmin(address nextAdmin) external onlyAdmin {
        pendingAdmin = nextAdmin;
        emit AdminTransferStarted(nextAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert Unauthorized();
        admin = msg.sender;
        pendingAdmin = address(0);
        emit AdminTransferred(msg.sender);
    }

    function _recordCharge(bytes32 tabId, Tab storage tab, uint256 cumulative) private returns (uint256 amount) {
        if (cumulative <= tab.charged) return 0;
        if (cumulative > tab.locked) revert ChargeExceedsLock();
        amount = cumulative - tab.charged;
        tab.charged = cumulative;
        emit TabCharged(tabId, amount, cumulative);
    }

    /// Accepts tokens that return true or return nothing.
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory result) = token.call(data);
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
}
