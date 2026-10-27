// Message history in SQLite (Node's built-in node:sqlite, no extra dependency).
// Several server processes can share the file at once (Claude Desktop and each Claude Code session
// start their own), so it runs in WAL mode with a busy timeout.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./config.ts";

const DATA_DIR = process.env.GROKBOT_DATA_DIR ?? resolve(ROOT, "data");

// Each entry upgrades the schema by one version; never edit an entry once shipped, append a new one.
const MIGRATIONS = [
  `
  CREATE TABLE threads (
    id         TEXT PRIMARY KEY,
    bot        TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id  TEXT NOT NULL REFERENCES threads(id),
    bot        TEXT NOT NULL,
    direction  TEXT NOT NULL CHECK (direction IN ('to_bot', 'from_bot')),
    body       TEXT NOT NULL,
    sender     TEXT,             -- JSON "from" block
    status     INTEGER,          -- webhook HTTP status; 0 when the request never got a response
    run_id     TEXT,
    error      TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_bot ON messages (bot, id);
  CREATE INDEX messages_thread ON messages (thread_id, id);
  `,
];

export interface Sender {
  agent: "Claude";
  app: string;
  project?: string;
  machine: string;
  about?: string;
}

export interface MessageRecord {
  thread_id: string;
  bot: string;
  direction: "to_bot" | "from_bot";
  body: string;
  sender?: Sender;
  status?: number;
  run_id?: string;
  error?: string;
  created_at: string;
}

let db: DatabaseSync | undefined;

function open(): DatabaseSync {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(resolve(DATA_DIR, "grokbot.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(d: DatabaseSync) {
  // BEGIN IMMEDIATE takes the write lock first, so two processes starting together don't both migrate.
  d.exec("BEGIN IMMEDIATE");
  try {
    const version = (d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    for (let v = version; v < MIGRATIONS.length; v++) {
      d.exec(MIGRATIONS[v]);
      d.exec(`PRAGMA user_version = ${v + 1}`);
    }
    if (version === 0) importJsonl(d);
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

// One-time import of the log format used before SQLite (data/sent.jsonl), kept afterwards as sent.jsonl.imported.
function importJsonl(d: DatabaseSync) {
  const file = resolve(DATA_DIR, "sent.jsonl");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    insert(d, {
      thread_id: e.thread_id,
      bot: e.bot,
      direction: "to_bot",
      body: e.message,
      sender: e.from,
      status: e.status,
      run_id: e.response?.runUuid,
      error: e.status >= 200 && e.status < 300 ? undefined : JSON.stringify(e.response ?? null),
      created_at: e.sent_at,
    });
  }
  renameSync(file, file + ".imported");
}

function insert(d: DatabaseSync, m: MessageRecord) {
  d.prepare(
    `INSERT INTO threads (id, bot, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at`,
  ).run(m.thread_id, m.bot, m.created_at, m.created_at);
  d.prepare(
    `INSERT INTO messages (thread_id, bot, direction, body, sender, status, run_id, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.thread_id, m.bot, m.direction, m.body,
    m.sender ? JSON.stringify(m.sender) : null,
    m.status ?? null, m.run_id ?? null, m.error ?? null, m.created_at,
  );
}

export function recordMessage(m: MessageRecord) {
  const d = open();
  d.exec("BEGIN IMMEDIATE");
  try {
    insert(d, m);
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

export function listMessages(opts: { limit: number; bot?: string; thread_id?: string }): MessageRecord[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.bot) { where.push("bot = ?"); args.push(opts.bot); }
  if (opts.thread_id) { where.push("thread_id = ?"); args.push(opts.thread_id); }
  const rows = open()
    .prepare(
      `SELECT thread_id, bot, direction, body, sender, status, run_id, error, created_at FROM messages
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`,
    )
    .all(...args, opts.limit) as any[];
  return rows.map((r) => ({
    ...r,
    sender: r.sender ? JSON.parse(r.sender) : undefined,
    status: r.status ?? undefined,
    run_id: r.run_id ?? undefined,
    error: r.error ?? undefined,
  }));
}
