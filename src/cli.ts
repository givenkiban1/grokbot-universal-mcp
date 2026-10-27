// Admin commands, run on the server (in Docker: docker compose exec app node src/cli.ts <command>).
//   invite [--admin] [--days N] [--note TEXT]     print a one-time sign-up link (use --admin for the first account)
//   import --email EMAIL [--bots FILE] [--db FILE] import bots.json (and the old SQLite history) into an account
//   reset-2fa --email EMAIL                        turn off two-factor for someone who lost their device
//   disable --email EMAIL | enable --email EMAIL   lock or unlock an account (disabling signs out and revokes tokens)
import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { migrate, one, pool, q } from "./db.ts";
import { BotInput, createBot, getBotByName } from "./bots.ts";
import { addMessage } from "./threads.ts";
import { disableTotp, normalizeEmail, setDisabled } from "./users.ts";
import { createInvite } from "./web/admin.ts";
import { audit } from "./audit.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    admin: { type: "boolean", default: false },
    days: { type: "string", default: "7" },
    note: { type: "string", default: "" },
    email: { type: "string" },
    bots: { type: "string" },
    db: { type: "string" },
  },
});

async function userId(): Promise<string> {
  if (!values.email) throw new Error("--email is required");
  const row = await one<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1", [normalizeEmail(values.email)]);
  if (!row) throw new Error(`No user ${values.email}`);
  return row.id;
}

async function importData(uid: string) {
  if (values.bots) {
    const parsed = JSON.parse(readFileSync(values.bots, "utf8"));
    for (const b of parsed.bots ?? []) {
      if (await getBotByName(uid, b.name)) { console.log(`skip bot ${b.name}: already exists`); continue; }
      const input = BotInput.parse({ ...b, key: b.key });
      await createBot(uid, input);
      console.log(`imported bot ${b.name}`);
    }
  }
  if (values.db) {
    if (!existsSync(values.db)) throw new Error(`No file ${values.db}`);
    const old = new DatabaseSync(values.db, { readOnly: true });
    const rows = old.prepare("SELECT thread_id, bot, body, sender, status, run_id, error, created_at FROM messages ORDER BY id").all() as any[];
    const threadMap = new Map<string, string>();
    let n = 0;
    for (const r of rows) {
      const bot = await getBotByName(uid, r.bot);
      if (!bot) continue;
      let tid = threadMap.get(r.thread_id);
      if (!tid) {
        const sender = r.sender ? JSON.parse(r.sender) : {};
        const keep = z.uuid().safeParse(r.thread_id).success ? r.thread_id : null;
        tid = (await one<{ id: string }>(
          "INSERT INTO threads (id, user_id, bot_id, subject, created_at, updated_at) VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $5) ON CONFLICT (id) DO NOTHING RETURNING id",
          [keep, uid, bot.id, String(sender.about ?? r.body.split("\n")[0]).slice(0, 300), r.created_at]))?.id;
        if (!tid) continue;
        threadMap.set(r.thread_id, tid);
      }
      await addMessage({
        thread_id: tid, user_id: uid, bot_id: bot.id, direction: "to_bot", body: r.body,
        sender: r.sender ? JSON.parse(r.sender) : undefined, status: r.status ?? undefined, run_id: r.run_id ?? undefined, error: r.error ?? undefined,
      });
      await q("UPDATE messages SET created_at = $2 WHERE id = (SELECT max(id) FROM messages WHERE thread_id = $1)", [tid, r.created_at]);
      n++;
    }
    console.log(`imported ${n} messages in ${threadMap.size} threads`);
  }
}

try {
  await migrate();
  switch (positionals[0]) {
    case "invite": {
      const days = Math.min(30, Math.max(1, Number(values.days) || 7));
      console.log(await createInvite(null, { admin: values.admin!, days, note: values.note! }));
      console.log(`One-time link, valid ${days} day(s)${values.admin ? ", creates an admin account" : ""}.`);
      break;
    }
    case "import":
      await importData(await userId());
      break;
    case "reset-2fa": {
      const id = await userId();
      await disableTotp(id);
      await audit(id, "totp_reset_by_admin");
      console.log("Two-factor turned off. Ask them to set it up again.");
      break;
    }
    case "disable":
    case "enable": {
      const id = await userId();
      await setDisabled(id, positionals[0] === "disable");
      await audit(id, `account_${positionals[0]}d_by_admin`);
      console.log(`Account ${positionals[0]}d.`);
      break;
    }
    default:
      console.log("Commands: invite [--admin] [--days N] [--note TEXT] | import --email E [--bots FILE] [--db FILE] | reset-2fa --email E | disable --email E | enable --email E");
      process.exitCode = positionals[0] ? 1 : 0;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
