// Entry point: migrate the database, then serve.
import { config } from "./config.ts";
import { migrate, pool, q } from "./db.ts";
import { createApp } from "./app.ts";

await migrate();

// Housekeeping: drop expired sessions, codes and pending OAuth requests.
async function prune() {
  await q("DELETE FROM sessions WHERE expires_at < now() OR last_seen_at < now() - interval '12 hours'");
  await q("DELETE FROM oauth_requests WHERE expires_at < now()");
  await q("DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 day'");
  await q("DELETE FROM oauth_tokens WHERE expires_at < now() - interval '7 days'");
}
prune().catch((err) => console.error("prune failed:", err.message));
setInterval(() => prune().catch((err) => console.error("prune failed:", err.message)), 60 * 60_000).unref();

const server = createApp().listen(config.PORT, config.HOST, () => {
  console.error(`grok-bot-universal listening on ${config.HOST}:${config.PORT}, public URL ${config.PUBLIC_URL}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.error(`${signal}: shutting down`);
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
