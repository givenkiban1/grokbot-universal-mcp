# grok-bot-universal

An MCP server that lets Claude send messages to your GrokBot bots.

**Direction for now: Claude → GrokBot only.** Claude calls `send_to_grokbot`, and the server POSTs to the bot's
webhook routine, which wakes the bot with your message. The bot's answer does not come back through this server yet
(see [Later](#later)).

## What's in the box

| Piece | Where | Works in |
|---|---|---|
| MCP server (tools + standing rules) | `src/` | Every Claude app that connects to it |
| `grokbot-delegation` skill (how to brief a bot well) | `skills/grokbot-delegation/` | Claude Code (installed); Desktop/claude.ai via upload |
| GrokBot routine instructions | [`grokbot/routine-instructions.md`](grokbot/routine-instructions.md) | Paste into each bot's webhook routine |

### Tools

| Tool | What it does |
|---|---|
| `list_grokbots` | Lists your bots with what each is for and not for, and marks ★ the default for the current project |
| `send_to_grokbot` | `bot`, `message`, optional `about`, `project`, `thread_id`. Wakes the bot. **Every send must be confirmed** |
| `list_sent` | Recent sends (optionally per `bot` or `thread_id`) with delivery status, to continue a thread from another chat |

### Standing rules

The server sends these to every Claude app on connect:
- Pick the bot from its `use_for` / `not_for` / `projects`, and ask the user when unsure.
- Always confirm before every send.
- Write a brief the bot can follow without seeing the chat.
- Never send secrets.

### Confirmation on every send

Every send is confirmed in one of two ways:
- **Apps that support MCP confirmation dialogs** (elicitation): the server itself shows a "Send to *bot*?" dialog
  with the message. Nothing goes out unless you tick Send. Claude can't skip this.
- **Other apps, and the hosted HTTP mode:** the tool refuses to send unless Claude passes `user_confirmed: true`.
  The rules and the skill require Claude to show you the exact message and wait for your yes first.

### What the bot receives

```json
{
  "source": "claude",
  "from": { "agent": "Claude", "app": "Claude Code", "project": "grok-bot-universal", "machine": "givens-macbook-pro", "about": "…" },
  "thread_id": "…",
  "message": "…",
  "sent_at": "2026-10-27T18:30:00.000Z"
}
```

`from` is filled in automatically:
- **app:** from the connecting client.
- **project:** from the folder Claude Code runs in, or from Claude when it passes `project`.
- **about:** a one-liner Claude writes.

A success only means the routine started. It does not mean the bot finished.

## Setup

### 1. In GrokBot (once per bot)

1. Open the bot and create a routine with a **Webhook** trigger.
2. Paste the instruction from [`grokbot/routine-instructions.md`](grokbot/routine-instructions.md) and fill in the
   bot's specialty.
3. Copy the routine's **webhook URL** and **key** (`crsr_…`).

### 2. In this folder

Edit `bots.json` (gitignored, so your keys stay out of git). See [`bots.example.json`](bots.example.json):

```json
{
  "bots": [
    {
      "name": "research",
      "description": "Research bot: digs into topics and writes summaries",
      "use_for": ["market and competitor research", "tool and vendor comparisons"],
      "not_for": ["writing or changing code"],
      "projects": [],
      "webhook_url": "https://api2.cursor.sh/automations/webhook/…",
      "key": "crsr_…"
    }
  ]
}
```

- `name`: lowercase; it's what you call the bot in Claude.
- `use_for` / `not_for`: what Claude matches your task against. Be specific.
- `projects`: folder names this bot is the default for. A trailing `*` matches a prefix, e.g. `"afs-*"`.

Changes apply on the next call, with no restart.

### 3. Connect Claude

**Claude Code**: registered for all projects as `grokbot` (`claude mcp get grokbot`). The skill is installed at
`~/.claude/skills/grokbot-delegation`, a link to `skills/grokbot-delegation`, so edits here apply immediately.

**Claude Desktop**: `grokbot` is in `~/Library/Application Support/Claude/claude_desktop_config.json`, and a
backup of the previous config sits next to it as `.bak-grokbot`. Quit and reopen Desktop to load changes. For the
skill in Desktop chats, upload `dist/grokbot-delegation.zip` under Settings → Capabilities → Skills. If you edit
the skill, rebuild the zip:

```bash
cd skills && rm -f ../dist/grokbot-delegation.zip && zip -qr ../dist/grokbot-delegation.zip grokbot-delegation
```

**Claude web and mobile**: these can't reach your Mac, so they need the hosted version (below). Uploaded skills
sync to them from your account.

> The node path in both registrations is your nvm Node 24. If you remove that version, update the path (needs
> Node ≥ 22.18, which runs `.ts` directly). If you move this folder, both registrations need the new path.

## Run modes

| Command | Use |
|---|---|
| `npm start` | stdio (what Claude Code and Desktop launch automatically; you don't run this yourself) |
| `npm run start:http` | Streamable HTTP at `http://127.0.0.1:8787/mcp`, used for hosting |
| `npm test` | End-to-end test against a fake GrokBot webhook (stdio, confirmation dialog, HTTP, SQLite incl. parallel writers) |

### Storage

Every send attempt, successful or not, is stored in SQLite at `data/grokbot.db`. This uses Node's built-in
`node:sqlite`, so there's no extra dependency. `data/` is gitignored, and keys are never stored.

| Table | Columns |
|---|---|
| `threads` | `id`, `bot`, `created_at`, `updated_at` |
| `messages` | `thread_id`, `bot`, `direction` (`to_bot`; `from_bot` reserved for replies), `body`, `sender` (the `from` JSON), `status` (HTTP; 0 = no response), `run_id`, `error`, `created_at` |

- WAL mode lets Claude Desktop and several Claude Code sessions (each runs its own server process) write at once.
- Schema changes are numbered migrations tracked in `PRAGMA user_version` (`src/store.ts`).
- A `data/sent.jsonl` from before the switch is imported once and renamed `sent.jsonl.imported`.
- To back it up, copy `data/grokbot.db` while no Claude app is running, or use `sqlite3 data/grokbot.db ".backup backup.db"`.

`list_sent` reads from it. Filter by `bot` or `thread_id`.

HTTP mode environment variables: `PORT` (8787), `HOST` (127.0.0.1), and `MCP_AUTH_TOKEN`. When set, clients must
send `Authorization: Bearer <token>`. The server refuses to bind a public interface without a token.

## Later

- **Hosting**: run `npm run start:http` on your server behind HTTPS (Caddy, nginx, or Tailscale Funnel), with
  `HOST=0.0.0.0` and `MCP_AUTH_TOKEN` set. Then add `https://your-host/mcp` as a custom connector in Claude.
  HTTP mode is stateless, so the server-side confirmation dialog is off there and the `user_confirmed` rule
  applies. Switching to stateful sessions would bring the dialog back.
- **Replies (GrokBot → Claude)**: add an inbox to this server and give GrokBot tools such as `reply_to_claude` via
  an MCP connector, and/or have GrokBot fire a Claude Code routine through its API trigger. The `thread_id` sent
  today is what ties replies to conversations.

## Troubleshooting

| Error | Meaning |
|---|---|
| `HTTP 401 … Check the key` | Wrong `key` in `bots.json` |
| `HTTP 400 … paused or disabled` | The routine is paused. GrokBot drops (doesn't queue) messages sent while paused |
| `No bot config at …` | `bots.json` is missing |
| `Not sent. Confirmation is required` | Claude tried to send without your yes; it should show you the message first |
