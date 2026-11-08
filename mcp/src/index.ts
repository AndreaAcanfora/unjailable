#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isAddress, isHex } from 'viem';
import { CHAINS, createServer } from './server.js';

function fail(message: string): never {
  process.stderr.write(`unjailable: ${message}\n`);
  process.exit(1);
}

const env = process.env;
const vault = env.UNJAILABLE_VAULT ?? fail('set UNJAILABLE_VAULT to the vault address');
const agentKey = env.UNJAILABLE_AGENT_KEY ?? fail('set UNJAILABLE_AGENT_KEY to the agent private key');
const chainName = env.UNJAILABLE_CHAIN ?? 'base';
const chain = CHAINS[chainName] ?? fail(`unknown UNJAILABLE_CHAIN "${chainName}" (use ${Object.keys(CHAINS).join(' or ')})`);
if (!isAddress(vault)) fail('UNJAILABLE_VAULT is not an address');
if (!isHex(agentKey) || agentKey.length !== 66) fail('UNJAILABLE_AGENT_KEY must be a 0x-prefixed 32-byte hex key');

const server = createServer({
  vault,
  agentKey,
  chain,
  ...(env.UNJAILABLE_RPC_URL ? { rpcUrl: env.UNJAILABLE_RPC_URL } : {}),
  broadcastRefused: env.UNJAILABLE_BROADCAST_REFUSED === 'true',
});
await server.connect(new StdioServerTransport());
