// Hosted entry point: Streamable HTTP at POST /mcp, for running on a server behind HTTPS.
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./mcp.ts";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const TOKEN = process.env.MCP_AUTH_TOKEN;

if (!TOKEN && HOST !== "127.0.0.1" && HOST !== "localhost") {
  console.error("Refusing to listen on a public interface without MCP_AUTH_TOKEN set.");
  process.exit(1);
}

function authorized(header: string | undefined): boolean {
  if (!TOKEN) return true;
  const given = Buffer.from(header?.replace(/^Bearer /, "") ?? "");
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => { res.json({ ok: true }); });

// Stateless: a fresh server and transport per request, so it scales and restarts cleanly.
// That rules out the confirmation dialog (its reply would land on a different instance), so sends
// rely on Claude asking the user and passing user_confirmed.
app.post("/mcp", async (req, res) => {
  if (!authorized(req.headers.authorization)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const server = createServer({ elicit: false, defaultApp: "Claude (remote connector)" });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("mcp request failed:", err);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  }
});

app.all("/mcp", (_req, res) => { res.status(405).json({ error: "method not allowed" }); });

app.listen(PORT, HOST, () => {
  console.error(`grok-bot-universal: MCP over HTTP at http://${HOST}:${PORT}/mcp${TOKEN ? " (token required)" : ""}`);
});
