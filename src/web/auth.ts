// Sign-in, two-factor, sign-up (by invite) and the OAuth consent page.
import express, { type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { config } from "../config.ts";
import { one, q, tx } from "../db.ts";
import { hashToken, verifyPassword, verifyTotp } from "../crypto.ts";
import { audit } from "../audit.ts";
import { createUser, normalizeEmail, passwordProblem, totpState, useTotpStep, userForLogin, validEmail } from "../users.ts";
import { completeAuthorization, getPendingAuthorization } from "../oauth.ts";
import { html, layout } from "./html.ts";
import { currentSession, endSession, requireUser, startSession, upgradeSession, type SessionInfo } from "./session.ts";

const LOCKOUT_FAILURES = 8;
const LOCKOUT_WINDOW = "15 minutes";

// Only same-site paths, so ?next= can't bounce people to another site.
export function safeNext(v: unknown): string {
  return typeof v === "string" && /^\/(?![/\\])/.test(v) ? v : "/";
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, skipSuccessfulRequests: true,
  handler: (_req, res) => { res.status(429).send(layout({ title: "Slow down", body: html`<h1>Too many attempts</h1><p>Wait 15 minutes and try again.</p>`, narrow: true })); },
});

async function recentFailures(email: string): Promise<number> {
  const row = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE event = 'login_failed' AND detail->>'email' = $1 AND created_at > now() - interval '${LOCKOUT_WINDOW}'`,
    [email]);
  return row?.n ?? 0;
}

function loginPage(res: Response, opts: { next: string; email?: string; error?: string; notice?: string }) {
  res.send(layout({
    title: "Sign in", narrow: true, error: opts.error, notice: opts.notice,
    body: html`<h1>Sign in</h1>
      <form method="post" action="/login" class="stack">
        <input type="hidden" name="next" value="${opts.next}">
        <label>Email <input type="email" name="email" value="${opts.email ?? ""}" autocomplete="username" required autofocus></label>
        <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
        <button>Sign in</button>
      </form>
      ${config.SIGNUP === "open" ? html`<p class="muted">No account? <a href="/signup">Sign up</a></p>` : ""}`,
  }));
}

function signupPage(res: Response, opts: { invite: string; email?: string; error?: string }) {
  res.send(layout({
    title: "Create account", narrow: true, error: opts.error,
    body: html`<h1>Create your account</h1>
      <form method="post" action="/signup" class="stack">
        <input type="hidden" name="invite" value="${opts.invite}">
        <label>Email <input type="email" name="email" value="${opts.email ?? ""}" autocomplete="username" required autofocus></label>
        <label>Password <small class="muted">at least 12 characters; a passphrase works well</small>
          <input type="password" name="password" autocomplete="new-password" minlength="12" required></label>
        <label>Password again <input type="password" name="password2" autocomplete="new-password" minlength="12" required></label>
        <button>Create account</button>
      </form>`,
  }));
}

export function authRouter(): express.Router {
  const r = express.Router();

  r.get("/login", (req, res) => {
    if (currentSession(res)) return res.redirect(303, safeNext(req.query.next));
    loginPage(res, { next: safeNext(req.query.next), notice: req.query.signed_up ? "Account created. Sign in to continue." : undefined });
  });

  r.post("/login", loginLimiter, async (req, res) => {
    const email = normalizeEmail(String(req.body.email ?? ""));
    const password = String(req.body.password ?? "");
    const next = safeNext(req.body.next);
    const fail = async (userId: string | null, reason: string) => {
      await audit(userId, "login_failed", { email, reason }, req.ip);
      res.status(401);
      loginPage(res, { next, email, error: "Wrong email or password." });
    };
    if (!email || !password || password.length > 256) return fail(null, "missing");
    if (await recentFailures(email) >= LOCKOUT_FAILURES) {
      await audit(null, "login_locked", { email }, req.ip);
      res.status(429);
      return loginPage(res, { next, email, error: "Too many failed attempts for this account. Wait 15 minutes and try again." });
    }
    const user = await userForLogin(email);
    const ok = await verifyPassword(password, user?.password_hash);
    if (!user || !ok) return fail(user?.id ?? null, "password");
    if (user.disabled_at) return fail(user.id, "disabled");

    if (user.totp_enabled) {
      await startSession(req, res, user.id, true);
      return res.redirect(303, `/login/2fa?next=${encodeURIComponent(next)}`);
    }
    await startSession(req, res, user.id, false);
    await audit(user.id, "login", {}, req.ip);
    res.redirect(303, next);
  });

  const pending = (res: Response) => {
    const s = res.locals.session as SessionInfo | undefined;
    return s?.mfaPending ? s : undefined;
  };

  r.get("/login/2fa", (req, res) => {
    if (!pending(res)) return res.redirect(303, "/login");
    res.send(layout({
      title: "Two-factor", narrow: true,
      body: html`<h1>Enter your code</h1>
        <form method="post" action="/login/2fa" class="stack">
          <input type="hidden" name="_csrf" value="${pending(res)!.csrf}">
          <input type="hidden" name="next" value="${safeNext(req.query.next)}">
          <label>6-digit code from your authenticator app
            <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label>
          <button>Verify</button>
        </form>`,
    }));
  });

  r.post("/login/2fa", loginLimiter, async (req, res) => {
    const s = pending(res);
    if (!s) return res.redirect(303, "/login");
    const totp = await totpState(s.user.id);
    const step = totp?.enabled ? verifyTotp(totp.secret, String(req.body.code ?? "").trim(), totp.lastStep) : undefined;
    if (step === undefined || !(await useTotpStep(s.user.id, step))) {
      await audit(s.user.id, "login_failed", { email: s.user.email, reason: "totp" }, req.ip);
      if (await recentFailures(s.user.email) >= LOCKOUT_FAILURES) {
        await endSession(req, res);
        return res.redirect(303, "/login");
      }
      res.status(401).send(layout({
        title: "Two-factor", narrow: true, error: "That code didn't work. Codes change every 30 seconds.",
        body: html`<h1>Enter your code</h1>
          <form method="post" action="/login/2fa" class="stack">
            <input type="hidden" name="_csrf" value="${s.csrf}">
            <input type="hidden" name="next" value="${safeNext(req.body.next)}">
            <label>6-digit code <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label>
            <button>Verify</button>
          </form>`,
      }));
      return;
    }
    await upgradeSession(req, res, s.user.id);
    await audit(s.user.id, "login", { mfa: true }, req.ip);
    res.redirect(303, safeNext(req.body.next));
  });

  r.post("/logout", async (req, res) => {
    await endSession(req, res);
    res.redirect(303, "/login");
  });

  r.get("/signup", (req, res) => {
    const invite = String(req.query.invite ?? "");
    if (config.SIGNUP !== "open" && !invite) {
      res.status(403).send(layout({ title: "Invite only", narrow: true, body: html`<h1>Invite only</h1><p>Ask an admin of this server for an invite link.</p>` }));
      return;
    }
    signupPage(res, { invite });
  });

  r.post("/signup", loginLimiter, async (req, res) => {
    const invite = String(req.body.invite ?? "");
    const email = normalizeEmail(String(req.body.email ?? ""));
    const password = String(req.body.password ?? "");
    const again = (error: string) => { res.status(400); signupPage(res, { invite, email, error }); };
    if (!validEmail(email)) return again("Enter a valid email address.");
    const problem = passwordProblem(password);
    if (problem) return again(problem);
    if (password !== req.body.password2) return again("The passwords don't match.");
    if (config.SIGNUP !== "open" && !invite) return again("This server needs an invite link to sign up.");

    try {
      const user = await tx(async (db) => {
        let admin = false;
        if (invite) {
          const inv = await one<{ id: string; grants_admin: boolean }>(
            "UPDATE invites SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING id, grants_admin",
            [hashToken(invite)], db);
          if (!inv) throw new Error("invite");
          admin = inv.grants_admin;
          const u = await createUser(email, password, admin, db);
          await q("UPDATE invites SET used_by = $2 WHERE id = $1", [inv.id, u.id], db);
          return u;
        }
        return createUser(email, password, admin, db);
      });
      await audit(user.id, "signup", { admin: user.is_admin }, req.ip);
      res.redirect(303, "/login?signed_up=1");
    } catch (err) {
      if ((err as Error).message === "invite") return again("This invite link is invalid, expired or already used.");
      if ((err as any).code === "23505") return again("An account with this email already exists.");
      throw err;
    }
  });

  // ---- OAuth consent (reached from /authorize) ----

  r.get("/oauth/consent", requireUser, async (req, res) => {
    const s = currentSession(res)!;
    const id = String(req.query.request ?? "");
    const p = await getPendingAuthorization(id);
    if (!p) {
      res.status(400).send(layout({ title: "Expired", user: s.user, csrf: s.csrf, narrow: true,
        body: html`<h1>This request expired</h1><p>Start connecting again from the app.</p>` }));
      return;
    }
    const target = new URL(p.redirect_uri);
    // Let this one form redirect back to the app (form-action also governs where a form's redirect may go).
    res.setHeader("Content-Security-Policy", res.getHeader("Content-Security-Policy")!.toString()
      .replace("form-action 'self'", `form-action 'self' ${target.origin}`));
    res.send(layout({
      title: "Connect app", user: s.user, csrf: s.csrf, narrow: true,
      body: html`<h1>Connect ${p.client_name}?</h1>
        <p><strong>${p.client_name}</strong> wants to use your GrokBot account <strong>${s.user.email}</strong>.</p>
        <p>It will be able to:</p>
        <ul>
          <li>see your bots and what each is for</li>
          <li>send messages to your bots (Claude asks you before every send)</li>
          <li>read your bots' replies and your threads</li>
        </ul>
        <p class="muted small">It can't see your webhook keys, password or other settings. After approving you'll be sent back to
          <code>${target.origin}</code>. You can disconnect it any time under Connect Claude.</p>
        <form method="post" action="/oauth/consent" class="row">
          <input type="hidden" name="_csrf" value="${s.csrf}">
          <input type="hidden" name="request" value="${id}">
          <button name="decision" value="approve">Approve</button>
          <button name="decision" value="deny" class="secondary">Deny</button>
        </form>`,
    }));
  });

  r.post("/oauth/consent", requireUser, async (req: Request, res) => {
    const s = currentSession(res)!;
    const approved = req.body.decision === "approve";
    const p = await getPendingAuthorization(String(req.body.request ?? ""));
    const target = await completeAuthorization(String(req.body.request ?? ""), s.user.id, approved);
    if (!target) return res.status(400).send("This request expired. Start connecting again from the app.");
    await audit(s.user.id, approved ? "oauth_approved" : "oauth_denied", { client: p?.client_name, redirect: p && new URL(p.redirect_uri).origin }, req.ip);
    res.redirect(303, target);
  });

  return r;
}
