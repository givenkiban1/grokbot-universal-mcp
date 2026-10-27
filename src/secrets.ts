// Stops credentials leaving in a message Claude sends to a bot. Claude is told never to include secrets; this is
// the backstop for when it does anyway (e.g. pasting a config file into a brief).

const PATTERNS: [string, RegExp][] = [
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a GrokBot/Cursor key", /\bcrsr_[A-Za-z0-9]{16,}/],
  ["an Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["an OpenAI-style API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["an xAI API key", /\bxai-[A-Za-z0-9]{32,}/],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ["an AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["a Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["a Google API key", /\bAIza[A-Za-z0-9_-]{35}\b/],
  ["a Stripe secret key", /\b[sr]k_live_[A-Za-z0-9]{20,}/],
  ["a token from this server", /\bgb[prafsio]_[A-Za-z0-9_-]{40,}/],
  ["a JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["a password in a connection string", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@/i],
];

// Returns a description of each kind of secret found. `known` holds exact values to look for, such as the
// user's own bot keys.
export function findSecrets(text: string, known: string[] = []): string[] {
  const found = PATTERNS.filter(([, re]) => re.test(text)).map(([what]) => what);
  if (known.some((k) => k.length >= 8 && text.includes(k))) found.push("one of your bot keys");
  return [...new Set(found)];
}
