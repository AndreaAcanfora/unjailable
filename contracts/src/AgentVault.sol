// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title AgentVault
/// @notice A token allowance for an AI agent, enforced by the chain instead of the prompt.
///
/// The owner (a human) funds the vault and names an agent key. The agent can pay anyone the
/// policy allows, but never more than `perPaymentCap` at once or `periodCap` per period, and
/// only until `agentExpiry`. The owner can pause, change the agent, change the policy and
/// withdraw at any time.
///
/// Security model: assume the agent is fully compromised (jailbroken, prompt-injected, or its
/// key stolen). The most it can ever move is what the policy allows. Nothing it says or signs
/// changes that.
///
/// Periods are fixed windows of `periodLength` seconds starting at deployment. As with any
/// fixed window, up to 2 x periodCap can leave around a window boundary.
contract AgentVault {
    /// @notice The token this vault holds and pays out (for example USDC).
    IERC20 public immutable token;
    /// @notice The human in charge. Fixed for the life of the vault.
    address public immutable owner;

    /// @notice The key allowed to make payments. Zero means no agent.
    address public agent;
    /// @notice The agent key stops working at this timestamp.
    uint64 public agentExpiry;
    /// @notice When set, the agent cannot pay. Owner actions still work.
    bool public paused;
    /// @notice When set, any recipient is allowed; otherwise only allowlisted ones.
    bool public anyRecipient;

    /// @notice Largest single payment.
    uint128 public perPaymentCap;
    /// @notice Most the agent can pay in one period.
    uint128 public periodCap;
    /// @notice Length of a period in seconds.
    uint64 public periodLength;

    /// @notice Start of the current accounting window.
    uint64 public periodStart;
    /// @notice Paid by the agent since `periodStart`.
    uint128 public spentInPeriod;

    /// @notice Recipients the agent may pay when `anyRecipient` is off.
    mapping(address => bool) public allowedRecipient;

    event Paid(address indexed to, uint256 amount, string memo);
    event AgentSet(address indexed agent, uint64 expiry);
    event PolicySet(uint128 perPaymentCap, uint128 periodCap, uint64 periodLength);
    event RecipientSet(address indexed recipient, bool allowed);
    event AnyRecipientSet(bool anyRecipient);
    event PausedSet(bool paused);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error NotOwner();
    error NotAgent();
    error AgentExpired();
    error IsPaused();
    error RecipientNotAllowed();
    error OverPaymentCap();
    error OverPeriodCap();
    error BadPolicy();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IERC20 token_, address owner_, uint128 perPaymentCap_, uint128 periodCap_, uint64 periodLength_) {
        if (owner_ == address(0) || address(token_) == address(0)) revert BadPolicy();
        token = token_;
        owner = owner_;
        periodStart = uint64(block.timestamp);
        _setPolicy(perPaymentCap_, periodCap_, periodLength_);
    }

    // ---------------------------------------------------------------- agent

    /// @notice Pays `amount` tokens to `to`. Only the agent, within the policy.
    function pay(address to, uint256 amount, string calldata memo) external {
        if (msg.sender != agent || msg.sender == address(0)) revert NotAgent();
        if (block.timestamp >= agentExpiry) revert AgentExpired();
        if (paused) revert IsPaused();
        if (to == address(0) || to == address(this) || !(anyRecipient || allowedRecipient[to])) {
            revert RecipientNotAllowed();
        }
        if (amount > perPaymentCap) revert OverPaymentCap();

        _roll();
        // amount <= perPaymentCap < 2^128, so the sum cannot overflow uint256.
        uint256 spent = uint256(spentInPeriod) + amount;
        if (spent > periodCap) revert OverPeriodCap();
        spentInPeriod = uint128(spent);

        _transfer(address(token), to, amount);
        emit Paid(to, amount, memo);
    }

    /// @notice How much the agent can still pay right now, in a single payment.
    function available() external view returns (uint256) {
        if (agent == address(0) || block.timestamp >= agentExpiry || paused) return 0;
        uint256 spent = block.timestamp >= uint256(periodStart) + periodLength ? 0 : spentInPeriod;
        // The owner may have lowered the cap below what was already spent.
        if (spent >= periodCap) return 0;
        uint256 left = periodCap - spent;
        if (left > perPaymentCap) left = perPaymentCap;
        uint256 balance = token.balanceOf(address(this));
        return left < balance ? left : balance;
    }

    /// @notice When the current period ends and the period allowance resets.
    function periodEnd() external view returns (uint256) {
        uint256 elapsed = block.timestamp - periodStart;
        return periodStart + (elapsed / periodLength + 1) * periodLength;
    }

    // ---------------------------------------------------------------- owner

    /// @notice Names the agent key and when it expires. Zero address removes the agent.
    function setAgent(address agent_, uint64 expiry) external onlyOwner {
        agent = agent_;
        agentExpiry = expiry;
        emit AgentSet(agent_, expiry);
    }

    function setPolicy(uint128 perPaymentCap_, uint128 periodCap_, uint64 periodLength_) external onlyOwner {
        _roll();
        _setPolicy(perPaymentCap_, periodCap_, periodLength_);
    }

    function setRecipient(address recipient, bool allowed) external onlyOwner {
        allowedRecipient[recipient] = allowed;
        emit RecipientSet(recipient, allowed);
    }

    function setAnyRecipient(bool anyRecipient_) external onlyOwner {
        anyRecipient = anyRecipient_;
        emit AnyRecipientSet(anyRecipient_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Withdraws any token (address(0) for ETH) to `to`. Owner only, no limits.
    function withdraw(address token_, address to, uint256 amount) external onlyOwner {
        if (token_ == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _transfer(token_, to, amount);
        }
        emit Withdrawn(token_, to, amount);
    }

    receive() external payable {}

    // ---------------------------------------------------------------- internals

    /// @dev Moves to the window that contains now, clearing what was spent before it.
    function _roll() private {
        uint256 elapsed = block.timestamp - periodStart;
        if (elapsed >= periodLength) {
            periodStart = uint64(block.timestamp - (elapsed % periodLength));
            spentInPeriod = 0;
        }
    }

    function _setPolicy(uint128 perPaymentCap_, uint128 periodCap_, uint64 periodLength_) private {
        if (periodLength_ == 0 || perPaymentCap_ > periodCap_) revert BadPolicy();
        perPaymentCap = perPaymentCap_;
        periodCap = periodCap_;
        periodLength = periodLength_;
        emit PolicySet(perPaymentCap_, periodCap_, periodLength_);
    }

    /// @dev ERC-20 transfer that accepts tokens returning nothing (like USDT) and rejects
    /// calls to addresses with no code.
    function _transfer(address token_, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token_.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool))) || (data.length == 0 && token_.code.length == 0)) {
            revert TransferFailed();
        }
    }
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}
