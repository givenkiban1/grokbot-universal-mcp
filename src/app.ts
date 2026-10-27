// Assembles the HTTP app:
//   /mcp                 Claude's MCP endpoint (OAuth access token or personal API token)
//   /authorize, /token, /register, /revoke, /.well-known/*   OAuth for Claude's connectors (MCP SDK)
//   /api/v1/*, /bot/mcp  how bots reply (reply tokens)
//   everything else      the dashboard (browser session)
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "./config.ts";
import { createMcpServer } from "./mcp.ts";
import { oauthProvider, SCOPE } from "./oauth.ts";
import { botApiRouter } from "./botapi.ts";
import { isPrivateAddress } from "./net.ts";
import { authRouter } from "./web/auth.ts";
import { dashboardRouter } from "./web/dashboard.ts";
import { adminRouter } from "./web/admin.ts";
import { csrfProtect, loadSession } from "./web/session.ts";
import { html, layout } from "./web/html.ts";

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
  "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'",
].join("; ");

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (config.secureCookies) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}

// Requests must name our own host. Stops DNS-rebinding attacks from a browser on the same network.
const publicHost = new URL(config.PUBLIC_URL).host.toLowerCase();
function hostCheck(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/health") return next();
  if ((req.headers.host ?? "").toLowerCase() !== publicHost) {
    res.status(421).send("Misdirected request");
    return;
  }
  next();
}

// Behind Cloudflare the real client IP is in CF-Connecting-IP. Only believe it from a proxy on our own network.
function cloudflareIp(req: Request, _res: Response, next: NextFunction) {
  const peer = req.socket.remoteAddress ?? "";
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && isIP(cf) && isPrivateAddress(peer)) {
    Object.defineProperty(req, "ip", { value: cf, configurable: true });
  }
  next();
}

// ---- MCP sessions ----
// Stateful so the server can ask the user to confirm a send through the client's own dialog (elicitation).
// Each session is bound to the user who opened it; a request with another user's token can't use it.
interface McpSession { transport: StreamableHTTPServerTransport; server: McpServer; userId: string; lastSeen: number }
const sessions = new Map<string, McpSession>();
const SESSION_IDLE_MS = 60 * 60_000;
const MAX_SESSIONS_PER_USER = 50;

setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, s] of sessions) if (s.lastSeen < cutoff) { sessions.delete(id); s.transport.close().catch(() => {}); }
}, 5 * 60_000).unref();

function rpcError(res: Response, status: number, message: string) {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

async function handleMcp(req: Request, res: Response) {
  const userId = req.auth?.extra?.userId as string | undefined;
  if (!userId) return rpcError(res, 401, "Unauthorized");
  const sid = req.headers["mcp-session-id"];
  if (typeof sid === "string") {
    const s = sessions.get(sid);
    if (!s || s.userId !== userId) return rpcError(res, 404, "Session not found");
    s.lastSeen = Date.now();
    await s.transport.handleRequest(req, res, req.body);
    return;
  }
  if (req.method !== "POST" || !isInitializeRequest(req.body)) return rpcError(res, 400, "No session; send initialize first");
  if ([...sessions.values()].filter((s) => s.userId === userId).length >= MAX_SESSIONS_PER_USER) {
    return rpcError(res, 429, "Too many open sessions");
  }
  const server = createMcpServer({ userId, ip: req.ip });
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => { sessions.set(id, { transport, server, userId, lastSeen: Date.now() }); },
    onsessionclosed: (id) => { sessions.delete(id); },
  });
  transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY);
  if (config.BEHIND_CLOUDFLARE) app.use(cloudflareIp);
  app.use(securityHeaders);

  app.get("/health", (_req, res) => { res.json({ ok: true }); });
  app.use(hostCheck);
  app.use("/static", express.static(resolve(import.meta.dirname, "web/static"), { maxAge: "1h", index: false }));

  // OAuth authorization server + protected-resource metadata for /mcp.
  app.use(mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: new URL(config.PUBLIC_URL),
    resourceServerUrl: new URL(config.mcpUrl),
    scopesSupported: [SCOPE],
    resourceName: "GrokBot",
    clientRegistrationOptions: { clientSecretExpirySeconds: 0, rateLimit: { windowMs: 60 * 60_000, limit: 20 } },
  }));

  const bearer = requireBearerAuth({
    verifier: oauthProvider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(config.mcpUrl)),
    expectedResource: new URL(config.mcpUrl),
  });
  const mcpLimit = rateLimit({
    windowMs: 60_000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false,
    keyGenerator: (req) => String(req.auth?.extra?.userId),
    message: { jsonrpc: "2.0", error: { code: -32000, message: "Rate limited" }, id: null },
  });
  const mcpJson = express.json({ limit: "1mb" });
  app.post("/mcp", bearer, mcpLimit, mcpJson, handleMcp);
  app.get("/mcp", bearer, mcpLimit, handleMcp);
  app.delete("/mcp", bearer, mcpLimit, handleMcp);

  app.use(botApiRouter());

  // Dashboard
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));
  app.use(loadSession, csrfProtect);
  app.use(authRouter());
  app.use(adminRouter());
  app.use(dashboardRouter());

  app.use((_req, res) => { res.status(404).send(layout({ title: "Not found", narrow: true, body: html`<h1>Not found</h1>` })); });
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error(`${req.method} ${req.path} failed:`, err);
    if (res.headersSent) return;
    if (req.path.startsWith("/api/") || req.path.endsWith("/mcp")) {
      res.status(status).json({ error: status >= 500 ? "internal_error" : "bad_request" });
      return;
    }
    res.status(status).send(layout({ title: "Error", narrow: true, body: html`<h1>Something went wrong</h1><p>Please try again.</p>` }));
  });
  return app;
}
