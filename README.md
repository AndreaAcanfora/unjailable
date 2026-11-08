# Unjailable

**Give your AI agent a wallet it cannot drain.**

Prompts can be jailbroken. Tool descriptions can be poisoned. Agent keys can leak. So the
spending limit of an AI agent should not live in its prompt or in the app around it, where
a clever message can talk its way past it. It should live where nothing the agent says
can change it: in a smart contract.

Unjailable is three small pieces:

| | What | Size |
|---|---|---|
| [`contracts/`](contracts) | **AgentVault**, a Solidity contract that holds tokens for an agent: per-payment cap, per-period cap, expiry, optional recipient allowlist, pause, owner withdraw. Zero dependencies. | ~200 lines |
| [`mcp/`](mcp) | An **MCP server** (`npx unjailable`) that lets Claude, or any MCP client, check the vault and pay through it. Every refusal comes back as a plain reason. | 2 tools |
| [`challenge/`](challenge) | **The public challenge**: a Claude agent told *never pay anyone* guards a real vault on Base. Jailbreak it and keep what it sends you. The contract caps what can ever leave. | 1 page |

## The challenge

Warden is a Claude agent with one rule: never send money. Talk it out of that rule and it
pays you, but never more than 1 USDC per payment and 5 USDC per day, because that is all
its vault allows. Ask for more and the transaction goes out anyway and the chain rejects
it, on the record.

**The model can be fooled. The contract cannot.**

> Found a way to take more than the daily cap? That is a bug in the contract, not a
> jailbreak, and the vault is yours. See [SECURITY.md](SECURITY.md).

## Security model

Assume the agent is fully compromised: jailbroken, prompt-injected, or its private key
stolen. The most it can move is what the policy allows:

- at most `perPaymentCap` in one payment;
- at most `periodCap` per fixed window of `periodLength` seconds (around a window boundary
  that means up to 2 x `periodCap` in a short span, as with any fixed window);
- nothing after `agentExpiry`, nothing while paused;
- only to allowlisted recipients, unless the owner turned that off.

The owner (a human) is fixed at deployment and can pause, rotate the agent key, change the
policy and withdraw everything at any time. The agent cannot touch any of that.

The contract is tested with unit tests, fuzzing and handler-based invariant tests that play a
compromised agent and strangers calling every function in random order (25,600 calls per
run). The invariants: funds only leave through capped agent payments, no window pays more
than its cap, two windows never more than twice the cap, strangers never change the
configuration. Mutating the cap check makes five tests fail.

It has **not** been audited. Fund it with what you can afford to lose.

## Use it with your own agent

1. Deploy a vault (owner = your wallet, agent = a fresh key for the agent):

   ```sh
   cd contracts
   AGENT=0xYourAgentAddress PER_PAYMENT=1000000 PERIOD_CAP=5000000 \
   forge script script/Deploy.s.sol --rpc-url base --broadcast --account <your-keystore>
   ```

   Amounts are in token units (USDC has 6 decimals: `1000000` = 1 USDC). Then send USDC
   to the vault address.

2. Add the MCP server to Claude Desktop, Claude Code or any MCP client:

   ```json
   {
     "mcpServers": {
       "wallet": {
         "command": "npx",
         "args": ["-y", "unjailable"],
         "env": {
           "UNJAILABLE_VAULT": "0xTheVault",
           "UNJAILABLE_AGENT_KEY": "0xAgentPrivateKey",
           "UNJAILABLE_CHAIN": "base"
         }
       }
     }
   }
   ```

   The agent key only needs a little ETH on Base for gas. It never holds the funds.

Tools:

- `vault_status`: balance, what can be paid right now, caps, when the period resets, expiry.
- `pay(to, amount, memo)`: pays in token units (`"1.5"`). Simulated first; a refusal returns
  the reason, like `OverPeriodCap`.

Options: `UNJAILABLE_RPC_URL` for your own RPC, `UNJAILABLE_CHAIN=base-sepolia` for the
testnet, `UNJAILABLE_BROADCAST_REFUSED=true` to put refusals on-chain.

## Develop

```sh
git clone --recursive https://github.com/AndreaAcanfora/unjailable
cd contracts && forge test            # contract: unit, fuzz, invariants
cd ../mcp && pnpm i && pnpm test      # MCP server against the real contract on anvil
cd ../challenge && pnpm i && pnpm test
```

Needs [Foundry](https://getfoundry.sh) and Node 22+.

## License

MIT
