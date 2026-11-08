// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentVault, IERC20} from "../src/AgentVault.sol";
import {MockUSDC} from "./mocks/Tokens.sol";

/// Plays a fully compromised agent plus random strangers against the vault: random payments,
/// random recipients, random amounts, time jumping forward, strangers calling owner functions.
/// Tracks what really left the vault so the invariants can check it against the policy.
contract Handler is Test {
    AgentVault public immutable vault;
    MockUSDC public immutable usdc;
    address public immutable agent;
    address[4] public strangers;

    /// Everything that left the vault through the agent.
    uint256 public paidTotal;
    /// What left in the window that started at `windowStart`.
    uint256 public windowStart;
    uint256 public paidThisWindow;
    /// Largest amount ever paid inside one window, and inside any 2 consecutive windows.
    uint256 public maxPerWindow;
    uint256 public paidLastWindow;
    uint256 public maxTwoWindows;
    /// Did a stranger ever move funds?
    bool public strangerMovedFunds;

    constructor(AgentVault vault_, MockUSDC usdc_, address agent_) {
        vault = vault_;
        usdc = usdc_;
        agent = agent_;
        windowStart = vault_.periodStart();
        for (uint256 i; i < 4; i++) strangers[i] = makeAddr(string.concat("stranger", vm.toString(i)));
    }

    function agentPays(uint256 recipientSeed, uint256 amount) external {
        address to = strangers[recipientSeed % 4];
        amount = bound(amount, 0, vault.perPaymentCap() * 2);
        uint256 before = usdc.balanceOf(address(vault));
        vm.prank(agent);
        try vault.pay(to, amount, "") {} catch {}
        _record(before - usdc.balanceOf(address(vault)));
    }

    function strangerTries(uint256 who, uint256 action, uint256 amount) external {
        address s = strangers[who % 4];
        uint256 before = usdc.balanceOf(address(vault));
        vm.startPrank(s);
        uint256 a = action % 6;
        if (a == 0) try vault.pay(s, amount, "") {} catch {}
        if (a == 1) try vault.withdraw(address(usdc), s, amount) {} catch {}
        if (a == 2) try vault.setAgent(s, type(uint64).max) {} catch {}
        if (a == 3) try vault.setPolicy(type(uint128).max, type(uint128).max, 1) {} catch {}
        if (a == 4) try vault.setPaused(false) {} catch {}
        if (a == 5) try vault.setRecipient(s, true) {} catch {}
        vm.stopPrank();
        if (usdc.balanceOf(address(vault)) != before) strangerMovedFunds = true;
    }

    function timePasses(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1, 3 days));
    }

    function _record(uint256 paid) private {
        // Track windows on the same grid the vault uses.
        uint256 len = vault.periodLength();
        if (block.timestamp >= windowStart + len) {
            uint256 next = block.timestamp - ((block.timestamp - windowStart) % len);
            paidLastWindow = next == windowStart + len ? paidThisWindow : 0;
            windowStart = next;
            paidThisWindow = 0;
        }
        paidThisWindow += paid;
        paidTotal += paid;
        if (paidThisWindow > maxPerWindow) maxPerWindow = paidThisWindow;
        if (paidThisWindow + paidLastWindow > maxTwoWindows) maxTwoWindows = paidThisWindow + paidLastWindow;
    }
}

contract AgentVaultInvariantTest is Test {
    uint128 constant PER_PAYMENT = 2e6;
    uint128 constant PER_DAY = 5e6;
    uint256 constant FUNDED = 1_000e6;

    AgentVault vault;
    MockUSDC usdc;
    Handler handler;
    address owner = makeAddr("owner");
    address agent = makeAddr("agent");

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();
        vault = new AgentVault(IERC20(address(usdc)), owner, PER_PAYMENT, PER_DAY, 1 days);
        usdc.mint(address(vault), FUNDED);
        vm.startPrank(owner);
        vault.setAgent(agent, type(uint64).max);
        vault.setAnyRecipient(true);
        vm.stopPrank();

        handler = new Handler(vault, usdc, agent);
        targetContract(address(handler));
    }

    /// Nothing leaves except through the agent's capped payments.
    function invariant_fundsOnlyLeaveThroughTheAgent() public view {
        assertEq(usdc.balanceOf(address(vault)) + handler.paidTotal(), FUNDED);
        assertFalse(handler.strangerMovedFunds());
    }

    /// One window never pays more than the period cap.
    function invariant_windowNeverExceedsCap() public view {
        assertLe(handler.maxPerWindow(), PER_DAY);
        assertLe(vault.spentInPeriod(), PER_DAY);
    }

    /// The documented worst case: two back-to-back windows, at most twice the cap.
    function invariant_twoWindowsAtMostTwiceTheCap() public view {
        assertLe(handler.maxTwoWindows(), 2 * PER_DAY);
    }

    /// Strangers never take over configuration.
    function invariant_configUntouched() public view {
        assertEq(vault.agent(), agent);
        assertEq(vault.perPaymentCap(), PER_PAYMENT);
        assertEq(vault.periodCap(), PER_DAY);
        assertEq(vault.periodLength(), 1 days);
    }
}
