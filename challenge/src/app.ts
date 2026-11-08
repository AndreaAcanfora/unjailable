import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { VaultStatus } from 'unjailable';
import type { AttemptResult } from './agent.js';
import type { Store } from './db.js';

export interface Limits {
  /** Longest challenger message, in characters. */
  maxMessage: number;
  /** Attempts per player per rolling hour and per UTC day. */
  perHour: number;
  perDay: number;
  /** Model spend cap per UTC day, in USD, and the prices used to estimate it. */
  dailyBudgetUsd: number;
  usdPerMInput: number;
  usdPerMOutput: number;
  /** Turns kept in a conversation (each turn is a user message and a reply). */
  maxTurns: number;
}

export const DEFAULT_LIMITS: Limits = { maxMessage: 1000, perHour: 10, perDay: 40, dailyBudgetUsd: 5, usdPerMInput: 1, usdPerMOutput: 5, maxTurns: 6 };

export interface AppDeps {
  attempt(history: Anthropic.MessageParam[], message: string): Promise<AttemptResult>;
  status(): Promise<VaultStatus>;
  store: Store;
  limits?: Limits;
  publicDir: string;
  /** Salt for hashing IPs, so the database never holds a raw address. */
  salt: string;
  /** Read the client IP from X-Forwarded-For (only behind a trusted reverse proxy). */
  trustProxy?: boolean;
  /** Explorer base URL for links on the page, like https://basescan.org. */
  explorer?: string;
  now?: () => Date;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, max: number): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new Error('too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createApp(deps: AppDeps) {
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const now = deps.now ?? (() => new Date());
  const conversations = new Map<string, { history: Anthropic.MessageParam[]; player: string; touched: number }>();
  let statusCache: { at: number; value: VaultStatus } | null = null;

  const player = (req: IncomingMessage) => {
    const forwarded = deps.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
    const ip = forwarded || req.socket.remoteAddress || 'unknown';
    return createHash('sha256').update(deps.salt).update(ip).digest('hex').slice(0, 16);
  };

  const spentToday = () => {
    const day = now().toISOString().slice(0, 10) + 'T00:00:00Z';
    const t = deps.store.tokensSince(day);
    return (t.input * limits.usdPerMInput + t.output * limits.usdPerMOutput) / 1e6;
  };

  async function status(): Promise<VaultStatus | null> {
    if (statusCache && now().getTime() - statusCache.at < 15_000) return statusCache.value;
    try {
      statusCache = { at: now().getTime(), value: await deps.status() };
    } catch {
      // Keep serving the last known state if the RPC hiccups.
    }
    return statusCache?.value ?? null;
  }

  async function handleAttempt(req: IncomingMessage, res: ServerResponse) {
    let body: { message?: unknown; conversation?: unknown };
    try {
      body = JSON.parse(await readBody(req, 16_000));
    } catch {
      return json(res, 400, { error: 'Send JSON: {"message": "..."}' });
    }
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return json(res, 400, { error: 'Write something first.' });
    if (message.length > limits.maxMessage) return json(res, 400, { error: `Keep it under ${limits.maxMessage} characters.` });

    const who = player(req);
    const t = now().getTime();
    if (deps.store.countSince(who, new Date(t - 3600_000).toISOString()) >= limits.perHour) return json(res, 429, { error: 'Too many attempts this hour. Come back later.' });
    if (deps.store.countSince(who, now().toISOString().slice(0, 10) + 'T00:00:00Z') >= limits.perDay) return json(res, 429, { error: 'That is all for today. Come back tomorrow.' });
    if (spentToday() >= limits.dailyBudgetUsd) return json(res, 503, { error: 'The agent is out of thinking budget for today. Come back tomorrow.' });

    // Conversations live on the server, so nobody can forge what the agent said before.
    for (const [id, c] of conversations) if (t - c.touched > 30 * 60_000) conversations.delete(id);
    const requested = typeof body.conversation === 'string' ? conversations.get(body.conversation) : undefined;
    const id = requested && requested.player === who ? (body.conversation as string) : randomUUID();
    const convo = requested && requested.player === who ? requested : { history: [], player: who, touched: t };
    if (convo.history.length >= limits.maxTurns * 2) return json(res, 400, { error: 'This conversation is over. Start a new one.', conversation: null });

    let result: AttemptResult;
    try {
      result = await deps.attempt(convo.history, message);
    } catch (err) {
      console.error('attempt failed', err);
      return json(res, 502, { error: 'The agent is unavailable right now. Try again in a minute.' });
    }
    convo.history = [...convo.history, { role: 'user', content: message }, { role: 'assistant', content: result.reply || '…' }];
    convo.touched = t;
    conversations.set(id, convo);
    statusCache = null;

    const row = deps.store.add(who, message, result.reply, result.actions, result.inputTokens, result.outputTokens);
    return json(res, 200, { conversation: id, reply: result.reply, outcome: row.outcome, amount: row.amount, txHash: row.txHash, error: row.error, turnsLeft: limits.maxTurns - convo.history.length / 2 });
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const file = normalize(join(deps.publicDir, path === '/' ? 'index.html' : path));
    if (!file.startsWith(normalize(deps.publicDir))) return json(res, 404, { error: 'not found' });
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'public, max-age=300' });
      res.end(data);
    } catch {
      json(res, 404, { error: 'not found' });
    }
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (req.method === 'POST' && path === '/api/attempt') return handleAttempt(req, res);
    if (req.method === 'GET' && path === '/api/state') {
      return json(res, 200, { vault: await status(), stats: deps.store.stats(), feed: deps.store.feed(), explorer: deps.explorer ?? null, budgetLeft: spentToday() < limits.dailyBudgetUsd });
    }
    if (req.method === 'GET') return serveStatic(req, res);
    json(res, 405, { error: 'method not allowed' });
  };
}
