CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  password_hash     text NOT NULL,
  is_admin          boolean NOT NULL DEFAULT false,
  disabled_at       timestamptz,
  totp_secret_enc   text,             -- set while enrolling and once enabled
  totp_enabled      boolean NOT NULL DEFAULT false,
  totp_last_step    bigint,           -- last accepted TOTP step, to refuse replays
  notify_url        text,             -- optional HTTPS webhook called when a bot replies
  notify_secret_enc text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email ON users (lower(email));

CREATE TABLE sessions (
  id_hash      text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf         text NOT NULL,
  mfa_pending  boolean NOT NULL DEFAULT false,  -- password accepted, TOTP code still due
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  grants_admin boolean NOT NULL DEFAULT false,
  note         text NOT NULL DEFAULT '',
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  used_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  used_at      timestamptz,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               text NOT NULL,
  description        text NOT NULL DEFAULT '',
  use_for            text[] NOT NULL DEFAULT '{}',
  not_for            text[] NOT NULL DEFAULT '{}',
  projects           text[] NOT NULL DEFAULT '{}',
  webhook_url        text NOT NULL,
  webhook_key_enc    text NOT NULL,
  reply_token_hash   text UNIQUE,
  reply_token_prefix text,
  reply_epoch        integer NOT NULL DEFAULT 1,  -- bumped on rotation; invalidates every thread reply token
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE threads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id     uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  subject    text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX threads_user ON threads (user_id, updated_at DESC);

CREATE TABLE messages (
  id         bigserial PRIMARY KEY,
  thread_id  uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id     uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  direction  text NOT NULL CHECK (direction IN ('to_bot', 'from_bot')),
  body       text NOT NULL,
  sender     jsonb,            -- to_bot: the "from" block (app, project, about)
  status     integer,          -- to_bot: webhook HTTP status; 0 when there was no response
  run_id     text,
  error      text,
  state      text CHECK (state IN ('working', 'done', 'needs_input', 'failed')),  -- from_bot
  read_at    timestamptz,      -- from_bot: when Claude read it
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_thread ON messages (thread_id, id);
CREATE INDEX messages_unread ON messages (user_id, id) WHERE direction = 'from_bot' AND read_at IS NULL;

CREATE TABLE api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  prefix       text NOT NULL,
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_tokens_user ON api_tokens (user_id);

-- OAuth 2.1 authorization server for Claude's custom connectors (claude.ai, Desktop, mobile).
CREATE TABLE oauth_clients (
  client_id         text PRIMARY KEY,
  client_secret_enc text,
  metadata          jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_requests (    -- authorization requests waiting for the user to log in and approve
  id_hash    text PRIMARY KEY,
  client_id  text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  params     jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE oauth_codes (
  code_hash      text PRIMARY KEY,
  client_id      text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  scopes         text[] NOT NULL DEFAULT '{}',
  resource       text,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz
);

CREATE TABLE oauth_tokens (
  token_hash   text PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('access', 'refresh')),
  grant_id     uuid NOT NULL,   -- one per approval; revoking a connection revokes every token in it
  client_id    text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes       text[] NOT NULL DEFAULT '{}',
  resource     text,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens (grant_id);
CREATE INDEX oauth_tokens_user ON oauth_tokens (user_id);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  event      text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_user ON audit_log (user_id, id DESC);
CREATE INDEX audit_log_login_failures ON audit_log (event, created_at) WHERE event = 'login_failed';
