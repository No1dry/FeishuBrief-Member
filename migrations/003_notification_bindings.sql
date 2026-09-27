CREATE TABLE notification_bindings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL CHECK(channel IN ('feishu','wechat')),
  target TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','unbound')),
  display_name TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  unbound_at INTEGER
);
CREATE UNIQUE INDEX notification_binding_user_active ON notification_bindings(user_id,channel) WHERE status='active';
CREATE UNIQUE INDEX notification_binding_target_active ON notification_bindings(channel,target_hash) WHERE status='active';
-- Also enforce destination uniqueness across MEMBER_SECRET rotation.
CREATE UNIQUE INDEX notification_binding_destination_active ON notification_bindings(channel,target) WHERE status='active';
CREATE TABLE notification_binding_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  channel TEXT NOT NULL CHECK(channel IN ('feishu','wechat')),
  status TEXT NOT NULL CHECK(status IN ('waiting','verifying','awaiting-confirmation','awaiting-code','complete','failed','expired')),
  proof_hash TEXT NOT NULL UNIQUE,
  target TEXT,
  display_name TEXT,
  otp_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  qr_url TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX notification_binding_challenges_user ON notification_binding_challenges(user_id,created_at);
CREATE TABLE notification_binding_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE TABLE notification_webhook_events (
  event_hash TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
