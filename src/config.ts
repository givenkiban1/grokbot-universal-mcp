// Server configuration, read once from the environment at startup. Fails fast on anything missing or malformed.
import { z } from "zod";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  // The URL people and Claude reach this server at, e.g. https://grokbot.example.com (no trailing path).
  PUBLIC_URL: z.url().transform((u) => u.replace(/\/+$/, "")),
  // 32 random bytes, base64. Encrypts webhook keys and TOTP secrets, and signs reply tokens. Back it up: without it
  // the stored keys can't be decrypted.
  ENCRYPTION_KEY: z.string().refine((k) => Buffer.from(k, "base64").length === 32, "must be 32 bytes, base64 (openssl rand -base64 32)"),
  PORT: z.coerce.number().int().default(8787),
  HOST: z.string().default("0.0.0.0"),
  // invite: an invite link is needed to sign up (default; admins create them). open: anyone can sign up.
  SIGNUP: z.enum(["invite", "open"]).default("invite"),
  // Express "trust proxy" setting. The default trusts loopback and private ranges, which covers a Docker network
  // with cloudflared or another reverse proxy in front.
  TRUST_PROXY: z.string().default("loopback, uniquelocal"),
  // Take the client IP from Cloudflare's CF-Connecting-IP header (only honoured from a trusted proxy).
  BEHIND_CLOUDFLARE: bool.default(false),
  // Comma-separated host patterns bot webhooks may point at, e.g. "api2.cursor.sh,*.example.com". Empty allows any
  // public HTTPS host.
  WEBHOOK_HOSTS: z.string().default(""),
  // Lets webhooks and notification URLs use http:// and private addresses. For local development and tests only.
  ALLOW_PRIVATE_WEBHOOKS: bool.default(false),
  // Hosts OAuth clients may redirect back to. The default covers Claude's web, desktop and mobile apps and the
  // local callback Claude Code uses. Stops anyone registering a look-alike app that sends codes elsewhere.
  OAUTH_REDIRECT_HOSTS: z.string().default("claude.ai,claude.com,localhost,127.0.0.1"),
});

export type Config = z.infer<typeof EnvSchema> & {
  secureCookies: boolean;
  mcpUrl: string;
  webhookHosts: string[];
  oauthRedirectHosts: string[];
};

function load(): Config {
  // An empty variable (e.g. FOO= in .env or compose) means "use the default".
  const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ""));
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    console.error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
    process.exit(1);
  }
  const data = parsed.data;
  return {
    ...data,
    secureCookies: data.PUBLIC_URL.startsWith("https://"),
    mcpUrl: `${data.PUBLIC_URL}/mcp`,
    webhookHosts: data.WEBHOOK_HOSTS.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
    oauthRedirectHosts: data.OAUTH_REDIRECT_HOSTS.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
  };
}

export const config = load();
