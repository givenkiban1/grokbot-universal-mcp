---
name: grokbot-delegation
description: Hand work to the user's GrokBot bots (cloud AI agents) through the grokbot MCP tools. Use when the user asks to send, delegate, hand off, brief or message a bot or GrokBot, mentions one of their bots by name, or asks a bot to research, monitor, draft or do something. Covers picking the right bot, writing a self-contained brief, confirming every send with the user, and continuing threads.
---

# Delegating to GrokBot

The user runs GrokBot bots: cloud AI agents, each set up for a kind of work. The `grokbot` MCP server lets you
wake a bot with a message (`send_to_grokbot`). The bot works on its own and **cannot see this conversation**.
Its answer does not come back through the tool.

Tools: `list_grokbots`, `send_to_grokbot`, `list_sent`.

## Workflow

1. **Know the bots.** Call `list_grokbots` once per conversation. Each bot has a description, `use for`,
   `not for`, and sometimes a ★ marking it as the default for the current project.
2. **Pick the bot.**
   - A clear match on `use for`, or a ★ project default with no `not for` conflict → pick it.
   - The user named a bot → use that one, but mention a `not for` conflict if there is one.
   - Two plausible bots, or none → ask the user. Never guess, and never send to a bot just because it's the
     only one.
3. **Write the brief** (template below).
4. **Confirm — every single time.** Show the confirmation card (below) and wait for an explicit yes. A yes
   covers that one message only. If the user changes anything, show the card again. "Send it to X" in the
   user's request is the go-ahead to draft, not to send unseen.
5. **Send** with `send_to_grokbot`: `bot`, `message`, a one-line `about`, `thread_id` for follow-ups, and
   `user_confirmed: true` once the user said yes. Some apps also show their own "Send?" dialog. That's expected,
   so let the user answer it.
6. **Report** in one or two lines: which bot, the `thread_id`, and that the bot is working on it now and will
   respond on its own channels (its answer won't appear here).

## Introducing yourself

The server automatically attaches who is sending: Claude, the app, the project folder and the machine. You don't
need to repeat that. Do open the brief with one line that gives the bot a reason to care, e.g.
"Claude here, working with the user on the AFS FY2026 close." Fill `about` with the same one-liner.

## Brief template

The bot starts from zero. Include whatever applies, and drop empty sections:

```
<one-line intro: Claude, what the user is working on>

Goal: <the outcome, in one or two sentences>
Context: <facts, links, file names, decisions already made; paste the essentials, the bot can't see the chat>
Deliverable: <what to produce, in what format, and where to put it or who to tell>
Constraints: <scope limits, things not to do, sources to use or avoid>
Deadline: <if any>
```

Keep it as short as the task allows. Prefer concrete details (names, numbers, URLs) to references like "the file
we discussed".

## Confirmation card

Show it exactly like this, then stop and wait:

> **Send to GrokBot → `research`** *(new thread)* or *(continuing thread 3f2a…)*
> Why this bot: matches "market research"; not the finance bot because this isn't about the AFS numbers.
>
> ```
> <the exact message>
> ```
> Send it?

## Follow-ups and threads

- Same task or a correction → reuse the `thread_id` from the earlier send.
- The earlier send was in another chat → `list_sent` (filter by bot) to find its `thread_id`. Confirm with the user
  that it's the right thread.
- A new, unrelated task → new thread (omit `thread_id`).

## Never

- Send without the user's yes for that exact message.
- Put passwords, API keys, tokens, card numbers or other secrets in a message. Point the bot at where it
  can find access instead, or ask the user.
- Promise the bot's answer will show up here, or poll for it.
- Send the same message twice because a send seemed slow. A success means it was delivered; on an error, report
  it and ask before retrying.

## Errors

| Tool says | Do |
|---|---|
| `HTTP 401 … Check the key` | Tell the user the bot's key in `bots.json` is wrong |
| `HTTP 400 … paused or disabled` | The routine is paused and the message was dropped. Ask the user to resume it, then offer to resend |
| `Unknown bot` | Show the configured bots and ask |
| `No bot config` | `bots.json` is missing in the grok-bot-universal folder |
| `Not sent. Confirmation is required` | You skipped step 4. Show the card and wait |
