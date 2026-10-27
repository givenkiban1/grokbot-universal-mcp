// Postgres access. Migrations in src/migrations run at startup, in order, each once.
import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.ts";

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
pool.on("error", (err) => console.error("postgres pool error:", err.message));

export type Queryable = Pick<pg.PoolClient, "query">;

export async function q<T extends pg.QueryResultRow = any>(sql: string, args: unknown[] = [], db: Queryable = pool): Promise<T[]> {
  return (await db.query<T>(sql, args)).rows;
}

export async function one<T extends pg.QueryResultRow = any>(sql: string, args: unknown[] = [], db: Queryable = pool): Promise<T | undefined> {
  return (await db.query<T>(sql, args)).rows[0];
}

export async function tx<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const MIGRATIONS_DIR = resolve(import.meta.dirname, "migrations");

// Never edit a migration once it has shipped; add a new numbered file instead.
export async function migrate(): Promise<void> {
  await tx(async (db) => {
    // Several app instances starting together: the first one migrates, the others wait.
    await db.query("SELECT pg_advisory_xact_lock(727274)");
    await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await q<{ name: string }>("SELECT name FROM schema_migrations", [], db)).map((r) => r.name));
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(file)) continue;
      await db.query(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
      await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      console.error(`migrated: ${file}`);
    }
  });
}
