// A user's bots. The webhook key is encrypted at rest and only decrypted to call the webhook; it is never shown again
// after it's saved. The reply token (for the bot to answer Claude) is stored as a hash.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { one, q, type Queryable } from "./db.ts";
import { decrypt, encrypt, hashToken, newToken, tokenPrefix } from "./crypto.ts";
import { checkOutboundUrl } from "./net.ts";

export interface Bot {
  id: string;
  user_id: string;
  name: string;
  description: string;
  use_for: string[];
  not_for: string[];
  projects: string[];
  webhook_url: string;
  reply_token_prefix: string | null;
  reply_epoch: number;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = "id, user_id, name, description, use_for, not_for, projects, webhook_url, reply_token_prefix, reply_epoch, created_at, updated_at";

const list = z.array(z.string().trim().min(1).max(200)).max(30);

export const BotInput = z.object({
  name: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Use lowercase letters, numbers, - or _ (max 40)."),
  description: z.string().trim().max(500).default(""),
  use_for: list.default([]),
  not_for: list.default([]),
  // Folder names this bot is the default for; a trailing * matches a prefix (e.g. "afs-*").
  projects: list.default([]),
  webhook_url: z.string().trim().max(2000).superRefine((u, ctx) => {
    const problem = checkOutboundUrl(u);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  }),
  // Optional on update: blank keeps the stored key.
  key: z.string().trim().max(500).optional(),
});
export type BotInput = z.infer<typeof BotInput>;

const aad = (bot: { id: string; user_id: string }) => `bot-key:${bot.user_id}:${bot.id}`;

export function listBots(userId: string): Promise<Bot[]> {
  return q(`SELECT ${COLUMNS} FROM bots WHERE user_id = $1 ORDER BY name`, [userId]);
}

export function getBot(userId: string, id: string): Promise<Bot | undefined> {
  if (!z.uuid().safeParse(id).success) return Promise.resolve(undefined);
  return one(`SELECT ${COLUMNS} FROM bots WHERE user_id = $1 AND id = $2`, [userId, id]);
}

export function getBotByName(userId: string, name: string): Promise<Bot | undefined> {
  return one(`SELECT ${COLUMNS} FROM bots WHERE user_id = $1 AND name = $2`, [userId, name.trim().toLowerCase()]);
}

export async function createBot(userId: string, input: BotInput): Promise<Bot> {
  if (!input.key) throw new Error("The webhook key is required.");
  const id = randomUUID();
  return (await one<Bot>(
    `INSERT INTO bots (id, user_id, name, description, use_for, not_for, projects, webhook_url, webhook_key_enc)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
    [id, userId, input.name, input.description, input.use_for, input.not_for, input.projects, input.webhook_url,
      encrypt(input.key, aad({ id, user_id: userId }))],
  ))!;
}

export async function updateBot(bot: Bot, input: BotInput): Promise<Bot> {
  return (await one<Bot>(
    `UPDATE bots SET name = $3, description = $4, use_for = $5, not_for = $6, projects = $7, webhook_url = $8,
       webhook_key_enc = COALESCE($9, webhook_key_enc), updated_at = now()
     WHERE user_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [bot.user_id, bot.id, input.name, input.description, input.use_for, input.not_for, input.projects, input.webhook_url,
      input.key ? encrypt(input.key, aad(bot)) : null],
  ))!;
}

export async function deleteBot(bot: Bot): Promise<void> {
  await q("DELETE FROM bots WHERE user_id = $1 AND id = $2", [bot.user_id, bot.id]);
}

export async function webhookKey(bot: Bot, db?: Queryable): Promise<string> {
  const row = await one<{ webhook_key_enc: string }>("SELECT webhook_key_enc FROM bots WHERE id = $1", [bot.id], db);
  return decrypt(row!.webhook_key_enc, aad(bot));
}

// All of a user's webhook keys, so an outgoing message can be checked for them.
export async function allWebhookKeys(userId: string): Promise<string[]> {
  const rows = await q<{ id: string; user_id: string; webhook_key_enc: string }>(
    "SELECT id, user_id, webhook_key_enc FROM bots WHERE user_id = $1", [userId]);
  return rows.map((r) => decrypt(r.webhook_key_enc, aad(r)));
}

// Issues a new long-lived reply token (shown once) and invalidates the old one and every thread reply token.
export async function rotateReplyToken(bot: Bot): Promise<string> {
  const token = newToken("gbr");
  await q(
    "UPDATE bots SET reply_token_hash = $3, reply_token_prefix = $4, reply_epoch = reply_epoch + 1, updated_at = now() WHERE user_id = $1 AND id = $2",
    [bot.user_id, bot.id, hashToken(token), tokenPrefix(token)],
  );
  return token;
}

export async function revokeReplyToken(bot: Bot): Promise<void> {
  await q(
    "UPDATE bots SET reply_token_hash = NULL, reply_token_prefix = NULL, reply_epoch = reply_epoch + 1, updated_at = now() WHERE user_id = $1 AND id = $2",
    [bot.user_id, bot.id],
  );
}

export function botByReplyToken(token: string): Promise<Bot | undefined> {
  return one(
    `SELECT ${COLUMNS.split(", ").map((c) => "b." + c).join(", ")} FROM bots b JOIN users u ON u.id = b.user_id
     WHERE b.reply_token_hash = $1 AND u.disabled_at IS NULL`,
    [hashToken(token)],
  );
}

export function botById(id: string): Promise<Bot | undefined> {
  return one(
    `SELECT ${COLUMNS.split(", ").map((c) => "b." + c).join(", ")} FROM bots b JOIN users u ON u.id = b.user_id
     WHERE b.id = $1 AND u.disabled_at IS NULL`,
    [id],
  );
}

export function matchesProject(bot: Bot, project: string | undefined): boolean {
  if (!project) return false;
  return bot.projects.some((p) => (p.endsWith("*") ? project.startsWith(p.slice(0, -1)) : project === p));
}
