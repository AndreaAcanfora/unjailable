// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {AgentVault, IERC20} from "../src/AgentVault.sol";

/// Deploys a vault owned by the broadcaster and names its agent.
///
///   AGENT=0x... PER_PAYMENT=1000000 PERIOD_CAP=5000000 \
///   forge script script/Deploy.s.sol --rpc-url base-sepolia --broadcast --account <keystore>
///
/// Optional: TOKEN (defaults to USDC on the chain), PERIOD_LENGTH (seconds, default 1 day),
/// AGENT_DAYS (default 30), ANY_RECIPIENT (default true).
contract Deploy is Script {
    address constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant USDC_BASE_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external returns (AgentVault vault) {
        address token = vm.envExists("TOKEN") ? vm.envAddress("TOKEN") : defaultToken();
        address agent = vm.envAddress("AGENT");
        uint128 perPayment = uint128(vm.envUint("PER_PAYMENT"));
        uint128 periodCap = uint128(vm.envUint("PERIOD_CAP"));
        uint64 periodLength = uint64(vm.envOr("PERIOD_LENGTH", uint256(1 days)));
        uint64 expiry = uint64(block.timestamp + vm.envOr("AGENT_DAYS", uint256(30)) * 1 days);

        vm.startBroadcast();
        vault = new AgentVault(IERC20(token), msg.sender, perPayment, periodCap, periodLength);
        vault.setAgent(agent, expiry);
        vault.setAnyRecipient(vm.envOr("ANY_RECIPIENT", true));
        vm.stopBroadcast();

        console.log("AgentVault", address(vault));
        console.log("token", token);
        console.log("owner", msg.sender);
        console.log("agent", agent);
    }

    function defaultToken() internal view returns (address) {
        if (block.chainid == 8453) return USDC_BASE;
        if (block.chainid == 84532) return USDC_BASE_SEPOLIA;
        revert("set TOKEN on this chain");
    }
}
