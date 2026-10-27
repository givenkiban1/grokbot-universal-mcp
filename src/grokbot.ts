import { randomUUID } from "node:crypto";
import { type Bot } from "./config.ts";
import { recordMessage, type Sender } from "./store.ts";

export type { Sender } from "./store.ts";

const TIMEOUT_MS = 15_000;

export interface SendResult {
  thread_id: string;
  status: number;
  run_id?: string;
}

// Wakes the bot's webhook routine. The routine receives this JSON body as its input.
// A 200 means the run started, not that the bot finished. Every attempt is recorded, including failures.
export async function sendToBot(bot: Bot, message: string, from: Sender, threadId?: string): Promise<SendResult> {
  const thread_id = threadId ?? randomUUID();
  const sent_at = new Date().toISOString();
  const payload = { source: "claude", from, thread_id, message, sent_at };
  const record = (status: number, extra: { run_id?: string; error?: string }) =>
    safeRecord({ thread_id, bot: bot.name, direction: "to_bot", body: message, sender: from, status, created_at: sent_at, ...extra });

  let res: Response;
  try {
    res = await fetch(bot.webhook_url, {
      method: "POST",
      headers: { Authorization: `Bearer ${bot.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const error = `Could not reach ${bot.name}'s webhook: ${(err as Error).message}`;
    record(0, { error });
    throw new Error(error);
  }

  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = undefined; }

  if (!res.ok) {
    // GrokBot returns 400 when the routine is disabled and 401 for a bad key; the bodies differ in shape.
    const detail = body?.error ?? body?.message ?? text.slice(0, 300);
    record(res.status, { error: String(detail) });
    const hint =
      res.status === 401 ? " Check the key in bots.json." :
      res.status === 400 ? " Is the routine paused or disabled?" : "";
    throw new Error(`${bot.name}'s webhook returned HTTP ${res.status}: ${detail}.${hint}`);
  }
  record(res.status, { run_id: body?.runUuid });
  return { thread_id, status: res.status, run_id: body?.runUuid };
}

// The message already went out; a storage failure must not turn that into a reported failure (and a resend).
function safeRecord(m: Parameters<typeof recordMessage>[0]) {
  try {
    recordMessage(m);
  } catch (err) {
    console.error("grokbot: failed to record message:", err);
  }
}
