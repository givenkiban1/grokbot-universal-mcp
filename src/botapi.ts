// The bot-facing side: how a bot answers Claude.
//   REST  POST /api/v1/replies          {message, state?, thread_id?}
//         GET  /api/v1/threads/:id      the conversation so far
//   MCP   /bot/mcp                      tools reply_to_claude and get_thread, for bots that take MCP connectors
// Auth is a Bearer token, either the thread token sent with each message (answers that one thread only) or the
// bot's long-lived reply token from the dashboard (any of its threads, or a new one).
import express, { type NextFunction, type Request, type Response } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { verifyThreadToken, hashToken } from "./crypto.ts";
import { botById, botByReplyToken, type Bot } from "./bots.ts";
import { createThread, getThread, REPLY_STATES, threadMessages, type ReplyState, type Thread } from "./threads.ts";
import { receiveReply, REPLY_MAX } from "./grokbot.ts";
import { VERSION } from "./mcp.ts";

interface BotAuth { bot: Bot; thread?: Thread }

async function authenticate(header: string | undefined): Promise<BotAuth | undefined> {
  const token = /^Bearer (\S+)$/.exec(header ?? "")?.[1];
  if (!token) return undefined;
  if (token.startsWith("gbt_")) {
    const claim = verifyThreadToken(token);
    if (!claim) return undefined;
    const bot = await botById(claim.bot);
    if (!bot || bot.reply_epoch !== claim.epoch) return undefined;
    const thread = await getThread(bot.user_id, claim.thread);
    if (!thread || thread.bot_id !== bot.id) return undefined;
    return { bot, thread };
  }
  if (token.startsWith("gbr_")) {
    const bot = await botByReplyToken(token);
    return bot ? { bot } : undefined;
  }
  return undefined;
}

function requireBot(req: Request, res: Response, next: NextFunction) {
  authenticate(req.headers.authorization).then((auth) => {
    if (!auth) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized", message: "Missing, invalid or expired reply token" });
      return;
    }
    res.locals.botAuth = auth;
    next();
  }, next);
}

// Resolves which thread a reply goes to, enforcing what the token allows.
async function resolveThread(auth: BotAuth, threadId: string | undefined, firstLine: string): Promise<Thread | string> {
  if (auth.thread) {
    if (threadId && threadId !== auth.thread.id) return "This token can only reply on its own thread.";
    return auth.thread;
  }
  if (!threadId) return createThread(auth.bot.user_id, auth.bot.id, firstLine);
  const thread = await getThread(auth.bot.user_id, threadId);
  if (!thread || thread.bot_id !== auth.bot.id) return "No such thread for this bot.";
  return thread;
}

const ReplyBody = z.object({
  message: z.string().trim().min(1).max(REPLY_MAX),
  state: z.enum(REPLY_STATES).default("done"),
  thread_id: z.string().max(100).optional(),
});

function serializeThread(thread: Thread, messages: Awaited<ReturnType<typeof threadMessages>>) {
  return {
    thread_id: thread.id,
    subject: thread.subject,
    messages: messages.map((m) => ({
      from: m.direction === "to_bot" ? "claude" : "bot",
      body: m.body,
      state: m.state ?? undefined,
      about: m.direction === "to_bot" ? (m.sender as any)?.about : undefined,
      created_at: m.created_at,
    })),
  };
}

const limiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  // Per token when there is one, otherwise per client address.
  keyGenerator: (req) => (req.headers.authorization ? hashToken(req.headers.authorization) : ipKeyGenerator(req.ip ?? "")),
  message: { error: "rate_limited", message: "Too many requests; slow down." },
});

export function botApiRouter(): express.Router {
  const r = express.Router();
  // Per route, not r.use: this router is mounted at the root next to the dashboard.
  const guard: express.RequestHandler[] = [limiter, express.json({ limit: "256kb" }), requireBot];

  r.get("/api/v1/me", ...guard, (_req, res) => {
    const { bot, thread } = res.locals.botAuth as BotAuth;
    res.json({ bot: bot.name, thread_id: thread?.id, scope: thread ? "thread" : "bot" });
  });

  r.post("/api/v1/replies", ...guard, async (req, res) => {
    const parsed = ReplyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", message: z.prettifyError(parsed.error) });
      return;
    }
    const auth = res.locals.botAuth as BotAuth;
    const { message, state, thread_id } = parsed.data;
    const thread = await resolveThread(auth, thread_id, message.split("\n")[0]);
    if (typeof thread === "string") {
      res.status(403).json({ error: "forbidden", message: thread });
      return;
    }
    const id = await receiveReply(auth.bot, thread.id, message, state);
    res.status(201).json({ ok: true, message_id: id, thread_id: thread.id });
  });

  r.get("/api/v1/threads/:id", ...guard, async (req, res) => {
    const auth = res.locals.botAuth as BotAuth;
    const thread = await resolveThread(auth, req.params.id as string, "");
    if (typeof thread === "string") {
      res.status(404).json({ error: "not_found", message: thread });
      return;
    }
    res.json(serializeThread(thread, await threadMessages(auth.bot.user_id, thread.id, 200)));
  });

  // Stateless: a fresh server per request.
  r.post("/bot/mcp", ...guard, async (req, res) => {
    const server = botMcpServer(res.locals.botAuth as BotAuth);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  r.all("/bot/mcp", (_req, res) => { res.status(405).json({ error: "method not allowed" }); });

  return r;
}

function botMcpServer(auth: BotAuth): McpServer {
  const server = new McpServer(
    { name: "grok-bot-universal-replies", version: VERSION },
    {
      instructions:
        "Use reply_to_claude to answer a task Claude sent you. Pass the thread_id from the task. " +
        "Send state 'working' for progress updates, 'needs_input' when you need the user, and 'done' (or 'failed') at the end. " +
        "Never include secrets in a reply.",
    },
  );
  const text = (s: string, isError = false) => ({ content: [{ type: "text" as const, text: s }], isError });

  server.registerTool(
    "reply_to_claude",
    {
      title: "Reply to Claude",
      description: "Send a reply (or progress update) to Claude on a thread. Claude and the user see it in their inbox.",
      inputSchema: {
        message: z.string().min(1).max(REPLY_MAX),
        state: z.enum(REPLY_STATES).default("done").describe("working = progress update, done = final result, needs_input, failed"),
        thread_id: z.string().max(100).optional().describe("The thread_id from Claude's message; omit to start a new thread"),
      },
    },
    async ({ message, state, thread_id }) => {
      const thread = await resolveThread(auth, thread_id, message.split("\n")[0]);
      if (typeof thread === "string") return text(thread, true);
      await receiveReply(auth.bot, thread.id, message, state as ReplyState);
      return text(`Delivered to Claude on thread ${thread.id}.`);
    },
  );

  server.registerTool(
    "get_thread",
    {
      title: "Read a thread",
      description: "Read the conversation with Claude so far on a thread.",
      inputSchema: { thread_id: z.string().max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ thread_id }) => {
      if (!thread_id && !auth.thread) return text("Pass a thread_id.", true);
      const thread = await resolveThread(auth, thread_id ?? auth.thread!.id, "");
      if (typeof thread === "string") return text(thread, true);
      return text(JSON.stringify(serializeThread(thread, await threadMessages(auth.bot.user_id, thread.id, 200)), null, 2));
    },
  );

  return server;
}
