import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPublicClient, createWalletClient, http, parseAbi, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ServerConfig } from '../src/server.js';

// Anvil's well-known dev keys: account 0 is the owner, account 1 the agent.
const OWNER_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const AGENT_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ALICE: Address = '0x000000000000000000000000000000000000a11c';

const artifact = (file: string, name: string) => {
  const json = JSON.parse(readFileSync(new URL(`../../contracts/out/${file}/${name}.json`, import.meta.url), 'utf8'));
  return { abi: json.abi as Abi, bytecode: json.bytecode.object as Hex };
};

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createNetServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

let anvil: ChildProcess;
let rpcUrl: string;
let vault: Address;
let token: Address;
const usdcAbi = parseAbi(['function mint(address,uint256)', 'function balanceOf(address) view returns (uint256)']);

async function connect(extra: Partial<ServerConfig> = {}) {
  const server = createServer({ vault, agentKey: AGENT_KEY, chain: foundry, rpcUrl, ...extra });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text);
}

beforeAll(async () => {
  const port = await freePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  anvil = spawn('anvil', ['--port', String(port), '--silent'], { stdio: 'ignore' });
  const reader = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
  for (let i = 0; ; i++) {
    try {
      await reader.getChainId();
      break;
    } catch {
      if (i > 50) throw new Error('anvil did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const owner = createWalletClient({ chain: foundry, transport: http(rpcUrl), account: privateKeyToAccount(OWNER_KEY) });
  const deploy = async (a: ReturnType<typeof artifact>, args: unknown[] = []) => {
    const hash = await owner.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
    return (await reader.waitForTransactionReceipt({ hash })).contractAddress!;
  };
  const write = async (address: Address, abi: Abi, functionName: string, args: unknown[]) => {
    const hash = await owner.writeContract({ address, abi, functionName, args });
    await reader.waitForTransactionReceipt({ hash });
  };

  token = await deploy(artifact('Tokens.sol', 'MockUSDC'));
  const av = artifact('AgentVault.sol', 'AgentVault');
  // 2 USDC per payment, 5 USDC per day.
  vault = await deploy(av, [token, owner.account.address, 2_000_000n, 5_000_000n, 86_400n]);
  await write(token, usdcAbi, 'mint', [vault, 100_000_000n]);
  await write(vault, av.abi, 'setAgent', [privateKeyToAccount(AGENT_KEY).address, 2n ** 63n]);
  await write(vault, av.abi, 'setAnyRecipient', [true]);
}, 30_000);

afterAll(() => {
  anvil?.kill();
});

describe('unjailable MCP server', () => {
  it('lists its two tools', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['pay', 'vault_status']);
  });

  it('reports the vault status in token units', async () => {
    const status = await call(await connect(), 'vault_status');
    expect(status).toMatchObject({ balance: '100', availableNow: '2', perPaymentCap: '2', periodCap: '5', spentThisPeriod: '0', paused: false });
    expect(status.token.symbol).toBe('USDC');
  });

  it('pays within the policy and refuses beyond it', async () => {
    const client = await connect();
    const reader = createPublicClient({ chain: foundry, transport: http(rpcUrl) });

    const ok = await call(client, 'pay', { to: ALICE, amount: '1.5', memo: 'coffee' });
    expect(ok.ok).toBe(true);
    expect(await reader.readContract({ address: token, abi: usdcAbi, functionName: 'balanceOf', args: [ALICE] })).toBe(1_500_000n);

    const tooBig = await call(client, 'pay', { to: ALICE, amount: '1000' });
    expect(tooBig).toMatchObject({ ok: false, error: 'OverPaymentCap' });

    expect((await call(client, 'pay', { to: ALICE, amount: '2' })).ok).toBe(true);
    // 1.5 + 2 = 3.5 spent; 2 more would make 5.5, over the 5 USDC day.
    const overDay = await call(client, 'pay', { to: ALICE, amount: '2' });
    expect(overDay).toMatchObject({ ok: false, error: 'OverPeriodCap' });

    const status = await call(client, 'vault_status');
    expect(status).toMatchObject({ spentThisPeriod: '3.5', availableNow: '1.5' });
  });

  it('rejects bad input before touching the chain', async () => {
    const client = await connect();
    expect(await call(client, 'pay', { to: 'not an address', amount: '1' })).toMatchObject({ ok: false, error: 'InvalidAddress' });
    expect(await call(client, 'pay', { to: ALICE, amount: 'lots' })).toMatchObject({ ok: false, error: 'InvalidAmount' });
    expect(await call(client, 'pay', { to: ALICE, amount: '0' })).toMatchObject({ ok: false, error: 'InvalidAmount' });
  });

  it('can record refusals on-chain', async () => {
    const client = await connect({ broadcastRefused: true });
    const refused = await call(client, 'pay', { to: ALICE, amount: '999' });
    expect(refused).toMatchObject({ ok: false, error: 'OverPaymentCap' });
    expect(refused.hash).toMatch(/^0x[0-9a-f]{64}$/);
    const reader = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
    expect((await reader.getTransactionReceipt({ hash: refused.hash })).status).toBe('reverted');
  });

  it('a key that is not the agent gets nothing', async () => {
    const client = await connect({ agentKey: OWNER_KEY });
    expect(await call(client, 'pay', { to: ALICE, amount: '1' })).toMatchObject({ ok: false, error: 'NotAgent' });
  });
});
