// OAuth 2.1 authorization server, so Claude's custom connectors (claude.ai, Desktop, mobile) can connect with a
// login instead of a pasted token. The MCP SDK provides the endpoints (metadata, registration, authorize, token,
// revoke) and PKCE checks; this file stores everything in Postgres and sends the user through our own login and
// consent page.
//
// Flow: /authorize → we store the request and redirect to /oauth/consent (logging in first if needed) → the user
// approves → we issue a one-time code bound to the PKCE challenge and redirect URI → /token swaps it for an access
// token (1 h) and a refresh token (30 days, rotated on every use, reuse revokes the whole grant).
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError, InvalidGrantError, InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { config } from "./config.ts";
import { one, q, tx } from "./db.ts";
import { decrypt, encrypt, hashToken, newToken } from "./crypto.ts";
import { userForApiToken } from "./tokens.ts";

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_S = 5 * 60;
const REQUEST_TTL_S = 15 * 60;
export const SCOPE = "grokbot";

function redirectAllowed(uri: string): boolean {
  let url: URL;
  try { url = new URL(uri); } catch { return false; }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return false;
  return config.oauthRedirectHosts.some((h) => host === h || (h !== "localhost" && h !== "127.0.0.1" && host.endsWith("." + h)));
}

const clientAad = (clientId: string) => `oauth-client:${clientId}`;

const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId) {
    const row = await one<{ client_id: string; client_secret_enc: string | null; metadata: any }>(
      "SELECT client_id, client_secret_enc, metadata FROM oauth_clients WHERE client_id = $1", [clientId]);
    if (!row) return undefined;
    // The SDK compares client_secret itself, so hand it the decrypted value.
    return {
      ...row.metadata,
      client_id: row.client_id,
      ...(row.client_secret_enc ? { client_secret: decrypt(row.client_secret_enc, clientAad(row.client_id)) } : {}),
    };
  },
  async registerClient(client) {
    const bad = client.redirect_uris.find((u) => !redirectAllowed(String(u)));
    if (bad) throw new InvalidClientMetadataError(`redirect_uri ${bad} is not allowed on this server`);
    const client_id = randomUUID();
    const { client_secret, ...metadata } = client as OAuthClientInformationFull;
    const full = { ...metadata, client_id, client_id_issued_at: Math.floor(Date.now() / 1000) };
    await q("INSERT INTO oauth_clients (client_id, client_secret_enc, metadata) VALUES ($1, $2, $3)",
      [client_id, client_secret ? encrypt(client_secret, clientAad(client_id)) : null, full]);
    return { ...full, ...(client_secret ? { client_secret } : {}) } as OAuthClientInformationFull;
  },
};

export interface PendingAuthorization {
  client_id: string;
  client_name: string;
  redirect_uri: string;
  state?: string;
  scopes: string[];
  code_challenge: string;
  resource?: string;
}

export async function getPendingAuthorization(id: string): Promise<PendingAuthorization | undefined> {
  const row = await one<{ params: PendingAuthorization }>(
    "SELECT params FROM oauth_requests WHERE id_hash = $1 AND expires_at > now()", [hashToken(id)]);
  return row?.params;
}

// Called from the consent page. Returns where to send the browser.
export async function completeAuthorization(id: string, userId: string, approved: boolean): Promise<string | undefined> {
  const row = await one<{ params: PendingAuthorization }>(
    "DELETE FROM oauth_requests WHERE id_hash = $1 AND expires_at > now() RETURNING params", [hashToken(id)]);
  if (!row) return undefined;
  const p = row.params;
  const target = new URL(p.redirect_uri);
  if (p.state !== undefined) target.searchParams.set("state", p.state);
  if (!approved) {
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("error_description", "The user declined the connection");
    return target.href;
  }
  const code = newToken("gbo");
  await q(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
    [hashToken(code), p.client_id, userId, p.redirect_uri, p.code_challenge, p.scopes, p.resource ?? null, CODE_TTL_S],
  );
  target.searchParams.set("code", code);
  return target.href;
}

async function issueTokens(db: any, grantId: string, clientId: string, userId: string, scopes: string[], resource: string | null): Promise<OAuthTokens> {
  const access = newToken("gba");
  const refresh = newToken("gbf");
  const insert = `INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, user_id, scopes, resource, expires_at)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`;
  await q(insert, [hashToken(access), "access", grantId, clientId, userId, scopes, resource, ACCESS_TTL_S], db);
  await q(insert, [hashToken(refresh), "refresh", grantId, clientId, userId, scopes, resource, REFRESH_TTL_S], db);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopes.join(" ") };
}

async function rotateRefreshToken(
  client: OAuthClientInformationFull, refreshToken: string, resource: URL | undefined, onReuse: (grantId: string) => void,
): Promise<OAuthTokens> {
  return tx(async (db) => {
    const row = await one<{ grant_id: string; user_id: string; scopes: string[]; resource: string | null; revoked_at: Date | null; expires_at: Date }>(
      `SELECT t.grant_id, t.user_id, t.scopes, t.resource, t.revoked_at, t.expires_at FROM oauth_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = $1 AND t.kind = 'refresh' AND t.client_id = $2 AND u.disabled_at IS NULL FOR UPDATE OF t`,
      [hashToken(refreshToken), client.client_id], db);
    if (!row) throw new InvalidGrantError("Invalid refresh token");
    if (row.revoked_at) {
      // A rotated-out refresh token came back: someone has a copy. The caller kills the whole grant.
      onReuse(row.grant_id);
      throw new InvalidGrantError("Refresh token was already used");
    }
    if (row.expires_at < new Date()) throw new InvalidGrantError("Refresh token expired");
    if (resource && row.resource && resource.href !== row.resource) throw new InvalidGrantError("resource does not match");
    await q("UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash = $1", [hashToken(refreshToken)], db);
    return issueTokens(db, row.grant_id, client.client_id, row.user_id, row.scopes, row.resource);
  });
}

export const oauthProvider: OAuthServerProvider = {
  clientsStore,

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const id = newToken("gbo");
    const pending: PendingAuthorization = {
      client_id: client.client_id,
      client_name: String(client.client_name ?? "An unnamed app").slice(0, 100),
      redirect_uri: params.redirectUri,
      state: params.state,
      scopes: [SCOPE],
      code_challenge: params.codeChallenge,
      resource: params.resource?.href,
    };
    await q("DELETE FROM oauth_requests WHERE expires_at < now()");
    await q("INSERT INTO oauth_requests (id_hash, client_id, params, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))",
      [hashToken(id), client.client_id, pending, REQUEST_TTL_S]);
    res.redirect(302, `/oauth/consent?request=${encodeURIComponent(id)}`);
  },

  async challengeForAuthorizationCode(client, code) {
    const row = await one<{ code_challenge: string }>(
      "SELECT code_challenge FROM oauth_codes WHERE code_hash = $1 AND client_id = $2 AND used_at IS NULL AND expires_at > now()",
      [hashToken(code), client.client_id]);
    if (!row) throw new InvalidGrantError("Invalid or expired authorization code");
    return row.code_challenge;
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    return tx(async (db) => {
      // Single use: the used_at IS NULL condition makes a second (or concurrent) exchange of the same code fail.
      const row = await one<{ user_id: string; redirect_uri: string; scopes: string[]; resource: string | null }>(
        `UPDATE oauth_codes SET used_at = now() WHERE code_hash = $1 AND client_id = $2 AND expires_at > now() AND used_at IS NULL
         RETURNING user_id, redirect_uri, scopes, resource`,
        [hashToken(code), client.client_id], db);
      if (!row) throw new InvalidGrantError("Invalid or expired authorization code");
      if (redirectUri !== undefined && redirectUri !== row.redirect_uri) throw new InvalidGrantError("redirect_uri does not match");
      if (resource && row.resource && resource.href !== row.resource) throw new InvalidGrantError("resource does not match");
      return issueTokens(db, randomUUID(), client.client_id, row.user_id, row.scopes, row.resource ?? config.mcpUrl);
    });
  },

  async exchangeRefreshToken(client, refreshToken, _scopes, resource) {
    let reusedGrant: string | undefined;
    try {
      return await rotateRefreshToken(client, refreshToken, resource, (grant) => { reusedGrant = grant; });
    } finally {
      // Outside the transaction, which rolls back when the exchange fails.
      if (reusedGrant) await q("UPDATE oauth_tokens SET revoked_at = now() WHERE grant_id = $1 AND revoked_at IS NULL", [reusedGrant]);
    }
  },



  // Accepts both connector access tokens and personal API tokens, so /mcp has one auth path.
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token.startsWith("gbp_")) {
      const t = await userForApiToken(token);
      if (!t) throw new InvalidTokenError("Invalid or revoked API token");
      return {
        token, clientId: `api-token:${t.token_id}`, scopes: [SCOPE], resource: new URL(config.mcpUrl),
        expiresAt: t.expires_at ? Math.floor(t.expires_at.getTime() / 1000) : undefined,
        extra: { userId: t.user_id },
      };
    }
    if (!token.startsWith("gba_")) throw new InvalidTokenError("Unknown token type");
    const row = await one<{ client_id: string; user_id: string; scopes: string[]; resource: string | null; expires_at: Date }>(
      `SELECT t.client_id, t.user_id, t.scopes, t.resource, t.expires_at FROM oauth_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > now() AND u.disabled_at IS NULL`,
      [hashToken(token)]);
    if (!row) throw new InvalidTokenError("Invalid or expired access token");
    q("UPDATE oauth_tokens SET last_used_at = now() WHERE token_hash = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')",
      [hashToken(token)]).catch(() => {});
    return {
      token, clientId: row.client_id, scopes: row.scopes, resource: new URL(row.resource ?? config.mcpUrl),
      expiresAt: Math.floor(row.expires_at.getTime() / 1000), extra: { userId: row.user_id },
    };
  },

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    const row = await one<{ grant_id: string }>(
      "SELECT grant_id FROM oauth_tokens WHERE token_hash = $1 AND client_id = $2", [hashToken(request.token), client.client_id]);
    if (row) await q("UPDATE oauth_tokens SET revoked_at = now() WHERE grant_id = $1 AND revoked_at IS NULL", [row.grant_id]);
  },
};

// ---- Dashboard: connected apps ----

export interface Connection { grant_id: string; client_name: string; redirect: string; created_at: Date; last_used_at: Date | null }

export function listConnections(userId: string): Promise<Connection[]> {
  return q(
    `SELECT t.grant_id, coalesce(c.metadata->>'client_name', 'Unnamed app') AS client_name,
       coalesce(c.metadata->'redirect_uris'->>0, '') AS redirect, min(t.created_at) AS created_at, max(t.last_used_at) AS last_used_at
     FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
     WHERE t.user_id = $1 AND t.kind = 'refresh' AND t.revoked_at IS NULL AND t.expires_at > now()
     GROUP BY t.grant_id, c.metadata ORDER BY created_at DESC`,
    [userId]);
}

export async function revokeConnection(userId: string, grantId: string): Promise<void> {
  await q("UPDATE oauth_tokens SET revoked_at = now() WHERE user_id = $1 AND grant_id::text = $2 AND revoked_at IS NULL", [userId, grantId]);
}
