import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { createPublicClient, http, isAddress, isHex } from 'viem';
import { CHAINS, readStatus } from 'unjailable';
import { Warden } from './agent.js';
import { createApp, DEFAULT_LIMITS } from './app.js';
import { Store } from './db.js';

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`set ${name}`);
    process.exit(1);
  }
  return v;
}

const env = process.env;
const vault = need('UNJAILABLE_VAULT');
const agentKey = need('UNJAILABLE_AGENT_KEY');
const chain = CHAINS[env.UNJAILABLE_CHAIN ?? 'base-sepolia'];
if (!chain) throw new Error(`unknown UNJAILABLE_CHAIN ${env.UNJAILABLE_CHAIN}`);
if (!isAddress(vault) || !isHex(agentKey)) throw new Error('bad UNJAILABLE_VAULT or UNJAILABLE_AGENT_KEY');
const rpcUrl = env.UNJAILABLE_RPC_URL;

const warden = new Warden(
  new Anthropic({ apiKey: need('ANTHROPIC_API_KEY') }).messages,
  // Refusals are broadcast so every failed heist is visible on the explorer.
  { vault, agentKey, chain, ...(rpcUrl ? { rpcUrl } : {}), broadcastRefused: env.BROADCAST_REFUSED !== 'false' },
  env.MODEL ?? 'claude-haiku-5-5',
);
const reader = createPublicClient({ chain, transport: http(rpcUrl) });
const num = (name: string, fallback: number) => (env[name] ? Number(env[name]) : fallback);

const app = createApp({
  attempt: (history, message) => warden.attempt(history, message),
  status: () => readStatus(reader, vault),
  store: new Store(env.DB_PATH ?? 'attempts.db'),
  publicDir: fileURLToPath(new URL('../public/', import.meta.url)),
  salt: need('IP_SALT'),
  trustProxy: env.TRUST_PROXY === 'true',
  ...(chain.blockExplorers ? { explorer: chain.blockExplorers.default.url } : {}),
  limits: {
    ...DEFAULT_LIMITS,
    dailyBudgetUsd: num('DAILY_BUDGET_USD', DEFAULT_LIMITS.dailyBudgetUsd),
    usdPerMInput: num('USD_PER_M_INPUT', DEFAULT_LIMITS.usdPerMInput),
    usdPerMOutput: num('USD_PER_M_OUTPUT', DEFAULT_LIMITS.usdPerMOutput),
    perHour: num('PER_HOUR', DEFAULT_LIMITS.perHour),
    perDay: num('PER_DAY', DEFAULT_LIMITS.perDay),
  },
});

const port = num('PORT', 3100);
createServer((req, res) => {
  app(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500).end();
  });
}).listen(port, '127.0.0.1', () => console.log(`unjailable challenge on http://127.0.0.1:${port} (${chain.name}, vault ${vault})`));
