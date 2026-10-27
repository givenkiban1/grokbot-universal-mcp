// Personal API tokens: how Claude Code (and anything else that can send a header) connects to /mcp.
import { one, q } from "./db.ts";
import { hashToken, newToken, tokenPrefix } from "./crypto.ts";

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

export async function createApiToken(userId: string, name: string, days: number | null): Promise<{ token: string; row: ApiToken }> {
  const token = newToken("gbp");
  const row = (await one<ApiToken>(
    `INSERT INTO api_tokens (user_id, name, token_hash, prefix, expires_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(days => $5::int) END)
     RETURNING id, name, prefix, expires_at, last_used_at, revoked_at, created_at`,
    [userId, name.slice(0, 100), hashToken(token), tokenPrefix(token), days],
  ))!;
  return { token, row };
}

export function listApiTokens(userId: string): Promise<ApiToken[]> {
  return q(
    `SELECT id, name, prefix, expires_at, last_used_at, revoked_at, created_at FROM api_tokens
     WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC`,
    [userId],
  );
}

export async function revokeApiToken(userId: string, id: string): Promise<boolean> {
  const row = await one("UPDATE api_tokens SET revoked_at = now() WHERE user_id = $1 AND id::text = $2 AND revoked_at IS NULL RETURNING id", [userId, id]);
  return row !== undefined;
}

export async function userForApiToken(token: string): Promise<{ user_id: string; token_id: string; expires_at: Date | null } | undefined> {
  const row = await one<{ user_id: string; token_id: string; expires_at: Date | null }>(
    `SELECT t.user_id, t.id AS token_id, t.expires_at FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()) AND u.disabled_at IS NULL`,
    [hashToken(token)],
  );
  if (row) {
    // Coarse last-used stamp; no need to write on every request.
    q("UPDATE api_tokens SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')",
      [row.token_id]).catch(() => {});
  }
  return row;
}
