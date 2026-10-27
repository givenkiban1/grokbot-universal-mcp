// Server-rendered HTML with escaping by default: every interpolated value is escaped unless it's already Html.
// No inline scripts or styles, so the Content-Security-Policy can forbid them.

export class Html {
  readonly value: string;
  constructor(value: string) { this.value = value; }
  toString() { return this.value; }
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v instanceof Date) return escape(v.toISOString());
  return escape(String(v));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Html(out);
}

export const raw = (s: string) => new Html(s);

export function when(d: Date | null | undefined): Html {
  if (!d) return html`<span class="muted">never</span>`;
  return html`<time datetime="${d.toISOString()}">${d.toISOString().replace("T", " ").slice(0, 16)} UTC</time>`;
}

export interface PageUser { email: string; is_admin: boolean }

export function layout(opts: { title: string; user?: PageUser; csrf?: string; body: Html; notice?: string; error?: string; narrow?: boolean }): string {
  const nav = opts.user
    ? html`<nav>
        <a class="brand" href="/">GrokBot</a>
        <a href="/bots">Bots</a>
        <a href="/threads">Threads</a>
        <a href="/connect">Connect Claude</a>
        <a href="/settings">Settings</a>
        <a href="/activity">Activity</a>
        ${opts.user.is_admin ? html`<a href="/admin">Admin</a>` : ""}
        <span class="spacer"></span>
        <span class="muted small">${opts.user.email}</span>
        <form method="post" action="/logout" class="inline">
          <input type="hidden" name="_csrf" value="${opts.csrf ?? ""}">
          <button class="link">Sign out</button>
        </form>
      </nav>`
    : html`<nav><a class="brand" href="/">GrokBot</a></nav>`;
  return "<!doctype html>" + html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${opts.title} · GrokBot</title>
<link rel="stylesheet" href="/static/style.css">
<script src="/static/app.js" defer></script>
</head>
<body>
${nav}
<main class="${opts.narrow ? "narrow" : ""}">
${opts.notice ? html`<p class="notice">${opts.notice}</p>` : ""}
${opts.error ? html`<p class="error" role="alert">${opts.error}</p>` : ""}
${opts.body}
</main>
</body>
</html>`.value;
}

// Shows a secret once, with a copy button.
export function secretBox(label: string, value: string, note: string): Html {
  return html`<div class="secret">
    <p><strong>${label}</strong> ${note}</p>
    <div class="copyrow"><code id="secret-value">${value}</code><button type="button" data-copy="secret-value">Copy</button></div>
  </div>`;
}
