// Browser sessions for the dashboard.
// - The cookie holds a random token; the database stores only its hash, so a database leak can't be replayed.
// - Cookies are HttpOnly, SameSite=Lax, and Secure with the __Host- prefix when served over HTTPS.
// - Every state-changing form carries a per-session CSRF token, and POSTs must come from our own origin.
// - Sessions last 7 days, or 12 hours without use. Logging in issues a new session (no fixation).
import type { NextFunction, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { config } from "../config.ts";
import { one, q } from "../db.ts";
import { hashToken, newToken, safeEqual } from "../crypto.ts";
import { getUser, type User } from "../users.ts";

const COOKIE = config.secureCookies ? "__Host-gb_session" : "gb_session";
const MAX_AGE_S = 7 * 24 * 60 * 60;
const IDLE_S = 12 * 60 * 60;

export interface SessionInfo { idHash: string; csrf: string; mfaPending: boolean; user: User }

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function setCookie(res: Response, value: string, maxAge: number) {
  const attrs = [`${COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (config.secureCookies) attrs.push("Secure");
  res.append("Set-Cookie", attrs.join("; "));
}

export async function startSession(req: Request, res: Response, userId: string, mfaPending: boolean): Promise<void> {
  const old = readCookie(req, COOKIE);
  if (old) await q("DELETE FROM sessions WHERE id_hash = $1", [hashToken(old)]);
  const token = newToken("gbs");
  await q(
    `INSERT INTO sessions (id_hash, user_id, csrf, mfa_pending, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
    [hashToken(token), userId, randomBytes(24).toString("base64url"), mfaPending, req.ip ?? null,
      (req.headers["user-agent"] ?? "").slice(0, 300), mfaPending ? 600 : MAX_AGE_S],
  );
  setCookie(res, token, mfaPending ? 600 : MAX_AGE_S);
}

export async function upgradeSession(req: Request, res: Response, userId: string): Promise<void> {
  // A fresh token once the second factor is in, rather than flipping a flag on the pre-MFA one.
  await startSession(req, res, userId, false);
}

export async function endSession(req: Request, res: Response): Promise<void> {
  const token = readCookie(req, COOKIE);
  if (token) await q("DELETE FROM sessions WHERE id_hash = $1", [hashToken(token)]);
  setCookie(res, "", 0);
}

// Loads the session (if any) into res.locals.session. Doesn't require one.
export async function loadSession(req: Request, res: Response, next: NextFunction) {
  const token = readCookie(req, COOKIE);
  if (token) {
    const idHash = hashToken(token);
    const row = await one<{ user_id: string; csrf: string; mfa_pending: boolean; last_seen_at: Date }>(
      `SELECT user_id, csrf, mfa_pending, last_seen_at FROM sessions
       WHERE id_hash = $1 AND expires_at > now() AND last_seen_at > now() - make_interval(secs => $2)`,
      [idHash, IDLE_S],
    );
    const user = row && await getUser(row.user_id);
    if (row && user && !user.disabled_at) {
      res.locals.session = { idHash, csrf: row.csrf, mfaPending: row.mfa_pending, user } satisfies SessionInfo;
      if (Date.now() - row.last_seen_at.getTime() > 60_000) {
        q("UPDATE sessions SET last_seen_at = now() WHERE id_hash = $1", [idHash]).catch(() => {});
      }
    }
  }
  next();
}

export function currentSession(res: Response): SessionInfo | undefined {
  const s = res.locals.session as SessionInfo | undefined;
  return s && !s.mfaPending ? s : undefined;
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (currentSession(res)) return next();
  const back = req.method === "GET" ? `?next=${encodeURIComponent(req.originalUrl)}` : "";
  res.redirect(303, `/login${back}`);
}

export function requireAdmin(_req: Request, res: Response, next: NextFunction) {
  if (currentSession(res)?.user.is_admin) return next();
  res.status(404).send("Not found");
}

// POSTs must come from our own pages: same Origin (or Referer), and the session's CSRF token when signed in.
export function csrfProtect(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "POST") return next();
  let origin = req.headers.origin;
  if (!origin && req.headers.referer) {
    try { origin = new URL(req.headers.referer).origin; } catch { origin = undefined; }
  }
  if (origin !== new URL(config.PUBLIC_URL).origin) {
    res.status(403).send("Cross-site request refused.");
    return;
  }
  // Sign-in and sign-up forms are posted before there's a (full) session; the origin check covers them.
  const s = res.locals.session as SessionInfo | undefined;
  if (s && req.path !== "/login" && req.path !== "/signup") {
    const given = typeof req.body?._csrf === "string" ? req.body._csrf : "";
    if (!safeEqual(given, s.csrf)) {
      res.status(403).send("Your session changed. Go back, reload the page and try again.");
      return;
    }
  }
  next();
}

export function listSessions(userId: string) {
  return q<{ id_hash: string; ip: string | null; user_agent: string | null; created_at: Date; last_seen_at: Date }>(
    "SELECT id_hash, ip, user_agent, created_at, last_seen_at FROM sessions WHERE user_id = $1 AND NOT mfa_pending AND expires_at > now() ORDER BY last_seen_at DESC",
    [userId]);
}
