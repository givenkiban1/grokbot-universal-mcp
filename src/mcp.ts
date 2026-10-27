import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { basename } from "node:path";
import { homedir, hostname } from "node:os";
import { z } from "zod";
import { loadBots, matchesProject, type Bot } from "./config.ts";
import { sendToBot, type Sender } from "./grokbot.ts";
import { listMessages } from "./store.ts";

export interface ServerOptions {
  // Ask the user through the client's own confirmation dialog (MCP elicitation). Needs a client
  // that supports it and a transport that can carry the round trip, so the stateless HTTP mode turns it off.
  elicit: boolean;
  // Folder the client launched us in; only meaningful for stdio.
  cwd?: string;
  // App label when the client's name is unknown (stateless HTTP never sees the initialize handshake).
  defaultApp?: string;
}

// Loaded by every MCP client on connect, so these rules apply in Claude Code, Desktop, web and mobile alike.
const INSTRUCTIONS = `
This server sends messages from Claude to the user's GrokBot bots (AI agents that run in the cloud).

Rules for sending:
1. Always call list_grokbots first in a conversation, and pick the bot whose purpose (use_for / not_for / projects) fits the task.
   If more than one bot could fit, or none clearly does, ask the user which one. Never guess.
2. Always confirm before every send, with no exceptions. Show the user the bot name, why you chose it, and the exact message,
   then wait for an explicit yes. A yes covers that one message only. If the user edits the message, show it again.
3. The bot cannot see this conversation. Write a self-contained brief: the goal, the context it needs, what to deliver
   and in what form, and any constraints or deadline.
4. Never include passwords, API keys, tokens or other secrets in a message.
5. For a follow-up on earlier work, reuse its thread_id (from the send result, or list_sent if it came from another chat).
6. A successful send only means the bot started. Its answer does not come back through this tool, so don't wait for one.
`.trim();

const APP_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude-ai": "Claude app (desktop/web/mobile)",
};

function text(s: string, isError = false) {
  return { content: [{ type: "text" as const, text: s }], isError };
}

function projectFromCwd(cwd: string | undefined): string | undefined {
  if (!cwd || cwd === "/" || cwd === homedir()) return undefined;
  return basename(cwd);
}

function describeBot(b: Bot, project: string | undefined): string {
  const lines = [`- ${b.name}${b.description ? `: ${b.description}` : ""}`];
  if (b.use_for.length) lines.push(`    use for: ${b.use_for.join("; ")}`);
  if (b.not_for.length) lines.push(`    not for: ${b.not_for.join("; ")}`);
  if (b.projects.length) lines.push(`    default for projects: ${b.projects.join(", ")}`);
  if (matchesProject(b, project)) lines.push(`    ★ default for the current project (${project})`);
  return lines.join("\n");
}

export function createServer(opts: ServerOptions): McpServer {
  const server = new McpServer({ name: "grok-bot-universal", version: "0.2.0" }, { instructions: INSTRUCTIONS });
  const cwdProject = projectFromCwd(opts.cwd);

  // Returns "yes"/"no" when the user answered a client dialog, or "unavailable" when we have to rely on Claude asking.
  async function askUser(bot: Bot, message: string, threadId: string | undefined): Promise<"yes" | "no" | "unavailable"> {
    if (!opts.elicit || !server.server.getClientCapabilities()?.elicitation) return "unavailable";
    const preview = message.length > 1500 ? message.slice(0, 1500) + "\n…" : message;
    try {
      const r = await server.server.elicitInput(
        {
          mode: "form",
          message: `Send this to GrokBot "${bot.name}"${threadId ? ` (thread ${threadId})` : ""}?\n\n${preview}`,
          requestedSchema: {
            type: "object",
            properties: { send: { type: "boolean", title: `Send to ${bot.name}`, default: false } },
            required: ["send"],
          },
        },
        { timeout: 10 * 60_000 },
      );
      return r.action === "accept" && r.content?.send === true ? "yes" : "no";
    } catch (err) {
      console.error("grokbot: confirmation dialog failed, falling back:", (err as Error).message);
      return "unavailable";
    }
  }

  server.registerTool(
    "list_grokbots",
    {
      title: "List GrokBot bots",
      description: "List the user's GrokBot bots with what each is for and not for. Call this before choosing a bot.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const bots = loadBots();
        if (bots.length === 0) return text("No bots configured in bots.json.");
        const header = cwdProject ? `Current project: ${cwdProject}\n\n` : "";
        return text(header + bots.map((b) => describeBot(b, cwdProject)).join("\n"));
      } catch (err) {
        return text((err as Error).message, true);
      }
    },
  );

  server.registerTool(
    "send_to_grokbot",
    {
      title: "Send a message to a GrokBot bot",
      description:
        "Send a message to one of the user's GrokBot bots by triggering its webhook routine. " +
        "BEFORE calling: show the user the bot, why you chose it, and the exact message, and get an explicit yes for this send. " +
        "Claude's identity and the current app/project are attached automatically. " +
        "Success means the bot started working; its answer is not returned. Reuse thread_id for follow-ups.",
      inputSchema: {
        bot: z.string().describe("Bot name from list_grokbots"),
        message: z.string().min(1).max(60_000).describe("Self-contained brief for the bot: goal, context, deliverable, constraints"),
        about: z.string().max(300).optional().describe("One line on what the user is working on, so the bot has context"),
        project: z.string().max(100).optional().describe("Project or folder name, if known and not already detected"),
        thread_id: z.string().optional().describe("Reuse to continue an earlier conversation"),
        user_confirmed: z.boolean().optional().describe(
          "Set true only if the user explicitly approved this exact message in the conversation just now",
        ),
      },
      annotations: { openWorldHint: true, destructiveHint: false },
    },
    async ({ bot, message, about, project, thread_id, user_confirmed }) => {
      try {
        const bots = loadBots();
        const target = bots.find((b) => b.name === bot.toLowerCase());
        if (!target) {
          return text(`Unknown bot "${bot}". Configured bots: ${bots.map((b) => b.name).join(", ") || "none"}.`, true);
        }

        const answer = await askUser(target, message, thread_id);
        if (answer === "no") return text(`Not sent: the user declined sending this to ${target.name}.`);
        if (answer === "unavailable" && user_confirmed !== true) {
          return text(
            `Not sent. Confirmation is required for every send. Show the user the bot (${target.name}), ` +
              "why you chose it, and the exact message, wait for an explicit yes, then call again with user_confirmed: true.",
            true,
          );
        }

        const client = server.server.getClientVersion()?.name;
        const from: Sender = {
          agent: "Claude",
          app: (client && APP_NAMES[client]) ?? client ?? opts.defaultApp ?? "unknown",
          project: project ?? cwdProject,
          machine: hostname(),
          about,
        };
        const r = await sendToBot(target, message, from, thread_id);
        return text(
          `Sent to ${target.name}. The bot's routine has started; its answer won't come back here.\n` +
            `thread_id: ${r.thread_id}` + (r.run_id ? `\nrun_id: ${r.run_id}` : ""),
        );
      } catch (err) {
        return text((err as Error).message, true);
      }
    },
  );

  server.registerTool(
    "list_sent",
    {
      title: "List messages sent to GrokBot",
      description:
        "Show recent messages sent to GrokBot bots, newest first, with their thread_ids and whether delivery worked. " +
        "Use it to continue a thread started in another chat, or pass thread_id to see one conversation.",
      inputSchema: {
        bot: z.string().optional().describe("Only this bot"),
        thread_id: z.string().optional().describe("Only this conversation"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ bot, thread_id, limit }) => {
      try {
        const entries = listMessages({ limit, bot: bot?.toLowerCase(), thread_id });
        if (entries.length === 0) return text("Nothing sent yet.");
        return text(
          entries
            .map((e) => {
              const snippet = e.body.replace(/\s+/g, " ").slice(0, 120);
              const ok = e.status && e.status >= 200 && e.status < 300;
              const outcome = ok ? "" : ` (failed${e.status ? `, HTTP ${e.status}` : ""}: ${e.error ?? "unknown error"})`;
              return `- ${e.created_at}  ${e.bot}  thread ${e.thread_id}${outcome}\n    ${snippet}${e.body.length > 120 ? "…" : ""}`;
            })
            .join("\n"),
        );
      } catch (err) {
        return text(`Could not read the message history: ${(err as Error).message}`, true);
      }
    },
  );

  return server;
}
