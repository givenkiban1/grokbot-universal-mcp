// End-to-end check against a fake GrokBot webhook. Runs both entry points (stdio and HTTP).
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const ROOT = resolve(import.meta.dirname, "..");
const received: any[] = [];

const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.headers.authorization !== "Bearer crsr_good") {
      res.writeHead(401).end(JSON.stringify({ code: "error", message: "Invalid API key" }));
      return;
    }
    if (req.url?.endsWith("/paused")) {
      res.writeHead(400).end(JSON.stringify({ success: false, error: "Automation paused is disabled" }));
      return;
    }
    received.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, runUuid: "run-123" }));
  });
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(fake.address() as any).port}/automations/webhook`;

const dir = mkdtempSync(join(tmpdir(), "grokbot-test-"));
const configPath = join(dir, "bots.json");
writeFileSync(configPath, JSON.stringify({ bots: [
  { name: "research", description: "test bot", use_for: ["market research"], not_for: ["code"], projects: ["grok-*"], webhook_url: `${base}/r1`, key: "crsr_good" },
  { name: "badkey", webhook_url: `${base}/r2`, key: "crsr_wrong" },
  { name: "paused", webhook_url: `${base}/paused`, key: "crsr_good" },
] }));
const env = { ...process.env, GROKBOT_CONFIG: configPath, GROKBOT_DATA_DIR: dir } as Record<string, string>;

const send = (client: Client, args: object) => client.callTool({ name: "send_to_grokbot", arguments: args }) as Promise<any>;

// Client without a confirmation dialog: Claude must pass user_confirmed.
async function exercise(client: Client, label: string) {
  assert.match(client.getInstructions() ?? "", /Always confirm before every send/);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["list_grokbots", "list_sent", "send_to_grokbot"]);

  const list = await client.callTool({ name: "list_grokbots", arguments: {} }) as any;
  assert.match(list.content[0].text, /research: test bot\n    use for: market research\n    not for: code/);

  const before = received.length;
  const blocked = await send(client, { bot: "research", message: "unconfirmed" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /Not sent\. Confirmation is required/);
  assert.equal(received.length, before, "unconfirmed message must not reach the bot");

  const sent = await send(client, { bot: "research", message: `hello from ${label}`, about: "testing", user_confirmed: true });
  assert.equal(sent.isError, false, sent.content[0].text);
  assert.match(sent.content[0].text, /run_id: run-123/);
  assert.equal(received.length, before + 1);
  const got = received.at(-1);
  assert.equal(got.message, `hello from ${label}`);
  assert.deepEqual({ agent: got.from.agent, app: got.from.app, about: got.from.about }, { agent: "Claude", app: label === "http" ? "Claude (remote connector)" : "smoke", about: "testing" });
  const threadId = got.thread_id;

  await send(client, { bot: "research", message: "follow-up", thread_id: threadId, user_confirmed: true });
  assert.equal(received.at(-1).thread_id, threadId);

  const bad = await send(client, { bot: "badkey", message: "x", user_confirmed: true });
  assert.match(bad.content[0].text, /HTTP 401.*Check the key/);
  const paused = await send(client, { bot: "paused", message: "x", user_confirmed: true });
  assert.match(paused.content[0].text, /HTTP 400.*paused or disabled/);
  const unknown = await send(client, { bot: "nope", message: "x", user_confirmed: true });
  assert.match(unknown.content[0].text, /Unknown bot "nope"/);

  const history = await client.callTool({ name: "list_sent", arguments: { bot: "research", limit: 2 } }) as any;
  assert.match(history.content[0].text, new RegExp(`research  thread ${threadId}\\n    follow-up`));
  const thread = await client.callTool({ name: "list_sent", arguments: { thread_id: threadId } }) as any;
  assert.equal(thread.content[0].text.split("\n- ").length, 2, "thread filter returns both messages");
  const failed = await client.callTool({ name: "list_sent", arguments: { bot: "badkey", limit: 1 } }) as any;
  assert.match(failed.content[0].text, /\(failed, HTTP 401: Invalid API key\)/);
  console.log(`ok - ${label}`);
}

// stdio
const stdio = new Client({ name: "smoke", version: "0" });
await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "src/stdio.ts")], env, stderr: "ignore" }));
await exercise(stdio, "stdio");
await stdio.close();

// stdio with a client that shows a confirmation dialog: the user's answer decides, and the project is detected from cwd.
let answer: "yes" | "no" = "yes";
const dialog = new Client({ name: "claude-code", version: "0" }, { capabilities: { elicitation: {} } });
dialog.setRequestHandler(ElicitRequestSchema, async (req) => {
  assert.match(req.params.message, /Send this to GrokBot "research"/);
  return answer === "yes" ? { action: "accept", content: { send: true } } : { action: "decline" };
});
await dialog.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "src/stdio.ts")], env, cwd: ROOT, stderr: "ignore" }));
const listed = await dialog.callTool({ name: "list_grokbots", arguments: {} }) as any;
assert.match(listed.content[0].text, /★ default for the current project \(grok-bot-universal\)/);
let before = received.length;
const accepted = await send(dialog, { bot: "research", message: "via dialog" });
assert.equal(accepted.isError, false, accepted.content[0].text);
assert.equal(received.length, before + 1);
assert.deepEqual({ app: received.at(-1).from.app, project: received.at(-1).from.project }, { app: "Claude Code", project: "grok-bot-universal" });
answer = "no";
before = received.length;
const declined = await send(dialog, { bot: "research", message: "declined", user_confirmed: true });
assert.match(declined.content[0].text, /Not sent: the user declined/);
assert.equal(received.length, before, "declined message must not reach the bot");
await dialog.close();
console.log("ok - stdio confirmation dialog");

// http, with token
const port = 18787;
const proc = spawn(process.execPath, [join(ROOT, "src/http.ts")], { env: { ...env, PORT: String(port), MCP_AUTH_TOKEN: "secret" }, stdio: ["ignore", "ignore", "pipe"] });
await new Promise<void>((r) => proc.stderr!.on("data", (d) => String(d).includes("MCP over HTTP") && r()));
try {
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const denied = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(denied.status, 401);
  const http = new Client({ name: "smoke", version: "0" });
  await http.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer secret" } } }));
  await exercise(http, "http");
  await http.close();
} finally {
  proc.kill();
  fake.close();
}

// Storage: every attempt recorded, failures with their error, threads linked.
const db = new DatabaseSync(join(dir, "grokbot.db"));
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
assert.equal(count("SELECT count(*) n FROM messages"), 9);
assert.equal(count("SELECT count(*) n FROM messages WHERE status = 200"), 5);
assert.equal(count("SELECT count(*) n FROM messages WHERE status <> 200 AND error IS NOT NULL"), 4);
assert.equal(count("SELECT count(*) n FROM messages m LEFT JOIN threads t ON t.id = m.thread_id WHERE t.id IS NULL"), 0);
assert.equal((db.prepare("PRAGMA user_version").get() as any).user_version, 1);
db.close();
console.log("ok - 9 sends stored in SQLite");

// Concurrency: two server processes writing to the same database at once.
const clients = await Promise.all([1, 2].map(async () => {
  const c = new Client({ name: "smoke", version: "0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "src/stdio.ts")], env, stderr: "ignore" }));
  return c;
}));
await Promise.all(clients.flatMap((c, i) =>
  Array.from({ length: 10 }, (_, j) => send(c, { bot: "research", message: `parallel ${i}-${j}`, user_confirmed: true })),
));
await Promise.all(clients.map((c) => c.close()));
const db2 = new DatabaseSync(join(dir, "grokbot.db"));
assert.equal((db2.prepare("SELECT count(*) n FROM messages WHERE body LIKE 'parallel %'").get() as any).n, 20);
db2.close();
console.log("ok - 20 parallel sends from 2 processes");

// One-time import of the old sent.jsonl log.
const legacy = mkdtempSync(join(tmpdir(), "grokbot-legacy-"));
writeFileSync(join(legacy, "sent.jsonl"), JSON.stringify({ source: "claude", thread_id: "old-thread", message: "from the old log", sent_at: "2026-10-27T10:00:00.000Z", bot: "research", status: 200, response: { success: true, runUuid: "run-old" } }) + "\n");
const importer = new Client({ name: "smoke", version: "0" });
await importer.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "src/stdio.ts")], env: { ...env, GROKBOT_DATA_DIR: legacy }, stderr: "ignore" }));
const imported = await importer.callTool({ name: "list_sent", arguments: {} }) as any;
assert.match(imported.content[0].text, /research  thread old-thread\n    from the old log/);
await importer.close();
assert.ok(existsSync(join(legacy, "sent.jsonl.imported")) && !existsSync(join(legacy, "sent.jsonl")));
console.log("ok - legacy sent.jsonl imported");
