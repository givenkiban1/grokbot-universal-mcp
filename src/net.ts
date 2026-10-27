// Outbound HTTP to addresses users typed in (bot webhooks, reply notifications).
// Users are untrusted here: without these checks a webhook URL could make the server call its own database or
// the cloud metadata service. So: HTTPS only, no private/loopback/link-local targets (checked on the IP actually
// connected to, which also defeats DNS rebinding), no redirects, an optional host allowlist, and a timeout.
import { lookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch, type Response } from "undici";
import { config } from "./config.ts";

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["2001:db8::", 32],
] as const) blocked.addSubnet(net, bits, "ipv6");

export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPrivateAddress(mapped[1]);
  const family = isIP(ip);
  if (!family) return true;
  return blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

function hostAllowed(host: string): boolean {
  if (config.webhookHosts.length === 0) return true;
  return config.webhookHosts.some((p) => (p.startsWith("*.") ? host.endsWith(p.slice(1)) : host === p));
}

// Checks a URL a user wants to save. Returns an error message, or undefined when it's acceptable.
export function checkOutboundUrl(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return "Not a valid URL."; }
  if (url.username || url.password) return "Put credentials in the key field, not in the URL.";
  if (config.ALLOW_PRIVATE_WEBHOOKS) return url.protocol === "https:" || url.protocol === "http:" ? undefined : "Use an http(s) URL.";
  if (url.protocol !== "https:") return "The URL must start with https://.";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) && isPrivateAddress(host)) return "Private and local addresses are not allowed.";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return "Private and local addresses are not allowed.";
  }
  if (!hostAllowed(host)) return `This server only allows webhooks to: ${config.webhookHosts.join(", ")}.`;
  return undefined;
}

// Resolves the host and refuses to connect if any address it resolves to is private.
function guardedLookup(hostname: string, options: any, callback: (...args: any[]) => void) {
  lookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err);
    const bad = addresses.find((a) => isPrivateAddress(a.address));
    if (bad) return callback(Object.assign(new Error(`${hostname} resolves to a private address`), { code: "EPRIVATE" }));
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

const guardedAgent = new Agent({ connect: { lookup: guardedLookup as any }, headersTimeout: 15_000, bodyTimeout: 15_000 });
const plainAgent = new Agent({ headersTimeout: 15_000, bodyTimeout: 15_000 });

export async function safePost(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  const problem = checkOutboundUrl(url);
  if (problem) throw new Error(problem);
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "grok-bot-universal", ...headers },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    dispatcher: config.ALLOW_PRIVATE_WEBHOOKS ? plainAgent : guardedAgent,
  });
}
