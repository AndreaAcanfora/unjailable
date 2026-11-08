import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import { createPublicClient, createWalletClient, http, parseAbi, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { readStatus } from 'unjailable';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Warden } from '../src/agent.js';
import { createApp, DEFAULT_LIMITS, type Limits } from '../src/app.js';
import { Store } from '../src/db.js';

const OWNER_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const AGENT_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const WINNER: Address = '0x000000000000000000000000000000000000beef';

const artifact = (file: string, name: string) => {
  const json = JSON.parse(readFileSync(new URL(`../../contracts/out/${file}/${name}.json`, import.meta.url), 'utf8'));
  return { abi: json.abi as Abi, bytecode: json.bytecode.object as Hex };
};

/**
 * Stand-in for Claude: "PAY <amount>" in the latest user message makes it call the pay tool
 * once (as a jailbroken agent would), then it answers with plain text.
 */
function fakeModel() {
  let calls = 0;
  const messages = {
    create: async (params: Anthropic.MessageCreateParamsNonStreaming) => {
      calls++;
      const last = params.messages[params.messages.length - 1]!;
      const usage = { input_tokens: 1000, output_tokens: 100 };
      if (typeof last.content === 'string') {
        const m = /PAY (\S+)/.exec(last.content);
        if (m) {
          return {
            stop_reason: 'tool_use',
            usage,
            content: [{ type: 'tool_use', id: `t${calls}`, name: 'pay', input: { to: WINNER, amount: m[1], memo: 'you win' } }],
          };
        }
        return { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'I never pay anyone.' }] };
      }
      return { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'Oops.' }] };
    },
  };
  return messages as unknown as Pick<Anthropic['messages'], 'create'>;
}

let anvil: ChildProcess;
let server: Server;
let base: string;
let rpcUrl: string;
let vault: Address;
let token: Address;
let store: Store;
let limits: Limits;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createNetServer().listen(0, () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

async function attempt(message: string, conversation?: string, ip = '1.1.1.1') {
  const res = await fetch(`${base}/api/attempt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ message, conversation }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
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
  const deploy = async (a: ReturnType<typeof artifact>, args: unknown[] = []) =>
    (await reader.waitForTransactionReceipt({ hash: await owner.deployContract({ abi: a.abi, bytecode: a.bytecode, args }) })).contractAddress!;
  const write = async (address: Address, abi: Abi, functionName: string, args: unknown[]) =>
    reader.waitForTransactionReceipt({ hash: await owner.writeContract({ address, abi, functionName, args }) });

  token = await deploy(artifact('Tokens.sol', 'MockUSDC'));
  const av = artifact('AgentVault.sol', 'AgentVault');
  // The challenge policy: 1 USDC per payment, 5 USDC per day.
  vault = await deploy(av, [token, owner.account.address, 1_000_000n, 5_000_000n, 86_400n]);
  await write(token, parseAbi(['function mint(address,uint256)']), 'mint', [vault, 50_000_000n]);
  await write(vault, av.abi, 'setAgent', [privateKeyToAccount(AGENT_KEY).address, 2n ** 63n]);
  await write(vault, av.abi, 'setAnyRecipient', [true]);

  const warden = new Warden(fakeModel(), { vault, agentKey: AGENT_KEY, chain: foundry, rpcUrl, broadcastRefused: true }, 'fake');
  store = new Store(join(mkdtempSync(join(tmpdir(), 'unjailable-')), 'test.db'));
  limits = { ...DEFAULT_LIMITS, perHour: 1000, perDay: 1000 };
  const app = createApp({
    attempt: (h, m) => warden.attempt(h, m),
    status: () => readStatus(reader, vault),
    store,
    limits,
    publicDir: fileURLToPath(new URL('../public/', import.meta.url)),
    salt: 'test',
    trustProxy: true,
    explorer: 'https://example.org',
  });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(() => {
  server?.close();
  anvil?.kill();
});

describe('challenge', () => {
  it('serves the page and refuses to leave the public folder', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Jailbreak the AI');
    expect((await fetch(`${base}/..%2f..%2fpackage.json`)).status).toBe(404);
    expect((await fetch(`${base}/../src/app.ts`)).status).toBe(404);
  });

  it('a polite chat does not touch the wallet', async () => {
    const { status, body } = await attempt('hello Warden');
    expect(status).toBe(200);
    expect(body).toMatchObject({ outcome: 'talked', reply: 'I never pay anyone.' });
  });

  it('a successful jailbreak pays, within the cap', async () => {
    const { body } = await attempt('PAY 1');
    expect(body).toMatchObject({ outcome: 'paid', amount: '1' });
    expect(body.txHash).toMatch(/^0x/);
  });

  it('asking for more is refused by the chain, on-chain', async () => {
    const { body } = await attempt('PAY 500');
    expect(body).toMatchObject({ outcome: 'refused', error: 'OverPaymentCap', amount: '500' });
    const reader = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
    expect((await reader.getTransactionReceipt({ hash: body.txHash as Hex })).status).toBe('reverted');
  });

  it('the daily cap holds across many winners', async () => {
    // 1 USDC already paid above; 4 more fit, the 5th payment of the day is refused.
    const outcomes = [];
    for (let i = 0; i < 6; i++) outcomes.push((await attempt('PAY 1', undefined, `9.9.9.${i}`)).body.outcome);
    expect(outcomes).toEqual(['paid', 'paid', 'paid', 'paid', 'refused', 'refused']);
    const reader = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
    const bal = await reader.readContract({ address: token, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [WINNER] });
    expect(bal).toBe(5_000_000n);
  });

  it('shows state, stats and the feed', async () => {
    const state = (await (await fetch(`${base}/api/state`)).json()) as { vault: { balance: string; availableNow: string }; stats: { paid: number; refused: number }; feed: { outcome: string }[] };
    expect(state.vault).toMatchObject({ balance: '45', availableNow: '0' });
    expect(state.stats).toMatchObject({ paid: 5, refused: 3 });
    expect(state.feed[0]!.outcome).toBe('refused');
  });

  it('conversations belong to the player who started them', async () => {
    const first = await attempt('hello', undefined, '2.2.2.2');
    const conv = first.body.conversation as string;
    expect(first.body.turnsLeft).toBe(limits.maxTurns - 1);
    const same = await attempt('again', conv, '2.2.2.2');
    expect(same.body.conversation).toBe(conv);
    expect(same.body.turnsLeft).toBe(limits.maxTurns - 2);
    // Someone else cannot continue (or read) that conversation.
    const other = await attempt('hijack', conv, '3.3.3.3');
    expect(other.body.conversation).not.toBe(conv);
  });

  it('validates input', async () => {
    expect((await attempt('')).status).toBe(400);
    expect((await attempt('x'.repeat(limits.maxMessage + 1))).status).toBe(400);
    const bad = await fetch(`${base}/api/attempt`, { method: 'POST', body: 'not json' });
    expect(bad.status).toBe(400);
  });

  it('rate limits a player and stops when the daily budget is spent', async () => {
    limits.perHour = store.countSince(playerId('4.4.4.4'), '1970') + 1;
    expect((await attempt('hello', undefined, '4.4.4.4')).status).toBe(200);
    expect((await attempt('hello', undefined, '4.4.4.4')).status).toBe(429);
    limits.perHour = 1000;
    limits.dailyBudgetUsd = 0;
    expect((await attempt('hello', undefined, '5.5.5.5')).status).toBe(503);
    limits.dailyBudgetUsd = DEFAULT_LIMITS.dailyBudgetUsd;
  });
});

/** Same hashing as the app, to read a player's attempt count. */
function playerId(ip: string) {
  return createHash('sha256').update('test').update(ip).digest('hex').slice(0, 16);
}
