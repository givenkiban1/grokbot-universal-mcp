// Every secret the server issues or stores goes through here.
// - Tokens we issue (API, reply, OAuth, sessions) are random and stored only as SHA-256 hashes.
// - Secrets we must use later (bot webhook keys, TOTP seeds, notify secrets) are AES-256-GCM encrypted, bound to
//   their owner with associated data so a ciphertext can't be moved to another row.
// - Passwords use scrypt.
import {
  createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scrypt as scryptCb, timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.ts";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

const master = Buffer.from(config.ENCRYPTION_KEY, "base64");
const subkey = (purpose: string) => Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `grokbot:${purpose}`, 32));
const ENC_KEY = subkey("encrypt:v1");
const MAC_KEY = subkey("thread-token:v1");

// Token prefixes make leaked tokens easy to recognise (and to block in outgoing messages).
export type TokenKind = "gbp" | "gbr" | "gba" | "gbf" | "gbs" | "gbi" | "gbo";
// gbp personal API token · gbr bot reply token · gba OAuth access · gbf OAuth refresh · gbs browser session
// gbi invite · gbo OAuth code/pending request

export function newToken(kind: TokenKind): string {
  return `${kind}_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// First characters, safe to show in the dashboard so people can tell tokens apart.
export function tokenPrefix(token: string): string {
  return token.slice(0, 10) + "…";
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function encrypt(plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ENC_KEY, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url")}`;
}

export function decrypt(sealed: string, aad: string): string {
  const [version, data] = sealed.split(".");
  if (version !== "v1" || !data) throw new Error("unsupported ciphertext");
  const buf = Buffer.from(data, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", ENC_KEY, buf.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

// ---- Passwords ----

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize("NFKC"), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

// Compared against when the email is unknown, so a miss costs as long as a hit.
const DUMMY_HASH = await hashPassword(randomBytes(16).toString("hex"));

export async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = (stored ?? DUMMY_HASH).split("$");
  if (alg !== "scrypt") return false;
  const want = Buffer.from(hash, "base64url");
  const got = await scrypt(password.normalize("NFKC"), Buffer.from(salt, "base64url"), want.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(got, want) && stored !== undefined;
}

// ---- Thread reply tokens ----
// Sent to the bot with each message so it can answer on that one thread, with nothing to configure in the bot.
// Signed, not stored. Rotating the bot's reply token bumps its epoch, which invalidates all of these at once.

export interface ThreadClaim { thread: string; bot: string; epoch: number; exp: number }

export function signThreadToken(claim: ThreadClaim): string {
  const body = Buffer.from(JSON.stringify([claim.thread, claim.bot, claim.epoch, claim.exp])).toString("base64url");
  return `gbt_${body}.${createHmac("sha256", MAC_KEY).update(body).digest("base64url")}`;
}

export function verifyThreadToken(token: string): ThreadClaim | undefined {
  const m = /^gbt_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m) return undefined;
  if (!safeEqual(m[2], createHmac("sha256", MAC_KEY).update(m[1]).digest("base64url"))) return undefined;
  try {
    const [thread, bot, epoch, exp] = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
    if (typeof exp !== "number" || exp < Date.now() / 1000) return undefined;
    return { thread, bot, epoch, exp };
  } catch {
    return undefined;
  }
}

// ---- TOTP (RFC 6238: SHA-1, 6 digits, 30 s) ----

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newTotpSecret(): string {
  let bits = "";
  for (const byte of randomBytes(20)) bits += byte.toString(2).padStart(8, "0");
  return bits.match(/.{5}/g)!.map((b) => B32[parseInt(b, 2)]).join("");
}

function base32Decode(s: string): Buffer {
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error("bad base32");
    bits += i.toString(2).padStart(5, "0");
  }
  return Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
}

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const off = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

// Returns the matching time step (±1 for clock drift), so the caller can refuse a replay of the same step.
export function verifyTotp(secret: string, code: string, lastStep: number | null): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const now = Math.floor(Date.now() / 30_000);
  for (const step of [now - 1, now, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    if (safeEqual(totpCode(secret, step), code)) return step;
  }
  return undefined;
}
