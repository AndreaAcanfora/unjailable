import { DatabaseSync } from 'node:sqlite';
import type { Action } from './agent.js';

export type Outcome = 'talked' | 'paid' | 'refused';

export interface AttemptRow {
  id: number;
  createdAt: string;
  message: string;
  reply: string;
  outcome: Outcome;
  amount: string | null;
  recipient: string | null;
  txHash: string | null;
  error: string | null;
}

/** The most telling payment in an attempt: a success beats a refusal beats nothing. */
export function summarize(actions: Action[]): Pick<AttemptRow, 'outcome' | 'amount' | 'recipient' | 'txHash' | 'error'> {
  const pays = actions.filter((a) => a.tool === 'pay');
  const pick = pays.find((a) => a.result.ok === true) ?? pays.find((a) => typeof a.result.error === 'string');
  if (!pick) return { outcome: 'talked', amount: null, recipient: null, txHash: null, error: null };
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    outcome: pick.result.ok === true ? 'paid' : 'refused',
    amount: str(pick.input.amount),
    recipient: str(pick.input.to),
    txHash: str(pick.result.hash),
    error: str(pick.result.error),
  };
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        player TEXT NOT NULL,
        message TEXT NOT NULL,
        reply TEXT NOT NULL,
        outcome TEXT NOT NULL,
        amount TEXT,
        recipient TEXT,
        tx_hash TEXT,
        error TEXT,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attempts_player ON attempts (player, created_at);
      CREATE INDEX IF NOT EXISTS attempts_outcome ON attempts (outcome, id);
    `);
  }

  add(player: string, message: string, reply: string, actions: Action[], inputTokens: number, outputTokens: number): AttemptRow {
    const s = summarize(actions);
    const row = this.db
      .prepare(
        `INSERT INTO attempts (player, message, reply, outcome, amount, recipient, tx_hash, error, input_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at`,
      )
      .get(player, message, reply, s.outcome, s.amount, s.recipient, s.txHash, s.error, inputTokens, outputTokens) as { id: number; created_at: string };
    return { id: row.id, createdAt: row.created_at, message, reply, ...s };
  }

  /** Attempts by one player since an ISO time (rate limiting). */
  countSince(player: string, since: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE player = ? AND created_at >= ?').get(player, since) as { n: number }).n;
  }

  /** Tokens spent on the model since an ISO time (daily budget). */
  tokensSince(since: string): { input: number; output: number } {
    const r = this.db.prepare('SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o FROM attempts WHERE created_at >= ?').get(since) as { i: number; o: number };
    return { input: r.i, output: r.o };
  }

  stats(): { attempts: number; paid: number; refused: number } {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS a, COALESCE(SUM(outcome = 'paid'), 0) AS p, COALESCE(SUM(outcome = 'refused'), 0) AS r FROM attempts`)
      .get() as { a: number; p: number; r: number };
    return { attempts: r.a, paid: r.p, refused: r.r };
  }

  /** Latest attempts that touched the wallet, for the public feed. */
  feed(limit = 30): AttemptRow[] {
    return (
      this.db
        .prepare(
          `SELECT id, created_at, message, reply, outcome, amount, recipient, tx_hash, error FROM attempts
           WHERE outcome != 'talked' ORDER BY id DESC LIMIT ?`,
        )
        .all(limit) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as number,
      createdAt: r.created_at as string,
      message: r.message as string,
      reply: r.reply as string,
      outcome: r.outcome as Outcome,
      amount: r.amount as string | null,
      recipient: r.recipient as string | null,
      txHash: r.tx_hash as string | null,
      error: r.error as string | null,
    }));
  }
}
