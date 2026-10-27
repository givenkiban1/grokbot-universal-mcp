import { one, q, type Queryable } from "./db.ts";
import { decrypt, encrypt, hashPassword } from "./crypto.ts";

export interface User {
  id: string;
  email: string;
  is_admin: boolean;
  disabled_at: Date | null;
  totp_enabled: boolean;
  notify_url: string | null;
  created_at: Date;
}

const COLUMNS = "id, email, is_admin, disabled_at, totp_enabled, notify_url, created_at";

export const PASSWORD_MIN = 12;

export function passwordProblem(pw: string): string | undefined {
  if (pw.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (pw.length > 256) return "That password is too long.";
  return undefined;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function getUser(id: string): Promise<User | undefined> {
  return one(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
}

export function userForLogin(email: string): Promise<(User & { password_hash: string }) | undefined> {
  return one(`SELECT ${COLUMNS}, password_hash FROM users WHERE lower(email) = $1`, [normalizeEmail(email)]);
}

export async function createUser(email: string, password: string, isAdmin: boolean, db?: Queryable): Promise<User> {
  return (await one<User>(
    `INSERT INTO users (email, password_hash, is_admin) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
    [normalizeEmail(email), await hashPassword(password), isAdmin],
    db,
  ))!;
}

export async function setPassword(userId: string, password: string): Promise<void> {
  await q("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [userId, await hashPassword(password)]);
}

export function listUsers(): Promise<(User & { bots: number })[]> {
  return q(`SELECT ${COLUMNS.split(", ").map((c) => "u." + c).join(", ")}, (SELECT count(*)::int FROM bots WHERE user_id = u.id) AS bots
            FROM users u ORDER BY u.created_at`);
}

export async function setDisabled(userId: string, disabled: boolean): Promise<void> {
  await q("UPDATE users SET disabled_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now() WHERE id = $1", [userId, disabled]);
  if (disabled) await revokeEverything(userId);
}

// Signs the user out everywhere and cuts off every API and connector token.
export async function revokeEverything(userId: string, keepSessionHash?: string): Promise<void> {
  await q("DELETE FROM sessions WHERE user_id = $1 AND id_hash <> coalesce($2, '')", [userId, keepSessionHash ?? null]);
  await q("UPDATE api_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
  await q("UPDATE oauth_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
}

// ---- Two-factor ----

const totpAad = (userId: string) => `totp:${userId}`;

export async function startTotp(userId: string, secret: string): Promise<void> {
  await q("UPDATE users SET totp_secret_enc = $2, totp_enabled = false WHERE id = $1", [userId, encrypt(secret, totpAad(userId))]);
}

export async function totpState(userId: string): Promise<{ secret: string; enabled: boolean; lastStep: number | null } | undefined> {
  const row = await one<{ totp_secret_enc: string | null; totp_enabled: boolean; totp_last_step: string | null }>(
    "SELECT totp_secret_enc, totp_enabled, totp_last_step FROM users WHERE id = $1", [userId]);
  if (!row?.totp_secret_enc) return undefined;
  return {
    secret: decrypt(row.totp_secret_enc, totpAad(userId)),
    enabled: row.totp_enabled,
    lastStep: row.totp_last_step === null ? null : Number(row.totp_last_step),
  };
}

// Records the step that was just used. The WHERE clause makes a concurrent replay of the same code lose.
export async function useTotpStep(userId: string, step: number, enable = false): Promise<boolean> {
  const row = await one(
    `UPDATE users SET totp_last_step = $2, totp_enabled = totp_enabled OR $3
     WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id`,
    [userId, step, enable],
  );
  return row !== undefined;
}

export async function disableTotp(userId: string): Promise<void> {
  await q("UPDATE users SET totp_secret_enc = NULL, totp_enabled = false, totp_last_step = NULL WHERE id = $1", [userId]);
}

// ---- Reply notifications ----

const notifyAad = (userId: string) => `notify:${userId}`;

export async function setNotify(userId: string, url: string | null, secret: string | undefined): Promise<void> {
  if (!url) {
    await q("UPDATE users SET notify_url = NULL, notify_secret_enc = NULL WHERE id = $1", [userId]);
    return;
  }
  await q(
    "UPDATE users SET notify_url = $2, notify_secret_enc = CASE WHEN $3::text IS NULL THEN notify_secret_enc ELSE $3 END WHERE id = $1",
    [userId, url, secret === undefined ? null : secret === "" ? null : encrypt(secret, notifyAad(userId))],
  );
}

export async function notifyTarget(userId: string): Promise<{ url: string; secret?: string } | undefined> {
  const row = await one<{ notify_url: string | null; notify_secret_enc: string | null }>(
    "SELECT notify_url, notify_secret_enc FROM users WHERE id = $1 AND disabled_at IS NULL", [userId]);
  if (!row?.notify_url) return undefined;
  return { url: row.notify_url, secret: row.notify_secret_enc ? decrypt(row.notify_secret_enc, notifyAad(userId)) : undefined };
}
