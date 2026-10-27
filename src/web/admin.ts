// Admin: users and invite links.
import express from "express";
import { config } from "../config.ts";
import { q } from "../db.ts";
import { audit } from "../audit.ts";
import { hashToken, newToken } from "../crypto.ts";
import { listUsers, setDisabled } from "../users.ts";
import { html, layout, secretBox, when } from "./html.ts";
import { currentSession, requireAdmin, requireUser } from "./session.ts";

export async function createInvite(createdBy: string | null, opts: { admin: boolean; days: number; note: string }): Promise<string> {
  const token = newToken("gbi");
  await q("INSERT INTO invites (token_hash, grants_admin, note, created_by, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))",
    [hashToken(token), opts.admin, opts.note.slice(0, 200), createdBy, opts.days]);
  return `${config.PUBLIC_URL}/signup?invite=${encodeURIComponent(token)}`;
}

export function adminRouter(): express.Router {
  const r = express.Router();
  r.use("/admin", requireUser, requireAdmin);

  async function adminPage(res: express.Response, opts: { link?: string; error?: string } = {}) {
    const s = currentSession(res)!;
    const [users, invites] = await Promise.all([
      listUsers(),
      q<{ id: string; note: string; grants_admin: boolean; expires_at: Date; created_at: Date }>(
        "SELECT id, note, grants_admin, expires_at, created_at FROM invites WHERE used_at IS NULL AND expires_at > now() ORDER BY created_at DESC"),
    ]);
    res.send(layout({
      title: "Admin", user: s.user, csrf: s.csrf, error: opts.error,
      body: html`<h1>Admin</h1>
        <p class="muted">Sign-up mode: <strong>${config.SIGNUP}</strong> (set SIGNUP in the server's environment).</p>
        ${opts.link ? secretBox("Invite link.", opts.link, "Send it to the person privately. It works once.") : ""}
        <section><h2>Invite someone</h2>
          <form method="post" action="/admin/invites" class="row">
            <input type="hidden" name="_csrf" value="${s.csrf}">
            <input name="note" placeholder="Who it's for (note)" maxlength="200">
            <select name="days"><option value="7">expires in 7 days</option><option value="1">1 day</option><option value="30">30 days</option></select>
            <label class="check"><input type="checkbox" name="admin" value="1"> admin</label>
            <button>Create invite</button>
          </form>
          ${invites.length ? html`<h3>Open invites</h3><table><thead><tr><th>Note</th><th>Admin</th><th>Created</th><th>Expires</th><th></th></tr></thead>
            <tbody>${invites.map((i) => html`<tr><td>${i.note}</td><td>${i.grants_admin ? "yes" : ""}</td><td class="small">${when(i.created_at)}</td>
              <td class="small">${when(i.expires_at)}</td><td><form method="post" action="/admin/invites/${i.id}/revoke">
              <input type="hidden" name="_csrf" value="${s.csrf}"><button class="secondary small">Revoke</button></form></td></tr>`)}</tbody></table>` : ""}
        </section>
        <section><h2>Users</h2>
          <table><thead><tr><th>Email</th><th>Role</th><th>2FA</th><th>Bots</th><th>Joined</th><th>Status</th><th></th></tr></thead>
          <tbody>${users.map((u) => html`<tr><td>${u.email}</td><td>${u.is_admin ? "admin" : "user"}</td><td>${u.totp_enabled ? "on" : "off"}</td>
            <td>${u.bots}</td><td class="small">${when(u.created_at)}</td><td>${u.disabled_at ? "disabled" : "active"}</td>
            <td>${u.id === s.user.id ? "" : html`<form method="post" action="/admin/users/${u.id}/${u.disabled_at ? "enable" : "disable"}">
              <input type="hidden" name="_csrf" value="${s.csrf}">
              <button class="secondary small" ${u.disabled_at ? "" : html`data-confirm="Disable ${u.email}? They are signed out and their tokens revoked."`}>${u.disabled_at ? "Enable" : "Disable"}</button></form>`}</td></tr>`)}</tbody></table>
        </section>`,
    }));
  }

  r.get("/admin", (_req, res) => adminPage(res));

  r.post("/admin/invites", async (req, res) => {
    const s = currentSession(res)!;
    const days = [1, 7, 30].includes(Number(req.body.days)) ? Number(req.body.days) : 7;
    const admin = req.body.admin === "1";
    const link = await createInvite(s.user.id, { admin, days, note: String(req.body.note ?? "") });
    await audit(s.user.id, "invite_created", { admin, days, note: String(req.body.note ?? "").slice(0, 200) }, req.ip);
    await adminPage(res, { link });
  });

  r.post("/admin/invites/:id/revoke", async (req, res) => {
    await q("UPDATE invites SET expires_at = now() WHERE id::text = $1 AND used_at IS NULL", [String(req.params.id)]);
    res.redirect(303, "/admin");
  });

  r.post("/admin/users/:id/:action", async (req, res) => {
    const s = currentSession(res)!;
    const id = String(req.params.id);
    if (id === s.user.id || !["enable", "disable"].includes(String(req.params.action))) return res.redirect(303, "/admin");
    const exists = (await q("SELECT 1 FROM users WHERE id::text = $1", [id])).length > 0;
    if (!exists) return res.redirect(303, "/admin");
    await setDisabled(id, req.params.action === "disable");
    await audit(s.user.id, `user_${req.params.action}d`, { user: id }, req.ip);
    await audit(id, `account_${req.params.action}d_by_admin`, {}, req.ip);
    res.redirect(303, "/admin");
  });

  return r;
}
