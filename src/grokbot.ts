// Both directions of the conversation:
// - sendToBot: Claude → bot. Wakes the bot's webhook routine; the payload carries a reply token for that thread.
// - receiveReply: bot → Claude. Stores the reply for Claude to pick up, and pings the user's notify URL if set.
import { config } from "./config.ts";
import { signThreadToken } from "./crypto.ts";
import { type Bot, webhookKey } from "./bots.ts";
import { addMessage, createThread, type ReplyState, type Thread } from "./threads.ts";
import { safePost } from "./net.ts";
import { notifyTarget } from "./users.ts";

const THREAD_TOKEN_TTL_S = 14 * 24 * 60 * 60;

export interface Sender {
  agent: "Claude";
  app: string;
  project?: string;
  about?: string;
}

export interface SendResult { thread_id: string; status: number; run_id?: string }

export function replyBlock(bot: Bot, threadId: string) {
  const token = signThreadToken({
    thread: threadId, bot: bot.id, epoch: bot.reply_epoch, exp: Math.floor(Date.now() / 1000) + THREAD_TOKEN_TTL_S,
  });
  return {
    url: `${config.PUBLIC_URL}/api/v1/replies`,
    token,
    expires_in_days: THREAD_TOKEN_TTL_S / 86400,
    how: `POST JSON {"message": "...", "state": "done"} to url with header "Authorization: Bearer <token>". ` +
      `state is one of working, done, needs_input, failed. Send "working" for progress updates and "done" with the result.`,
    mcp_url: `${config.PUBLIC_URL}/bot/mcp`,
  };
}

// A 2xx means the bot's run started, not that it finished. Every attempt is recorded, including failures.
export async function sendToBot(bot: Bot, message: string, from: Sender, thread?: Thread): Promise<SendResult> {
  const t = thread ?? await createThread(bot.user_id, bot.id, from.about ?? message.split("\n")[0]);
  const payload = {
    source: "claude",
    from,
    thread_id: t.id,
    message,
    sent_at: new Date().toISOString(),
    reply: replyBlock(bot, t.id),
  };
  const record = (status: number, extra: { run_id?: string; error?: string }) =>
    addMessage({ thread_id: t.id, user_id: bot.user_id, bot_id: bot.id, direction: "to_bot", body: message, sender: { ...from }, status, ...extra })
      .catch((err) => console.error("failed to record message:", err));

  let res;
  try {
    res = await safePost(bot.webhook_url, { Authorization: `Bearer ${await webhookKey(bot)}` }, payload);
  } catch (err) {
    const error = `Could not reach ${bot.name}'s webhook: ${(err as Error).message}`;
    await record(0, { error });
    throw new Error(error);
  }

  const text = (await res.text()).slice(0, 10_000);
  let body: any;
  try { body = JSON.parse(text); } catch { body = undefined; }

  if (res.status < 200 || res.status >= 300) {
    // GrokBot returns 400 when the routine is disabled and 401 for a bad key; the bodies differ in shape.
    const detail = String(body?.error ?? body?.message ?? (res.status >= 300 && res.status < 400 ? "redirects are not followed" : text.slice(0, 300)));
    await record(res.status, { error: detail });
    const hint =
      res.status === 401 ? " Check the bot's webhook key in the dashboard." :
      res.status === 400 ? " Is the routine paused or disabled?" : "";
    throw new Error(`${bot.name}'s webhook returned HTTP ${res.status}: ${detail}.${hint}`);
  }
  const runId = typeof body?.runUuid === "string" ? body.runUuid.slice(0, 100) : undefined;
  await record(res.status, { run_id: runId });
  return { thread_id: t.id, status: res.status, run_id: runId };
}

export const REPLY_MAX = 60_000;

export async function receiveReply(bot: Bot, threadId: string, message: string, state: ReplyState): Promise<string> {
  const id = await addMessage({ thread_id: threadId, user_id: bot.user_id, bot_id: bot.id, direction: "from_bot", body: message, state });
  notifyReply(bot, threadId, message, state);
  return id;
}

// Fire and forget: a slow or broken notify URL must not delay the bot's reply.
function notifyReply(bot: Bot, threadId: string, message: string, state: ReplyState) {
  (async () => {
    const target = await notifyTarget(bot.user_id);
    if (!target) return;
    await safePost(target.url, target.secret ? { Authorization: `Bearer ${target.secret}` } : {}, {
      event: "bot_reply",
      bot: bot.name,
      thread_id: threadId,
      state,
      preview: message.slice(0, 280),
      url: `${config.PUBLIC_URL}/threads/${threadId}`,
    });
  })().catch((err) => console.error(`notify for ${bot.name} failed:`, (err as Error).message));
}
