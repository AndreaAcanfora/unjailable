// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentVault, IERC20} from "../src/AgentVault.sol";
import {MockUSDC, NoReturnToken, FalseToken, HookToken, ReentrantAgent, IPayable} from "./mocks/Tokens.sol";

contract AgentVaultTest is Test {
    uint128 constant USDC = 1e6;
    uint128 constant PER_PAYMENT = 2 * USDC;
    uint128 constant PER_DAY = 5 * USDC;

    MockUSDC usdc;
    AgentVault vault;
    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address alice = makeAddr("alice");
    address mallory = makeAddr("mallory");

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();
        vault = new AgentVault(IERC20(address(usdc)), owner, PER_PAYMENT, PER_DAY, 1 days);
        usdc.mint(address(vault), 100 * USDC);
        vm.startPrank(owner);
        vault.setAgent(agent, uint64(block.timestamp + 30 days));
        vault.setAnyRecipient(true);
        vm.stopPrank();
    }

    function pay(address to, uint256 amount) internal {
        vm.prank(agent);
        vault.pay(to, amount, "");
    }

    // ------------------------------------------------------------ happy path

    function test_agentPaysWithinPolicy() public {
        pay(alice, PER_PAYMENT);
        assertEq(usdc.balanceOf(alice), PER_PAYMENT);
        assertEq(vault.spentInPeriod(), PER_PAYMENT);
    }

    function test_emitsPaidWithMemo() public {
        vm.expectEmit(true, false, false, true, address(vault));
        emit AgentVault.Paid(alice, 1 * USDC, "coffee");
        vm.prank(agent);
        vault.pay(alice, 1 * USDC, "coffee");
    }

    // ------------------------------------------------------------ who can pay

    function test_onlyAgentCanPay() public {
        for (uint256 i; i < 3; i++) {
            address caller = [owner, alice, mallory][i];
            vm.prank(caller);
            vm.expectRevert(AgentVault.NotAgent.selector);
            vault.pay(caller, 1, "");
        }
    }

    function test_noAgentMeansNobodyPays() public {
        vm.prank(owner);
        vault.setAgent(address(0), type(uint64).max);
        vm.prank(address(0));
        vm.expectRevert(AgentVault.NotAgent.selector);
        vault.pay(alice, 1, "");
        assertEq(vault.available(), 0);
    }

    function test_agentExpires() public {
        vm.warp(vault.agentExpiry());
        vm.prank(agent);
        vm.expectRevert(AgentVault.AgentExpired.selector);
        vault.pay(alice, 1, "");
    }

    function test_pauseStopsTheAgent() public {
        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(agent);
        vm.expectRevert(AgentVault.IsPaused.selector);
        vault.pay(alice, 1, "");
        assertEq(vault.available(), 0);
    }

    function test_rotatingTheAgentLocksOutTheOldKey() public {
        address fresh = makeAddr("fresh");
        vm.prank(owner);
        vault.setAgent(fresh, uint64(block.timestamp + 1 days));
        vm.prank(agent);
        vm.expectRevert(AgentVault.NotAgent.selector);
        vault.pay(alice, 1, "");
        vm.prank(fresh);
        vault.pay(alice, 1, "");
    }

    // ------------------------------------------------------------ caps

    function test_perPaymentCap() public {
        vm.prank(agent);
        vm.expectRevert(AgentVault.OverPaymentCap.selector);
        vault.pay(alice, PER_PAYMENT + 1, "");
    }

    function test_periodCap() public {
        pay(alice, PER_PAYMENT);
        pay(alice, PER_PAYMENT);
        pay(alice, PER_DAY - 2 * PER_PAYMENT);
        vm.prank(agent);
        vm.expectRevert(AgentVault.OverPeriodCap.selector);
        vault.pay(alice, 1, "");
        assertEq(vault.available(), 0);
    }

    function test_periodResetsAfterItEnds() public {
        pay(alice, PER_PAYMENT);
        pay(alice, PER_PAYMENT);
        pay(alice, PER_DAY - 2 * PER_PAYMENT);
        vm.warp(vault.periodEnd());
        assertEq(vault.available(), PER_PAYMENT);
        pay(alice, PER_PAYMENT);
        assertEq(vault.spentInPeriod(), PER_PAYMENT);
    }

    function test_windowsStayAlignedAfterIdleDays() public {
        uint256 start = vault.periodStart();
        vm.warp(start + 3 days + 5 hours);
        pay(alice, 1);
        assertEq(vault.periodStart(), start + 3 days);
        assertEq(vault.periodEnd(), start + 4 days);
    }

    function test_availableIsCappedByBalance() public {
        uint256 balance = usdc.balanceOf(address(vault));
        vm.prank(owner);
        vault.withdraw(address(usdc), owner, balance - 1);
        assertEq(vault.available(), 1);
    }

    function test_loweringTheCapBelowSpentBlocksTheRestOfThePeriod() public {
        pay(alice, PER_PAYMENT);
        vm.prank(owner);
        vault.setPolicy(1, 1, 1 days);
        assertEq(vault.available(), 0);
        vm.prank(agent);
        vm.expectRevert(AgentVault.OverPeriodCap.selector);
        vault.pay(alice, 1, "");
    }

    // ------------------------------------------------------------ recipients

    function test_allowlistMode() public {
        vm.prank(owner);
        vault.setAnyRecipient(false);
        vm.prank(agent);
        vm.expectRevert(AgentVault.RecipientNotAllowed.selector);
        vault.pay(mallory, 1, "");

        vm.prank(owner);
        vault.setRecipient(alice, true);
        pay(alice, 1);
        assertEq(usdc.balanceOf(alice), 1);
    }

    function test_cannotPayZeroAddressOrItself() public {
        vm.startPrank(agent);
        vm.expectRevert(AgentVault.RecipientNotAllowed.selector);
        vault.pay(address(0), 1, "");
        vm.expectRevert(AgentVault.RecipientNotAllowed.selector);
        vault.pay(address(vault), 1, "");
        vm.stopPrank();
    }

    // ------------------------------------------------------------ owner powers

    function test_onlyOwnerCanConfigure() public {
        vm.startPrank(agent);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.setAgent(agent, type(uint64).max);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.setPolicy(PER_DAY, PER_DAY, 1 days);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.setRecipient(mallory, true);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.setAnyRecipient(true);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.setPaused(false);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.withdraw(address(usdc), agent, 1);
        vm.stopPrank();
    }

    function test_ownerWithdrawsTokensAndEth() public {
        vm.deal(address(vault), 1 ether);
        vm.startPrank(owner);
        vault.withdraw(address(usdc), owner, 100 * USDC);
        vault.withdraw(address(0), owner, 1 ether);
        vm.stopPrank();
        assertEq(usdc.balanceOf(owner), 100 * USDC);
        assertEq(owner.balance, 1 ether);
    }

    function test_badPolicyRejected() public {
        vm.startPrank(owner);
        vm.expectRevert(AgentVault.BadPolicy.selector);
        vault.setPolicy(1, 1, 0);
        vm.expectRevert(AgentVault.BadPolicy.selector);
        vault.setPolicy(2, 1, 1 days);
        vm.stopPrank();
        vm.expectRevert(AgentVault.BadPolicy.selector);
        new AgentVault(IERC20(address(usdc)), address(0), 1, 1, 1);
        vm.expectRevert(AgentVault.BadPolicy.selector);
        new AgentVault(IERC20(address(0)), owner, 1, 1, 1);
    }

    // ------------------------------------------------------------ odd tokens

    function test_tokenWithoutReturnValue() public {
        NoReturnToken usdt = new NoReturnToken();
        AgentVault v = new AgentVault(IERC20(address(usdt)), owner, PER_PAYMENT, PER_DAY, 1 days);
        usdt.mint(address(v), 10 * USDC);
        vm.startPrank(owner);
        v.setAgent(agent, type(uint64).max);
        v.setAnyRecipient(true);
        vm.stopPrank();
        vm.prank(agent);
        v.pay(alice, 1 * USDC, "");
        assertEq(usdt.balanceOf(alice), 1 * USDC);
    }

    function test_tokenReturningFalseReverts() public {
        FalseToken bad = new FalseToken();
        AgentVault v = new AgentVault(IERC20(address(bad)), owner, PER_PAYMENT, PER_DAY, 1 days);
        vm.startPrank(owner);
        v.setAgent(agent, type(uint64).max);
        v.setAnyRecipient(true);
        vm.stopPrank();
        vm.prank(agent);
        vm.expectRevert(AgentVault.TransferFailed.selector);
        v.pay(alice, 1, "");
        assertEq(v.spentInPeriod(), 0, "a failed payment must not count");
    }

    function test_withdrawToNonContractTokenReverts() public {
        vm.prank(owner);
        vm.expectRevert(AgentVault.TransferFailed.selector);
        vault.withdraw(makeAddr("not a token"), owner, 1);
    }

    function test_reentrantAgentCannotBeatThePeriodCap() public {
        HookToken hook = new HookToken();
        ReentrantAgent evil = new ReentrantAgent();
        AgentVault v = new AgentVault(IERC20(address(hook)), owner, PER_PAYMENT, PER_DAY, 1 days);
        hook.mint(address(v), 100 * USDC);
        evil.setVault(IPayable(address(v)));
        vm.startPrank(owner);
        v.setAgent(address(evil), type(uint64).max);
        v.setAnyRecipient(true);
        vm.stopPrank();

        evil.start(PER_PAYMENT);
        assertGt(evil.reentries(), 0, "the hook fired");
        assertLe(hook.balanceOf(address(evil)), PER_DAY);
        assertEq(v.spentInPeriod(), hook.balanceOf(address(evil)));
    }

    // ------------------------------------------------------------ fuzz

    /// Whatever sequence of amounts and delays the agent tries, it never gets more than
    /// periodCap out of any single window.
    function testFuzz_neverMoreThanCapPerWindow(uint256[12] memory amounts, uint32[12] memory delays) public {
        uint256 windowStart = vault.periodStart();
        uint256 paidThisWindow;
        for (uint256 i; i < amounts.length; i++) {
            vm.warp(block.timestamp + (delays[i] % 2 days));
            if (block.timestamp >= vault.agentExpiry()) break;
            uint256 amount = amounts[i] % (PER_PAYMENT + 2);
            uint256 before = usdc.balanceOf(alice);
            vm.prank(agent);
            try vault.pay(alice, amount, "") {} catch {}
            uint256 got = usdc.balanceOf(alice) - before;
            if (vault.periodStart() != windowStart) {
                windowStart = vault.periodStart();
                paidThisWindow = 0;
            }
            paidThisWindow += got;
            assertLe(got, PER_PAYMENT);
            assertLe(paidThisWindow, PER_DAY);
        }
    }
}
