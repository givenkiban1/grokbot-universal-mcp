// Security-relevant events per user, shown on the dashboard's Activity page.
import { q, type Queryable } from "./db.ts";

export async function audit(userId: string | null, event: string, detail: Record<string, unknown> = {}, ip?: string, db?: Queryable) {
  try {
    await q("INSERT INTO audit_log (user_id, event, detail, ip) VALUES ($1, $2, $3, $4)", [userId, event, detail, ip ?? null], db);
  } catch (err) {
    console.error("audit log write failed:", (err as Error).message);
  }
}

export interface AuditEntry { event: string; detail: Record<string, unknown>; ip: string | null; created_at: Date }

export function listAudit(userId: string, limit = 100): Promise<AuditEntry[]> {
  return q("SELECT event, detail, ip, created_at FROM audit_log WHERE user_id = $1 ORDER BY id DESC LIMIT $2", [userId, limit]);
}
