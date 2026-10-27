// Conversations between Claude and a bot. Each thread belongs to one user and one bot; every lookup is scoped by
// both, so one user's token can never read or post to another user's thread.
import { z } from "zod";
import { one, q, type Queryable } from "./db.ts";

export type ReplyState = "working" | "done" | "needs_input" | "failed";
export const REPLY_STATES = ["working", "done", "needs_input", "failed"] as const;

export interface Thread { id: string; user_id: string; bot_id: string; subject: string; created_at: Date; updated_at: Date }

export interface Message {
  id: string;
  thread_id: string;
  bot_id: string;
  bot: string;
  direction: "to_bot" | "from_bot";
  body: string;
  sender: Record<string, unknown> | null;
  status: number | null;
  run_id: string | null;
  error: string | null;
  state: ReplyState | null;
  read_at: Date | null;
  created_at: Date;
}

const MSG = `m.id, m.thread_id, m.bot_id, b.name AS bot, m.direction, m.body, m.sender, m.status, m.run_id, m.error,
  m.state, m.read_at, m.created_at`;

const isUuid = (s: string) => z.uuid().safeParse(s).success;

export function getThread(userId: string, id: string): Promise<Thread | undefined> {
  if (!isUuid(id)) return Promise.resolve(undefined);
  return one("SELECT * FROM threads WHERE user_id = $1 AND id = $2", [userId, id]);
}

export async function createThread(userId: string, botId: string, subject: string, db?: Queryable): Promise<Thread> {
  return (await one<Thread>(
    "INSERT INTO threads (user_id, bot_id, subject) VALUES ($1, $2, $3) RETURNING *", [userId, botId, subject.slice(0, 300)], db))!;
}

export interface NewMessage {
  thread_id: string;
  user_id: string;
  bot_id: string;
  direction: "to_bot" | "from_bot";
  body: string;
  sender?: Record<string, unknown>;
  status?: number;
  run_id?: string;
  error?: string;
  state?: ReplyState;
}

export async function addMessage(m: NewMessage, db?: Queryable): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO messages (thread_id, user_id, bot_id, direction, body, sender, status, run_id, error, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [m.thread_id, m.user_id, m.bot_id, m.direction, m.body, m.sender ?? null, m.status ?? null, m.run_id ?? null,
      m.error ?? null, m.state ?? null],
    db,
  );
  await q("UPDATE threads SET updated_at = now() WHERE id = $1", [m.thread_id], db);
  return row!.id;
}

export function threadMessages(userId: string, threadId: string, limit = 100): Promise<Message[]> {
  return q(
    `SELECT * FROM (SELECT ${MSG} FROM messages m JOIN bots b ON b.id = m.bot_id
       WHERE m.user_id = $1 AND m.thread_id = $2 ORDER BY m.id DESC LIMIT $3) t ORDER BY id`,
    [userId, threadId, limit],
  );
}

export function unreadReplies(userId: string, opts: { botId?: string; threadId?: string; limit: number }): Promise<Message[]> {
  return q(
    `SELECT ${MSG} FROM messages m JOIN bots b ON b.id = m.bot_id
     WHERE m.user_id = $1 AND m.direction = 'from_bot' AND m.read_at IS NULL
       AND ($2::uuid IS NULL OR m.bot_id = $2) AND ($3::uuid IS NULL OR m.thread_id = $3)
     ORDER BY m.id LIMIT $4`,
    [userId, opts.botId ?? null, opts.threadId ?? null, opts.limit],
  );
}

export async function markRead(userId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await q("UPDATE messages SET read_at = now() WHERE user_id = $1 AND id = ANY($2::bigint[]) AND read_at IS NULL", [userId, ids]);
}

export async function unreadCounts(userId: string): Promise<Map<string, number>> {
  const rows = await q<{ bot_id: string; n: number }>(
    `SELECT bot_id, count(*)::int AS n FROM messages WHERE user_id = $1 AND direction = 'from_bot' AND read_at IS NULL GROUP BY bot_id`,
    [userId],
  );
  return new Map(rows.map((r) => [r.bot_id, r.n]));
}

export interface ThreadSummary extends Thread {
  bot: string;
  messages: number;
  unread: number;
  last_body: string | null;
  last_direction: "to_bot" | "from_bot" | null;
  last_state: ReplyState | null;
}

export function listThreads(userId: string, opts: { botId?: string; limit: number; offset?: number }): Promise<ThreadSummary[]> {
  return q(
    `SELECT t.*, b.name AS bot,
       (SELECT count(*)::int FROM messages WHERE thread_id = t.id) AS messages,
       (SELECT count(*)::int FROM messages WHERE thread_id = t.id AND direction = 'from_bot' AND read_at IS NULL) AS unread,
       l.body AS last_body, l.direction AS last_direction, l.state AS last_state
     FROM threads t JOIN bots b ON b.id = t.bot_id
     LEFT JOIN LATERAL (SELECT body, direction, state FROM messages WHERE thread_id = t.id ORDER BY id DESC LIMIT 1) l ON true
     WHERE t.user_id = $1 AND ($2::uuid IS NULL OR t.bot_id = $2)
     ORDER BY t.updated_at DESC LIMIT $3 OFFSET $4`,
    [userId, opts.botId ?? null, opts.limit, opts.offset ?? 0],
  );
}

// Waits for an unread bot reply on a thread, checking every 1.5 s, until the timeout or the caller gives up.
export async function waitForReply(userId: string, threadId: string, timeoutMs: number, signal?: AbortSignal): Promise<Message[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await unreadReplies(userId, { threadId, limit: 20 });
    if (found.length || Date.now() >= deadline || signal?.aborted) return found;
    await new Promise((r) => setTimeout(r, Math.min(1500, Math.max(0, deadline - Date.now()))));
  }
}
