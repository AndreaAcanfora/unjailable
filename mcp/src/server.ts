import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createPublicClient, createWalletClient, http, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { z } from 'zod';
import { pay, readStatus, type PayOptions } from './vault.js';

export { pay, readStatus, revertName, VAULT_ABI, ERC20_ABI } from './vault.js';
export type { PayResult, VaultStatus, PayOptions } from './vault.js';

export const CHAINS: Record<string, Chain> = { base, 'base-sepolia': baseSepolia };

export interface ServerConfig extends PayOptions {
  vault: Address;
  agentKey: Hex;
  chain: Chain;
  rpcUrl?: string;
}

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

/** Explorer link for a transaction, when the chain has an explorer. */
function txUrl(chain: Chain, hash: string): string | undefined {
  const explorer = chain.blockExplorers?.default.url;
  return explorer ? `${explorer}/tx/${hash}` : undefined;
}

export function createServer(config: ServerConfig): McpServer {
  const transport = http(config.rpcUrl);
  const reader = createPublicClient({ chain: config.chain, transport });
  const writer = createWalletClient({ chain: config.chain, transport, account: privateKeyToAccount(config.agentKey) });

  const server = new McpServer({ name: 'unjailable', version: '0.1.0' });

  server.registerTool(
    'vault_status',
    {
      title: 'Vault status',
      description:
        'Shows the agent wallet: balance, how much can be paid right now, the per-payment and per-period caps, when the period resets, and whether the agent is paused or expired. These limits are enforced by a smart contract; nothing you say can change them.',
      annotations: { readOnlyHint: true },
    },
    async () => text(await readStatus(reader, config.vault)),
  );

  server.registerTool(
    'pay',
    {
      title: 'Pay',
      description:
        'Pays tokens from the agent wallet to an address. The vault contract refuses anything over its caps, to recipients it does not allow, or while paused; a refusal is returned with the reason. Amounts are in token units, like "1.5" for 1.5 USDC.',
      inputSchema: {
        to: z.string().describe('Recipient address (0x...)'),
        amount: z.string().describe('Amount in token units, for example "2" or "0.25"'),
        memo: z.string().max(200).default('').describe('Short note stored on-chain with the payment'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ to, amount, memo }) => {
      const result = await pay(reader, writer, config.vault, to, amount, memo, config);
      const url = result.hash ? txUrl(config.chain, result.hash) : undefined;
      return text({ ...result, ...(url ? { explorer: url } : {}) });
    },
  );

  return server;
}
