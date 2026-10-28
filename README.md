# grok-bot-universal

A self-hosted, two-way bridge between Claude and your GrokBot bots.

- **Claude → bot:** Claude briefs a bot (`send_to_grokbot`); the server wakes the bot's webhook routine.
- **Bot → Claude:** the bot answers into the same thread (one `curl`); Claude picks it up with `wait_for_reply`
  or `check_inbox`, and you can get a push notification.
- **Dashboard:** sign in, add bots and their webhook keys (kept encrypted on the server), connect Claude, read
  threads, manage tokens, 2FA and users.

It works in every Claude app: claude.ai, Desktop and mobile through a custom connector (OAuth sign-in), and Claude
Code through the same connector or an API token.

```
 Claude (web/desktop/mobile/Code)                       GrokBot bot
        │  MCP over HTTPS (OAuth or API token)              ▲   │
        ▼                                                   │   │ POST /api/v1/replies
 ┌──────────────── Cloudflare Tunnel ─────────────────┐     │   │ (thread token)
 │ app: /mcp  /authorize /token  /api/v1  dashboard   │─────┘   │
 │      webhook call with brief + reply token         │◀────────┘
 │ Postgres (internal network, no internet)           │
 └────────────────────────────────────────────────────┘
```

## Contents

| Piece | Where |
|---|---|
| Server (Express + MCP SDK, Node 24, runs the TypeScript directly) | `src/` |
| Database migrations | `src/migrations/` |
| Deployment | `Dockerfile`, `docker-compose.yml`, `.env.example`, `scripts/` |
| `grokbot-delegation` skill (how Claude briefs bots and handles replies) | `skills/grokbot-delegation/` |
| Routine instructions for the bots | shown per bot in the dashboard; reference copy in [`grokbot/routine-instructions.md`](grokbot/routine-instructions.md) |
| End-to-end test | `test/e2e.ts` |

## Deploy

You need a Linux server with Docker, and a domain on Cloudflare. The server needs no open inbound ports: the
Cloudflare Tunnel connects outwards.

1. **Cloudflare tunnel.** Zero Trust → Networks → Tunnels → Create a tunnel (Cloudflared). Copy the token from the
   Docker install command. Add a **public hostname**, e.g. `grokbot.example.com` → service `HTTP` → `app:8787`.
2. **Get the code onto the server** and create the environment file:
   ```bash
   ./scripts/init-env.sh https://grokbot.example.com
   ```
   Then edit `.env`: paste `CLOUDFLARE_TUNNEL_TOKEN`, and check `WEBHOOK_HOSTS` (defaults to `api2.cursor.sh`, where
   GrokBot webhooks live). **Save `ENCRYPTION_KEY` in your password manager**: backups can't be restored without it.
3. **Start it:**
   ```bash
   docker compose --profile tunnel up -d --build
   ```
4. **Create your admin account:**
   ```bash
   docker compose exec app node src/cli.ts invite --admin
   ```
   Open the printed link, sign up, then turn on two-factor under **Settings**.

Recommended Cloudflare settings: SSL/TLS **Full**, **Always Use HTTPS**, and a WAF rate-limiting rule on
`/login`. If you put Cloudflare Access in front of the dashboard, add Bypass rules for the paths machines call:
`/mcp`, `/api/*`, `/bot/*`, `/token`, `/register`, `/revoke`, `/.well-known/*` and `/health`.

### Updating

```bash
git pull && docker compose --profile tunnel up -d --build
```

Migrations run automatically at start-up.

### Backups

```bash
./scripts/backup.sh          # → backups/grokbot-<time>.sql.gz, keeps the newest 14
```

Run it from cron daily. A restore needs the dump **and** the `ENCRYPTION_KEY` from `.env`.

## Use

### 1. Add a bot

In GrokBot, open the bot and create a routine with a **Webhook** trigger. In the dashboard: **Bots → Add bot**, then
paste the webhook URL and key, and describe what the bot is for (`use for` / `not for` drive which bot Claude
picks; `projects` makes it the default for matching folders, `afs-*` style).

Then copy the bot's **Routine instructions** (on its page) into the routine. They tell the bot how to read Claude's
brief and how to reply.

### 2. Connect Claude

On **Connect Claude**:

- **claude.ai, Desktop, mobile:** Settings → Connectors → Add custom connector → paste `https://<host>/mcp` →
  Connect → sign in and approve. It then works in all your Claude apps.
- **Claude Code:** create an API token and run the command the page shows:
  ```bash
  claude mcp add --transport http --scope user grokbot https://grokbot.example.com/mcp --header "Authorization: Bearer gbp_…"
  ```
  The `grokbot-delegation` skill is linked into `~/.claude/skills`. For Desktop/claude.ai chats, upload
  `dist/grokbot-delegation.zip` under Settings → Capabilities → Skills (rebuild it after editing the skill:
  `cd skills && rm -f ../dist/grokbot-delegation.zip && zip -qr ../dist/grokbot-delegation.zip grokbot-delegation`).

### 3. Talk to bots

Ask Claude: "have the research bot compare these three vendors and wait for the answer". Claude picks the bot, shows
you the brief, sends it only after your yes, and waits for the reply. Later: "any replies from my bots?".

### MCP tools

| Tool | What it does |
|---|---|
| `list_grokbots` | Bots with use for / not for, ★ project default, ✉ unread replies |
| `send_to_grokbot` | `bot`, `message`, `about`, `project`, `thread_id`, `user_confirmed`. Every send needs your confirmation |
| `wait_for_reply` | Waits up to `timeout_seconds` (≤ 300) for a reply on a thread |
| `check_inbox` | Unread replies (all bots or one), marks them read |
| `get_thread` | A whole conversation |
| `list_threads` | Recent threads with unread counts |

Confirmation: in apps that support MCP dialogs (Claude Code), the server asks you directly; elsewhere the tool
refuses unless Claude passes `user_confirmed: true`, which the rules and skill only allow after your explicit yes.

### What the bot receives

```json
{
  "source": "claude",
  "from": { "agent": "Claude", "app": "Claude Code", "project": "grok-bot-universal", "about": "…" },
  "thread_id": "…",
  "message": "…",
  "sent_at": "2026-10-27T18:30:00.000Z",
  "reply": { "url": "https://<host>/api/v1/replies", "token": "gbt_…", "expires_in_days": 14, "how": "…", "mcp_url": "https://<host>/bot/mcp" }
}
```

The bot replies with `POST reply.url` `{"message": "…", "state": "done" | "working" | "needs_input" | "failed"}` and
`Authorization: Bearer <reply.token>`. See [`grokbot/routine-instructions.md`](grokbot/routine-instructions.md) for
the long-lived bot token and the bot MCP endpoint.

### Reply notifications

Settings → Reply notifications: an HTTPS URL that gets
`{"event":"bot_reply","bot","thread_id","state","preview","url"}` whenever a bot replies (ntfy, a Slack/Discord
relay, a Claude routine trigger, …), with an optional bearer secret.

## Security

| Area | How |
|---|---|
| Accounts | Invite-only sign-up by default; scrypt passwords (12+ chars); optional TOTP 2FA with replay protection; per-IP and per-account login throttling |
| Sessions | Random token in an `HttpOnly`, `SameSite=Lax`, `Secure` `__Host-` cookie; only its hash is stored; 7-day lifetime, 12-hour idle timeout; new token at login and after 2FA |
| CSRF / clickjacking | Per-session CSRF token on every form, same-origin check on every POST, strict CSP with no inline script, `frame-ancestors 'none'` |
| Secrets at rest | Bot webhook keys, TOTP seeds, notify secrets and OAuth client secrets are AES-256-GCM encrypted, each bound to its owner row. API, reply, OAuth and session tokens are stored only as SHA-256 hashes and shown once |
| Claude access | OAuth 2.1 with PKCE, dynamic registration limited to Claude's redirect hosts, single-use 5-minute codes, 1-hour access tokens, rotating 30-day refresh tokens with reuse detection; or revocable, expiring API tokens. MCP sessions are bound to their user |
| Bot access | Per-thread reply tokens (HMAC-signed, 14 days, one thread only) or a long-lived per-bot token; rotating it invalidates all thread tokens |
| Isolation | Every query is scoped to the signed-in user; the test suite checks cross-user access |
| Outbound requests | Webhook and notify URLs must be HTTPS, may be limited to `WEBHOOK_HOSTS`, and can't reach private, loopback or metadata addresses (checked on the resolved IP, so DNS rebinding doesn't help); no redirects; 15 s timeout |
| Outgoing messages | Messages containing keys, tokens or private keys (including your own bot keys) are refused and logged |
| Prompt injection | Bot replies reach Claude fenced and labelled as untrusted; the server rules and skill tell Claude never to act on instructions in them |
| Abuse | Rate limits on login, sign-up, OAuth registration, MCP and the reply API; DNS-rebinding host check; request size limits |
| Containers | App runs as non-root, read-only filesystem, all capabilities dropped; Postgres has no network route out; nothing listens publicly (Cloudflare Tunnel) |
| Audit | Sign-ins, failures, token, bot and 2FA changes, blocked sends: **Activity** page |

## Admin CLI

Run on the server (`docker compose exec app node src/cli.ts …`):

| Command | Does |
|---|---|
| `invite [--admin] [--days N] [--note TEXT]` | One-time sign-up link |
| `import --email E --bots bots.json [--db data/grokbot.db]` | Import bots (and old local history) into an account |
| `reset-2fa --email E` | Turn off 2FA for someone who lost their device |
| `disable --email E` / `enable --email E` | Lock/unlock an account (disabling revokes all its sessions and tokens) |

Admins can also create invites and disable users under **Admin** in the dashboard.

## Configuration

| Variable | Default | |
|---|---|---|
| `PUBLIC_URL` | required | The address people and Claude use, e.g. `https://grokbot.example.com` |
| `ENCRYPTION_KEY` | required | 32 bytes base64 (`openssl rand -base64 32`) |
| `DATABASE_URL` | set by compose | Postgres connection string |
| `SIGNUP` | `invite` | `open` lets anyone who reaches the server sign up |
| `WEBHOOK_HOSTS` | any public host | Comma-separated allowlist, `*.example.com` supported |
| `BEHIND_CLOUDFLARE` | `false` | Use `CF-Connecting-IP` as the client IP (only from a proxy on the private network) |
| `TRUST_PROXY` | `loopback, uniquelocal` | Express trust-proxy setting |
| `OAUTH_REDIRECT_HOSTS` | `claude.ai,claude.com,localhost,127.0.0.1` | Where OAuth clients may redirect |
| `ALLOW_PRIVATE_WEBHOOKS` | `false` | Development only: allow `http://` and private webhook addresses |

## Migrating from the local version

Version 0.2 (tag `v0.2-local`) ran on your Mac over stdio with `bots.json` and SQLite. After deploying:

```bash
# on the server, in this folder, after copying bots.json and data/grokbot.db over (and signing up)
docker compose run --rm -v "$PWD/bots.json:/import/bots.json:ro" -v "$PWD/data:/import/data:ro" app \
  node src/cli.ts import --email you@example.com --bots /import/bots.json --db /import/data/grokbot.db
```

Then point Claude Code at the server (`claude mcp remove grokbot --scope user`, then the `claude mcp add` command
from **Connect Claude**), remove the `grokbot` entry from Claude Desktop's `claude_desktop_config.json`, and add the
custom connector instead. Delete the local `bots.json` once imported: its keys are now encrypted on the server.

## Development

```bash
docker run -d --name grokbot-testdb -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:17-alpine
npm install
npm run typecheck
TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test
```

The test creates and drops its own database, runs the server against a fake GrokBot webhook, and drives the
dashboard, Claude's MCP (API token, OAuth, confirmation dialog) and the bot reply API.

To run locally: `DATABASE_URL=… PUBLIC_URL=http://127.0.0.1:8787 ENCRYPTION_KEY=… npm start`.

## Troubleshooting

| Symptom | Meaning |
|---|---|
| `HTTP 401 … webhook key` | Wrong key saved for the bot; re-enter it on the bot's page |
| `HTTP 400 … paused or disabled` | The routine is paused. GrokBot drops (doesn't queue) messages sent while paused |
| `Not sent. Confirmation is required` | Claude tried to send without your yes; it should show you the message first |
| `Not sent: the message appears to contain …` | The secret blocker caught a key or token in the brief |
| Bot's reply gets `401` | The thread token expired (14 days) or the bot's reply token was rotated |
| `421 Misdirected request` | `PUBLIC_URL` doesn't match the hostname you're using |
| Connector won't connect | Check `PUBLIC_URL` is the exact public `https://` address, and the tunnel's public hostname points to `app:8787` |

## License

[MIT](LICENSE)
