import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export const ROOT = resolve(import.meta.dirname, "..");

const BotSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "use lowercase letters, numbers, - or _"),
  description: z.string().default(""),
  // Routing hints Claude uses to pick the right bot.
  use_for: z.array(z.string()).default([]),
  not_for: z.array(z.string()).default([]),
  // Folder names this bot is the default for; a trailing * matches a prefix (e.g. "afs-*").
  projects: z.array(z.string()).default([]),
  webhook_url: z.url(),
  key: z.string().min(1),
});
export type Bot = z.infer<typeof BotSchema>;

const ConfigSchema = z.object({ bots: z.array(BotSchema) });

export function configPath(): string {
  return process.env.GROKBOT_CONFIG ?? resolve(ROOT, "bots.json");
}

// Re-read on every call so editing bots.json takes effect without a restart.
export function loadBots(): Bot[] {
  const path = configPath();
  if (!existsSync(path)) {
    throw new Error(`No bot config at ${path}. Copy bots.example.json to bots.json and add your bot's webhook URL and key.`);
  }
  const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(`Invalid ${path}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data.bots;
}

export function matchesProject(bot: Bot, project: string | undefined): boolean {
  if (!project) return false;
  return bot.projects.some((p) => (p.endsWith("*") ? project.startsWith(p.slice(0, -1)) : project === p));
}
