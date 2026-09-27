CREATE TABLE notification_intents (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES users(id),
  edition_id TEXT NOT NULL REFERENCES content_editions(edition_id),
  report_date TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('feishu','wechat')),
  binding_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL,
  target TEXT NOT NULL,
  subscription_revision TEXT NOT NULL,
  edition_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  request_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('manual','daily','resend')),
  source_intent_id TEXT REFERENCES notification_intents(id),
  reason TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','sending','accepted','provider_confirmed','retryable_failed','permanent_failed','unknown','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  lease_until INTEGER,
  provider_message_id TEXT,
  error_code TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  unknown_reviewed_at INTEGER,
  unknown_reviewed_by TEXT REFERENCES users(id),
  unknown_review_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(member_id,request_id)
);
CREATE UNIQUE INDEX notification_daily_once ON notification_intents(member_id,report_date) WHERE mode='daily';
CREATE INDEX notification_due ON notification_intents(status,next_attempt_at,created_at);
CREATE TABLE notification_attempts (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES notification_intents(id),
  attempt_number INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  error_code TEXT,
  UNIQUE(intent_id,attempt_number)
);
CREATE TABLE notification_channel_slots (
  channel TEXT PRIMARY KEY CHECK(channel IN ('feishu','wechat')),
  next_send_at INTEGER NOT NULL
);
CREATE TABLE notification_schedules (
  member_id TEXT PRIMARY KEY REFERENCES users(id),
  revision TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  local_time TEXT NOT NULL,
  time_zone TEXT NOT NULL CHECK(time_zone='Asia/Shanghai'),
  updated_at INTEGER NOT NULL
);
CREATE TABLE notification_schedule_runs (
  member_id TEXT NOT NULL REFERENCES users(id),
  report_date TEXT NOT NULL,
  schedule_revision TEXT NOT NULL,
  edition_id TEXT REFERENCES content_editions(edition_id),
  intent_id TEXT REFERENCES notification_intents(id),
  status TEXT NOT NULL CHECK(status IN ('waiting','complete','empty','cancelled')),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(member_id,report_date)
);
CREATE TRIGGER notification_intent_immutable BEFORE UPDATE OF
  member_id,edition_id,report_date,channel,binding_id,binding_revision,target,subscription_revision,
  edition_hash,payload_json,payload_hash,request_id,mode,source_intent_id,reason,created_at ON notification_intents
BEGIN SELECT RAISE(ABORT,'immutable notification intent'); END;
